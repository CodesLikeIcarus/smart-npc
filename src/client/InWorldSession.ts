import { Session } from "../base/Session.js";
import { ConnectionState, PersonaInfo, MapModelClass, geoPosToCartesian } from "../types/index.js";
import type { TeleportDestination } from "../types/index.js";
import { PersonaPuppet } from "../avatar/PersonaPuppet.js";
import type { PersonaSession } from "../client/PersonaSession.js";
import { ProximityAudioManager } from "../audio/ProximityAudioManager.js";
import { AudioVisualizer } from "../client/AudioVisualizer.js";
import { AudioFrameCapture } from "../audio/AudioFrameCapture.js";
import { STTService, type TranscriptEvent } from "../ai/STTService.js";
import { STTDrainLoop } from "../ai/STTDrainLoop.js";
import { TTSService } from "../ai/TTSService.js";
import { LLMService } from "../ai/LLMService.js";
import { ScenarioCoachEngine, SETUP_COMPLETE_MARKER } from "../persona/ScenarioCoachEngine.js";
import type { PersonaDefinition } from "../persona/PersonaDefinition.js";
import { OutboundAudioEncoder, type AudioSlice, SAMPLES_PER_SLICE } from "../audio/OutboundAudioEncoder.js";
import { RealtimeService } from "../ai/RealtimeService.js";
import { DeepgramConfig, OpenAIConfig } from "../config.js";

export class InWorldSession extends Session {
  private personaInfo: PersonaInfo;
  private puppet: PersonaPuppet | null = null;
  readonly personaSession: PersonaSession;
  private audioManager: ProximityAudioManager | null = null;
  private visualizer: AudioVisualizer | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private pTime: any = null;

  // ─── STT pipeline ───────────────────────────────────────────────────────
  private sttCapture: AudioFrameCapture | null = null;
  private sttService: STTService | null = null;
  private sttDrainLoop: STTDrainLoop | null = null;

  // ─── TTS pipeline ───────────────────────────────────────────────────────
  private ttsService: TTSService | null = null;
  private audioEncoder: OutboundAudioEncoder | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private lastPState: any = null;
  private lastCelestialId: string | null = null;

  // ─── Echo mode (Phase 3) ───────────────────────────────────────────────
  private _echoMode = false;
  private _ttsSpeaking = false;
  private _echoSuppressTimer: ReturnType<typeof setTimeout> | null = null;

  // ─── AI mode (Phase 4) ────────────────────────────────────────────────
  private _aiMode = false;
  private llmService: LLMService | null = null;
  private _llmDone = false;

  // ─── Persona engine (Phase 5/6) ───────────────────────────────────────
  private _personaEngine = new ScenarioCoachEngine();

  // ─── Accumulation window (smart pause detection) ──────────────────────
  private _accumulatedText: string[] = [];
  private _accumulationTimer: ReturnType<typeof setTimeout> | null = null;

  // ─── Realtime API (unified STT+LLM+TTS) ──────────────────────────────
  realtimeService: RealtimeService | null = null;
  private _realtimeMode = false;
  private _realtimeDrainTimer: ReturnType<typeof setInterval> | null = null;
  private _realtimeCapture: AudioFrameCapture | null = null;

  onTranscript: ((event: TranscriptEvent) => void) | null = null;
  onEchoFlushed: (() => void) | null = null;
  onAIResponse: ((sentence: string) => void) | null = null;

  constructor(personaInfo: PersonaInfo, personaSession: PersonaSession) {
    super();
    this.personaInfo = personaInfo;
    this.personaSession = personaSession;
  }

  get avatar(): PersonaPuppet | null {
    return this.puppet;
  }

  /** Returns the active ProximityAudioManager, or null before connect(). */
  get audio(): ProximityAudioManager | null {
    return this.audioManager;
  }

  async connect(): Promise<void> {
    this.setState(ConnectionState.EnteringWorld);

    this.puppet = new PersonaPuppet(this.personaInfo, this);
    await this.puppet.spawn();

    // Start proximity audio: receives encoded audio from the server and plays
    // it back through the local Web Audio API (AudioContext).
    const pLnG = this.personaSession.pLnGClient;
    if (pLnG) {
      this.audioManager = new ProximityAudioManager(pLnG);
      this.audioManager.start();

      // Attach the waveform visualizer if the container element is present
      const vizContainer = document.getElementById('audio-visualizer-container');
      if (vizContainer) {
        this.visualizer = new AudioVisualizer(vizContainer);
        this.visualizer.attachAudioSource(this.audioManager);
      }
    } else {
      console.warn('[InWorldSession] pLnGClient unavailable; proximity audio disabled');
    }

    // Open the Time model and attach for periodic tick notifications.
    // pTime sends onTick() callbacks on every internal tick, which we use to
    // drive throttled avatar-position updates (replacing the non-ticking pRPersona).
    const pClient = pLnG?.pClient ?? null;
    this.pTime = pClient?.Time_Open?.() ?? null;
    if (this.pTime) {
      this.pTime.Attach(this);
      console.log('[InWorldSession] pTime opened and attached for tick-driven avatar updates');
    } else {
      console.warn('[InWorldSession] pTime unavailable; avatar updates will not fire');
    }

    this.setState(ConnectionState.InWorld);
  }

  async disconnect(): Promise<void> {
    this.stopRealtime();
    this.setAIMode(false);
    this.setEchoMode(false);
    this.stopSTT();
    this.stopTTS();

    if (this.pTime) {
      this.pTime.Detach(this);
      this.pTime = null;
    }

    if (this.visualizer) {
      this.visualizer.dispose();
      this.visualizer = null;
    }

    if (this.audioManager) {
      this.audioManager.stop();
      this.audioManager = null;
    }

    if (this.puppet) {
      await this.puppet.despawn();
      this.puppet = null;
    }
    this.setState(ConnectionState.Disconnected);
  }

  // ─── STT pipeline ──────────────────────────────────────────────────────

  async startSTT(apiKeyOverride?: string): Promise<void> {
    if (this.sttService?.isConnected) {
      console.warn('[InWorldSession] STT already running');
      return;
    }

    if (!this.audioManager) {
      throw new Error('Audio manager not available — enter the world first');
    }

    const apiKey = apiKeyOverride ?? DeepgramConfig.API_KEY;
    if (!apiKey) {
      throw new Error('No Deepgram API key — set DEEPGRAM_API_KEY in .env');
    }

    // Only use decode interception — do NOT call sttCapture.enable() which
    // creates a ScriptProcessorNode that writes silence to the same buffer,
    // corrupting the audio stream sent to Deepgram.
    const audioMeta = this.audioManager.getAudioMetadata();
    const ctxRate = this.audioManager.getAudioContext()?.sampleRate;
    console.log(`[InWorldSession] MVRP audio: rate=${audioMeta?.sampleRate} slice=${audioMeta?.samplesPerSlice} bps=${audioMeta?.bytesPerSample} | AudioContext rate=${ctxRate}`);

    this.sttCapture = new AudioFrameCapture(this.audioManager);
    this.audioManager.registerDecodeCapture(this.sttCapture);

    this.sttService = new STTService({
      model: DeepgramConfig.MODEL,
      sampleRate: DeepgramConfig.SAMPLE_RATE,
      encoding: DeepgramConfig.ENCODING,
      endpoint: DeepgramConfig.API_ENDPOINT,
      eotThreshold: DeepgramConfig.EOT_THRESHOLD,
      eotTimeoutMs: DeepgramConfig.EOT_TIMEOUT_MS,
    });
    this.sttService.onTranscript = (event) => {
      this.onTranscript?.(event);
      this.handleEchoTranscript(event);
      this.handleAITranscript(event);
    };
    this.sttService.onTurnStart = () => {
      this.cancelAccumulation();
    };
    this.sttService.onTurnResumed = () => {
      this.cancelAccumulation();
    };
    this.sttService.onError = (err) => console.error('[InWorldSession] STT error:', err);

    await this.sttService.connect(apiKey);

    const mvrpRate = audioMeta?.sampleRate ?? 48000;
    this.sttDrainLoop = new STTDrainLoop(this.sttCapture.buffer, this.sttService, {
      srcSampleRate: mvrpRate,
    });
    this.sttDrainLoop.start();

    // Wire mono/stereo detection callback — fires once on first decode call.
    // Replaces the old polling mechanism which could time out before data arrived.
    if (this.audioManager) {
      const alreadyDetected = this.audioManager.decodedIsMono;
      if (alreadyDetected !== null) {
        this.sttDrainLoop.isMono = alreadyDetected;
        console.log(`[InWorldSession] Decode format already known: mono=${alreadyDetected}`);
      }
      this.audioManager.onFormatDetected = (isMono: boolean) => {
        if (this.sttDrainLoop) {
          this.sttDrainLoop.isMono = isMono;
          console.log(`[InWorldSession] Decode format applied to drain loop: mono=${isMono}`);
        }
      };
    }

    console.log('[InWorldSession] STT pipeline started');
  }

  stopSTT(): void {
    if (this.sttDrainLoop) {
      this.sttDrainLoop.stop();
      this.sttDrainLoop = null;
    }

    if (this.sttService) {
      this.sttService.disconnect();
      this.sttService = null;
    }

    if (this.sttCapture) {
      if (this.audioManager) {
        this.audioManager.unregisterDecodeCapture();
      }
      this.sttCapture.disable();
      this.sttCapture.dispose();
      this.sttCapture = null;
    }

    console.log('[InWorldSession] STT pipeline stopped');
  }

  get isSTTActive(): boolean {
    return this.sttService?.isConnected === true && (this.sttDrainLoop?.isRunning === true);
  }

  // ─── TTS pipeline ──────────────────────────────────────────────────────

  async startTTS(options?: { apiKey?: string; voice?: string }): Promise<void> {
    if (this.ttsService?.isConnected) {
      console.warn('[InWorldSession] TTS already running');
      return;
    }

    const apiKey = options?.apiKey ?? DeepgramConfig.API_KEY;
    if (!apiKey) {
      throw new Error('No Deepgram API key — set DEEPGRAM_API_KEY in .env');
    }

    this.ttsService = new TTSService({
      model: options?.voice ?? DeepgramConfig.TTS_MODEL,
      sampleRate: DeepgramConfig.TTS_SAMPLE_RATE,
      endpoint: DeepgramConfig.TTS_ENDPOINT,
    });
    this.ttsService.onError = (err) => console.error('[InWorldSession] TTS error:', err);

    this.audioEncoder = new OutboundAudioEncoder();
    const ttsSampleRate = this.ttsService.opts.sampleRate;
    this.ttsService.onRawAudioData = (pcm16: Int16Array) => {
      this.audioEncoder?.pushAudio(pcm16, ttsSampleRate);
    };

    const audioCtx = this.audioManager?.getAudioContext() ?? undefined;
    await this.ttsService.connect(apiKey, audioCtx);

    console.log(`[InWorldSession] TTS pipeline started (voice: ${this.ttsService.opts.model}, outbound audio: enabled)`);

    if (this._aiMode) {
      this.wireAIHandlers();
    } else if (this._echoMode) {
      this.wireEchoHandlers();
    }
  }

  stopTTS(): void {
    if (this.ttsService) {
      this.ttsService.onRawAudioData = null;
      this.ttsService.disconnect();
      this.ttsService = null;
    }
    if (this.audioEncoder) {
      const diag = this.audioEncoder.diagnostics;
      console.log(
        `[InWorldSession] Outbound audio stats: pushed=${diag.totalPushed} ` +
        `drained=${diag.totalDrained} overruns=${diag.overruns}`
      );
      this.audioEncoder = null;
    }
    console.log('[InWorldSession] TTS pipeline stopped');
  }

  speak(text: string): void {
    if (!this.ttsService?.isConnected) {
      console.warn('[InWorldSession] TTS not connected — cannot speak');
      return;
    }
    this.ttsService.speakAndFlush(text);
  }

  get isTTSActive(): boolean {
    return this.ttsService?.isConnected === true;
  }

  // ─── Echo mode (Phase 3: STT → TTS round-trip) ────────────────────────

  setEchoMode(enabled: boolean): void {
    if (this._echoMode === enabled) return;
    this._echoMode = enabled;

    if (enabled) {
      this.wireEchoHandlers();
      console.log('[InWorldSession] Echo mode ON — STT final transcripts will be spoken via TTS');
    } else {
      this.unwireEchoHandlers();
      console.log('[InWorldSession] Echo mode OFF');
    }
  }

  get isEchoMode(): boolean {
    return this._echoMode;
  }

  get isTTSSpeaking(): boolean {
    return this._ttsSpeaking;
  }

  private wireEchoHandlers(): void {
    if (this.ttsService) {
      this.ttsService.onFlushed = () => {
        this._ttsSpeaking = false;
        if (this._aiMode && this._llmDone) {
          this.startAISuppression();
        } else if (this._echoMode) {
          this.startEchoSuppression();
        }
        this.onEchoFlushed?.();
      };
    }
  }

  private startEchoSuppression(): void {
    const suppressMs = 500;
    console.log(`[InWorldSession] Echo TTS flushed — suppressing STT for ${suppressMs}ms`);
    if (this._echoSuppressTimer) clearTimeout(this._echoSuppressTimer);
    this._echoSuppressTimer = setTimeout(() => {
      this._echoSuppressTimer = null;
      console.log('[InWorldSession] Echo suppression window ended');
    }, suppressMs);
  }

  private unwireEchoHandlers(): void {
    this._ttsSpeaking = false;
    if (this._echoSuppressTimer) {
      clearTimeout(this._echoSuppressTimer);
      this._echoSuppressTimer = null;
    }
    if (this.ttsService) {
      this.ttsService.onFlushed = null;
    }
  }

  handleEchoTranscript(event: TranscriptEvent): void {
    if (!this._echoMode) return;
    if (!event.isFinal) return;
    if (!event.text.trim()) return;

    if (this._ttsSpeaking || this._echoSuppressTimer !== null) {
      console.log(
        `[InWorldSession] Echo: skipping "${event.text.slice(0, 40)}" ` +
        `(speaking=${this._ttsSpeaking}, suppressed=${this._echoSuppressTimer !== null})`
      );
      return;
    }

    if (!this.ttsService?.isConnected) {
      console.warn('[InWorldSession] Echo: TTS not connected — cannot echo');
      return;
    }

    this._ttsSpeaking = true;
    console.log(`[InWorldSession] Echo: speaking "${event.text.slice(0, 80)}"`);
    this.ttsService.speakAndFlush(event.text);
  }

  // ─── AI mode (Phase 4: STT → LLM → TTS round-trip) ─────────────────

  setAIMode(enabled: boolean): void {
    if (this._aiMode === enabled) return;
    this._aiMode = enabled;

    if (enabled) {
      if (this._echoMode) {
        console.log('[InWorldSession] Disabling echo mode (mutually exclusive with AI mode)');
        this.setEchoMode(false);
      }

      if (!this._personaEngine.active) {
        this._personaEngine.loadDefaultCoach();
      }

      const systemPrompt = this._personaEngine.buildTurnAwarePrompt();

      if (!this.llmService) {
        this.llmService = new LLMService({
          model: OpenAIConfig.MODEL,
          apiKey: OpenAIConfig.API_KEY,
          endpoint: OpenAIConfig.API_ENDPOINT,
          maxHistoryMessages: OpenAIConfig.MAX_HISTORY,
          systemPrompt,
          temperature: OpenAIConfig.TEMPERATURE,
        });
      } else {
        this.llmService.setSystemPrompt(systemPrompt);
      }

      this._personaEngine.onStateChanged = (state) => {
        this.applySTTConfigForState(state);
      };
      this.applySTTConfigForState(this._personaEngine.state);

      this.wireAIHandlers();
      console.log('[InWorldSession] AI mode ON — STT final transcripts → LLM → TTS');
    } else {
      this.unwireAIHandlers();
      this.cancelAccumulation();
      if (this.llmService?.isStreaming) {
        this.llmService.abort();
      }
      this._llmDone = false;
      this._personaEngine.onStateChanged = null;
      this._personaEngine.unload();
      this.llmService?.clearHistory();
      console.log('[InWorldSession] AI mode OFF');
    }
  }

  get isAIMode(): boolean {
    return this._aiMode;
  }

  get llm(): LLMService | null {
    return this.llmService;
  }

  get persona(): ScenarioCoachEngine {
    return this._personaEngine;
  }

  loadPersona(definition: PersonaDefinition): void {
    this._personaEngine.loadPersona(definition);

    if (this.llmService) {
      const prompt = this._personaEngine.buildTurnAwarePrompt();
      this.llmService.setSystemPrompt(prompt);
      this.llmService.clearHistory();
    }

    console.log(`[InWorldSession] Persona loaded: "${definition.name}" (voice: ${definition.voice})`);
  }

  private wireAIHandlers(): void {
    if (!this.llmService) return;

    this.llmService.onSentence = (sentence) => {
      if (!this._aiMode) return;
      const cleaned = sentence.replace(SETUP_COMPLETE_MARKER, '').trim();
      if (!cleaned) return;
      console.log(`[InWorldSession] AI sentence → TTS: "${cleaned.slice(0, 80)}"`);
      this.onAIResponse?.(cleaned);
      if (this.ttsService?.isConnected) {
        this._ttsSpeaking = true;
        this.ttsService.speak(cleaned);
      }
    };

    this.llmService.onComplete = (fullResponse) => {
      console.log(`[InWorldSession] AI response complete (${fullResponse.length} chars)`);
      this._personaEngine.checkResponseForSetupSignal(fullResponse);
      this._llmDone = true;
      if (this.ttsService?.isConnected && this._ttsSpeaking) {
        this.ttsService.flush();
      } else if (!this._ttsSpeaking) {
        this.startAISuppression();
      }
    };

    this.llmService.onError = (err) => {
      console.error('[InWorldSession] LLM error:', err.message);
      this._ttsSpeaking = false;
      this._llmDone = false;
    };

    if (this.ttsService) {
      this.ttsService.onFlushed = () => {
        this._ttsSpeaking = false;
        if (this._aiMode && this._llmDone) {
          this.startAISuppression();
        } else if (this._echoMode) {
          this.startEchoSuppression();
        }
      };
    }
  }

  private unwireAIHandlers(): void {
    if (this.llmService) {
      this.llmService.onSentence = null;
      this.llmService.onComplete = null;
      this.llmService.onError = null;
    }
    this._ttsSpeaking = false;
    this.cancelAccumulation();
    if (this._echoSuppressTimer) {
      clearTimeout(this._echoSuppressTimer);
      this._echoSuppressTimer = null;
    }
  }

  private static readonly ACCUMULATION_DELAYS: Record<string, { withPunctuation: number; withoutPunctuation: number }> = {
    gathering: { withPunctuation: 500, withoutPunctuation: 1500 },
    roleplay:  { withPunctuation: 300,  withoutPunctuation: 800 },
    feedback:  { withPunctuation: 300,  withoutPunctuation: 600 },
    idle:      { withPunctuation: 300,  withoutPunctuation: 800 },
  };

  private static readonly STT_EOT_BY_STATE: Record<string, { eotThreshold: number; eotTimeoutMs: number }> = {
    gathering: { eotThreshold: 0.70, eotTimeoutMs: 5000 },
    roleplay:  { eotThreshold: 0.70, eotTimeoutMs: 4000 },
    feedback:  { eotThreshold: 0.70, eotTimeoutMs: 5000 },
    idle:      { eotThreshold: 0.70, eotTimeoutMs: 5000 },
  };

  private handleAITranscript(event: TranscriptEvent): void {
    if (!this._aiMode) return;
    if (!event.isFinal) return;
    if (!event.text.trim()) return;

    if (this._ttsSpeaking || this._echoSuppressTimer !== null || this.llmService?.isStreaming) {
      console.log(
        `[InWorldSession] AI: skipping "${event.text.slice(0, 40)}" ` +
        `(speaking=${this._ttsSpeaking}, suppressed=${this._echoSuppressTimer !== null}, llmBusy=${this.llmService?.isStreaming ?? false})`,
      );
      return;
    }

    if (!this.llmService) {
      console.warn('[InWorldSession] AI: LLMService not initialized');
      return;
    }

    this._accumulatedText.push(event.text);

    if (this._accumulationTimer) clearTimeout(this._accumulationTimer);

    const state = this._personaEngine.state;
    const delays = InWorldSession.ACCUMULATION_DELAYS[state] ?? InWorldSession.ACCUMULATION_DELAYS['idle'];
    const endsWithPunctuation = /[.?!][\s"']*$/.test(event.text.trim());
    const delayMs = endsWithPunctuation ? delays.withPunctuation : delays.withoutPunctuation;

    console.log(
      `[InWorldSession] AI: buffered "${event.text.slice(0, 40)}" ` +
      `(state=${state}, punct=${endsWithPunctuation}, delay=${delayMs}ms, ` +
      `buffered=${this._accumulatedText.length} segment(s))`,
    );

    this._accumulationTimer = setTimeout(() => {
      this._accumulationTimer = null;
      this.commitAccumulatedTranscript();
    }, delayMs);
  }

  private cancelAccumulation(): void {
    if (this._accumulationTimer) {
      clearTimeout(this._accumulationTimer);
      this._accumulationTimer = null;
      console.log(
        `[InWorldSession] Accumulation cancelled — user resumed speaking ` +
        `(discarding ${this._accumulatedText.length} buffered segment(s))`,
      );
      this._accumulatedText = [];
    }
  }

  private commitAccumulatedTranscript(): void {
    if (this._accumulatedText.length === 0) return;
    if (!this.llmService) return;

    const fullText = this._accumulatedText.join(' ');
    this._accumulatedText = [];

    this._personaEngine.checkForExit(fullText);
    this._personaEngine.recordTurn();

    const prompt = this._personaEngine.buildTurnAwarePrompt();
    this.llmService.setSystemPrompt(prompt);

    this._llmDone = false;
    console.log(`[InWorldSession] AI: processing "${fullText.slice(0, 80)}" (committed)`);
    void this.llmService.sendMessage(fullText).catch((err) => {
      console.error('[InWorldSession] AI sendMessage failed:', err);
    });
  }

  /**
   * Suppress STT for a fixed window after TTS flush completes.
   *
   * Previously this polled OutboundAudioEncoder until physically drained,
   * which blocked STT for the entire audio playback duration (up to 18+ seconds
   * on long responses). The buffer continues draining via onTick() regardless —
   * we just stop blocking STT input while waiting for it to finish.
   *
   * Fixed 5s cap + 1s post-margin = max 6s STT block per turn, regardless of
   * NPC response length. Accepts minor echo risk for dramatically lower latency.
   */
  private startAISuppression(): void {
    this._llmDone = false;
    if (this._echoSuppressTimer) clearTimeout(this._echoSuppressTimer);

    const suppressMs = 500;
    console.log(`[InWorldSession] AI suppression: fixed ${suppressMs}ms window (buffer drains independently)`);
    this._echoSuppressTimer = setTimeout(() => {
      this._echoSuppressTimer = null;
      console.log('[InWorldSession] AI suppression window ended');
    }, suppressMs);
  }

  private applySTTConfigForState(state: string): void {
    const config = InWorldSession.STT_EOT_BY_STATE[state] ?? InWorldSession.STT_EOT_BY_STATE['idle'];
    if (this.sttService?.isConnected) {
      const sent = this.sttService.configure(config);
      if (sent) {
        console.log(`[InWorldSession] STT reconfigured for "${state}": eot=${config.eotThreshold}, timeout=${config.eotTimeoutMs}ms`);
      }
    }
  }

  // ─── Realtime API mode (single API replaces STT+LLM+TTS) ─────────────

  get isRealtimeMode(): boolean { return this._realtimeMode; }

  async startRealtime(personaDefinition?: PersonaDefinition): Promise<void> {
    if (this._realtimeMode) {
      console.warn('[InWorldSession] Realtime already running');
      return;
    }

    const apiKey = OpenAIConfig.API_KEY;
    if (!apiKey) {
      throw new Error('No OpenAI API key — set OPENAI_API_KEY in .env');
    }

    if (!this.audioManager) {
      throw new Error('Audio manager not available — enter the world first');
    }

    if (this._aiMode) this.setAIMode(false);
    if (this._echoMode) this.setEchoMode(false);

    const voiceMap: Record<string, string> = {
      'aura-2-thalia-en': 'shimmer',
      'aura-2-apollo-en': 'echo',
      'aura-2-aurora-en': 'coral',
      'aura-2-draco-en': 'ash',
    };
    const deepgramVoice = personaDefinition?.voice ?? 'aura-2-thalia-en';
    const realtimeVoice = voiceMap[deepgramVoice] ?? OpenAIConfig.REALTIME_VOICE;

    if (personaDefinition) {
      this._personaEngine.loadPersona(personaDefinition);
    } else if (!this._personaEngine.active) {
      this._personaEngine.loadDefaultCoach();
    }
    const instructions = this._personaEngine.buildTurnAwarePrompt();

    this.realtimeService = new RealtimeService({
      model: OpenAIConfig.REALTIME_MODEL,
      voice: realtimeVoice,
      instructions,
      turnDetection: {
        type: 'server_vad',
        threshold: 0.5,
        prefix_padding_ms: 300,
        silence_duration_ms: 700,
      },
    });

    this.audioEncoder = new OutboundAudioEncoder();

    this.realtimeService.onAudioDelta = (pcm16) => {
      this.audioEncoder?.pushAudio(pcm16, 24000);
    };

    this.realtimeService.onUserTranscript = (text, isFinal) => {
      this.onTranscript?.({ text, isFinal, isInterim: !isFinal, confidence: 1.0 });
    };

    this.realtimeService.onAssistantTranscript = (text) => {
      this.onAIResponse?.(text);
    };

    this.realtimeService.onResponseStart = () => {
      console.log('[InWorldSession] Realtime: model responding — muting input');
    };

    this.realtimeService.onResponseDone = () => {
      this._personaEngine.advanceTurn();
      const newPrompt = this._personaEngine.buildTurnAwarePrompt();
      this.realtimeService?.updateSession({ instructions: newPrompt });
      console.log(`[InWorldSession] Realtime: response done (turn ${this._personaEngine.turnCount})`);
    };

    this.realtimeService.onError = (err) => {
      console.error('[InWorldSession] Realtime error:', err.message);
    };

    await this.realtimeService.connect(apiKey);

    this._realtimeCapture = new AudioFrameCapture(this.audioManager);
    this.audioManager.registerDecodeCapture(this._realtimeCapture);

    const mvrpRate = this.audioManager.getAudioMetadata()?.sampleRate ?? 24000;
    const isMono = this.audioManager.decodedIsMono ?? true;

    this._realtimeDrainTimer = setInterval(() => {
      if (!this._realtimeCapture || !this.realtimeService?.isConnected) return;
      const buf = this._realtimeCapture.buffer;
      const available = buf.available;
      if (available < 960) return;

      const raw = new Float32Array(available);
      buf.read(raw, available);

      const step = isMono ? (mvrpRate / 24000) : (mvrpRate / 24000) * 2;
      const outLen = Math.floor(available / step);
      const pcm16 = new Int16Array(outLen);
      for (let i = 0; i < outLen; i++) {
        const srcIdx = Math.floor(i * step);
        const sample = Math.max(-1, Math.min(1, raw[srcIdx]));
        pcm16[i] = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
      }

      this.realtimeService!.sendAudio(pcm16);
    }, 100);

    this._realtimeMode = true;
    console.log(`[InWorldSession] Realtime mode ON — voice: ${realtimeVoice}, model: ${OpenAIConfig.REALTIME_MODEL}`);
    console.log(`[InWorldSession] Persona: "${this._personaEngine.personaName}"`);
  }

  stopRealtime(): void {
    if (this._realtimeDrainTimer) {
      clearInterval(this._realtimeDrainTimer);
      this._realtimeDrainTimer = null;
    }

    if (this._realtimeCapture && this.audioManager) {
      this.audioManager.unregisterDecodeCapture();
      this._realtimeCapture = null;
    }

    if (this.realtimeService) {
      this.realtimeService.disconnect();
      this.realtimeService = null;
    }

    if (this.audioEncoder) {
      const diag = this.audioEncoder.diagnostics;
      console.log(`[InWorldSession] Realtime audio stats: pushed=${diag.totalPushed} drained=${diag.totalDrained} overruns=${diag.overruns}`);
      this.audioEncoder = null;
    }

    this._realtimeMode = false;
    console.log('[InWorldSession] Realtime mode OFF');
  }

  private lastServerTime = 0;

  onTick(pNotice: any): void {
    this.lastServerTime = pNotice.pData.tmServer;
    this.pendingAudioSlice = this.drainNextSlice();
    try {
      this.personaSession.onTick();
    } catch (err) {
      console.error('[InWorldSession] onTick delegation error:', err);
    }
    this.pendingAudioSlice = null;
  }

  private pendingAudioSlice: AudioSlice | null = null;

  private drainNextSlice(): AudioSlice | null {
    if (!this.audioEncoder || this.audioEncoder.available < SAMPLES_PER_SLICE) return null;
    return this.audioEncoder.drainSlice();
  }

  public teleportTo(
    parentId: string,
    position: { x: number; y: number; z: number },
    wClass: (typeof MapModelClass)[keyof typeof MapModelClass] = MapModelClass.Celestial,
  ): void {
    if (!this.personaSession || !this.personaSession.pRPersona) {
      console.error('[InWorldSession] No PersonaSession or pRPersona for teleport');
      return;
    }

    if (this.visualizer) {
      const personaId = this.personaSession.personaId;
      this.visualizer.updateProximityListPosition(Number(personaId), position);
    }

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const pRPersona = this.personaSession.pRPersona as any;

      const tmStamp: number = this.lastServerTime || Date.now();

      this.lastCelestialId = parentId;

      const updatePayload = {
        tmStamp,
        pState: {
          bControl: 0,
          bVolume: 0,
          wFlag: 0,
          bSerial_A: 0,
          bSerial_B: 0,
          wOrder: 0,
          bCoordSys: 156,
          pPosition_Head: {
            pParent: {
              twObjectIx: Number(parentId),
              wClass,
            },
            pRelative: {
              vPosition: {
                dX: position.x,
                dY: position.y,
                dZ: position.z,
              },
            },
          },
          pRotation_Head: {
            dwV: pRPersona.Quat_Encode([0.7071068, 0, 0, 0.7071068]),
          },
          pRotation_Body: {
            dwV: pRPersona.Quat_Encode([0.7071068, 0, 0, 0.7071068]),
          },
          pPosition_Hand_Left: {
            dwV: pRPersona.Vect_Encode([-0.2, -0.6, -0.1]),
          },
          pRotation_Hand_Left: {
            dwV: pRPersona.Quat_Encode([0, 0, 0, 1]),
          },
          pPosition_Hand_Right: {
            dwV: pRPersona.Vect_Encode([0.2, -0.6, -0.1]),
          },
          pRotation_Hand_Right: {
            dwV: pRPersona.Quat_Encode([0, 0, 0, 1]),
          },
          bHand_Left: Array.from(new Uint8Array(6)),
          bHand_Right: Array.from(new Uint8Array(6)),
          bFace: [24, 23, 22, 21],
        },
        wSamples: 0,
        wCodec: 0,
        wSize: 0,
        abData: new Uint8Array(0),
      };

      this.lastPState = updatePayload.pState;
      pRPersona.Send('UPDATE', updatePayload);
    } catch (err) {
      console.error('[InWorldSession] UPDATE Send failed:', err);
      throw err;
    }
  }

  /**
   * Re-send the last cached position UPDATE (for periodic avatar updates).
   * Returns false if no previous position is cached.
   */
  public resendLastPosition(): boolean {
    if (!this.lastPState || !this.personaSession?.pRPersona) return false;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pRPersona = this.personaSession.pRPersona as any;

    const slice = this.pendingAudioSlice;

    try {
      pRPersona.Send('UPDATE', {
        tmStamp: this.lastServerTime || Date.now(),
        pState: this.lastPState,
        wSamples: slice?.wSamples ?? 0,
        wCodec: slice?.wCodec ?? 0,
        wSize: slice?.wSize ?? 0,
        abData: slice?.abData ?? new Uint8Array(0),
      });
      return true;
    } catch (err) {
      console.error('[InWorldSession] resendLastPosition failed:', err);
      return false;
    }
  }

  /**
   * Teleport to a named destination from the CDN destinations manifest.
   *
   * Both terrestrial and object types are sent as earth-relative Cartesian
   * (pParent wClass 71, celestialID 104). The live RP1 app resolves object
   * positions client-side before sending UPDATE — the server does NOT resolve
   * wClass 72 parent references for avatar visibility.
   */
  public async teleportToDestination(destination: TeleportDestination): Promise<void> {
    const loc = destination.location;

    if (loc.type === 'terrestrial') {
      const pos = geoPosToCartesian(loc.geoPos);
      liftAboveSurface(pos);
      console.log(`[InWorldSession] Teleporting to terrestrial "${destination.name}" → celestial ${loc.celestialID}, pos (${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)})`);
      this.teleportTo(String(loc.celestialID), pos);
      return;
    }

    const cartesian = OBJECT_CARTESIAN_POSITIONS[loc.objectID];
    if (cartesian) {
      const celestialId = loc.objectType === 'celestial' ? String(loc.objectID) : '104';
      const pos = { x: cartesian[0], y: cartesian[1], z: cartesian[2] };
      console.log(`[InWorldSession] Teleporting to celestial object "${destination.name}" → celestial ${celestialId}, pos (${pos.x.toFixed(2)}, ${pos.y.toFixed(2)}, ${pos.z.toFixed(2)})`);
      this.teleportTo(celestialId, pos);
      return;
    }

    const geoDeg = OBJECT_GEO_POSITIONS_DEG[loc.objectID];
    if (!geoDeg) {
      console.error(`[InWorldSession] No static coordinates for "${destination.name}" (objectID ${loc.objectID}). Cannot teleport.`);
      return;
    }

    const DEG_TO_RAD = Math.PI / 180;
    const geoPos: [number, number, number] = [
      geoDeg[0] * DEG_TO_RAD,
      geoDeg[1] * DEG_TO_RAD,
      geoDeg[2],
    ];
    const pos = geoPosToCartesian(geoPos);
    liftAboveSurface(pos);

    const scatter = loc.scatter ?? 0;
    if (scatter > 0) {
      const angle = Math.random() * 2 * Math.PI;
      const dist = Math.random() * scatter;
      pos.x += dist * Math.cos(angle);
      pos.z += dist * Math.sin(angle);
    }

    const celestialId = '104';
    console.log(`[InWorldSession] Teleporting to object "${destination.name}" → celestial ${celestialId}, pos (${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)})`);
    this.teleportTo(celestialId, pos);
  }
}

/**
 * Static geo positions for object destinations, in DEGREES [lat_deg, lon_deg, radius_m].
 * Captured from the live RP1 app semicolon HUD overlay.
 * Convert to radians before passing to geoPosToCartesian().
 *
 * To capture new coordinates: open enter.rp1.com, teleport to destination,
 * press semicolon (;), read lat/lon/rad from the HUD popup.
 */
const OBJECT_GEO_POSITIONS_DEG: Record<number, [number, number, number]> = {
  1000223194: [2.009966805469, 2.010016174462, 6371000.75], // VIRTUAL WORLDS MUSEUM HUB
  1000223183: [1, 1.00501054, 6371000],                     // RP1 START
  1000223200: [1.964038593132, 2.027023508323, 6371000],    // NCXR MEETUP
  1000223198: [1.980018958562, 2.020032058807, 6371000],    // SAWHORSE
  1000223197: [1.999986464498, 1.999999174473, 6371000],    // SUMMER JAMZ
  1000223174: [1.98, 2.0, 6371000],                         // AWE BOOTH (T)
  1000223175: [2.000034157782, 2.009969685202, 6371000],    // LA ACM SIGGRAPH VR CAMPUS
  1000223184: [1.999968523743, 2.005031073628, 6371000],    // WORKSHOP ALPHA
  1000223193: [2.0, 2.015, 6371000],                        // PLAYGROUND beta
  1000223201: [3.000013025990, 1.000020943142, 6371000],    // TAP 4 TECH
  1000223173: [1.989984342557, 1.994974558479, 6371000],    // LOUNGE
  1000223157: [1.000176138544, 0.997486907630, 6371000],    // BAR P1 (T)
};

/**
 * Celestial objects use Cartesian positions directly (not lat/lon/rad).
 * Key is objectID, value is [x, y, z] in meters relative to the celestial body center.
 */
const OBJECT_CARTESIAN_POSITIONS: Record<number, [number, number, number]> = {
  105: [-1.04, 0.61, 0.98], // ISS — position relative to celestialID 105
};

export const SUPPORTED_OBJECT_IDS = new Set([
  ...Object.keys(OBJECT_GEO_POSITIONS_DEG).map(Number),
  ...Object.keys(OBJECT_CARTESIAN_POSITIONS).map(Number),
]);

const SURFACE_OFFSET_M = 1.75;

function liftAboveSurface(pos: { x: number; y: number; z: number }): void {
  const len = Math.sqrt(pos.x * pos.x + pos.y * pos.y + pos.z * pos.z);
  if (len === 0) return;
  const scale = SURFACE_OFFSET_M / len;
  pos.x += pos.x * scale;
  pos.y += pos.y * scale;
  pos.z += pos.z * scale;
}
