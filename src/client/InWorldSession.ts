import { Session } from "../base/Session.js";
import { ConnectionState, PersonaInfo } from "../types/index.js";
import { PersonaPuppet } from "../avatar/PersonaPuppet.js";
import type { PersonaSession } from "../client/PersonaSession.js";
import { ProximityAudioManager } from "../audio/ProximityAudioManager.js";
import { AudioVisualizer } from "../client/AudioVisualizer.js";
import { AudioFrameCapture } from "../audio/AudioFrameCapture.js";
import { STTService, type TranscriptEvent } from "../ai/STTService.js";
import { STTDrainLoop } from "../ai/STTDrainLoop.js";
import { TTSService } from "../ai/TTSService.js";
import { LLMService } from "../ai/LLMService.js";
import { PersonaEngine, SETUP_COMPLETE_MARKER } from "../persona/PersonaEngine.js";
import type { PersonaDefinition } from "../persona/PersonaDefinition.js";
import { OutboundAudioEncoder, type AudioSlice, SAMPLES_PER_SLICE } from "../audio/OutboundAudioEncoder.js";
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
  private lastAudioDrainMs = 0;
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
  private _personaEngine = new PersonaEngine();

  // ─── Accumulation window (smart pause detection) ──────────────────────
  private _accumulatedText: string[] = [];
  private _accumulationTimer: ReturnType<typeof setTimeout> | null = null;

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

    // Poll for mono/stereo auto-detection from the decode interceptor.
    // Once detected, update the drain loop so prepareForSTT skips stereoToMono if mono.
    const monoDetectInterval = setInterval(() => {
      const isMono = this.audioManager?.decodedIsMono;
      if (isMono !== null && isMono !== undefined) {
        if (this.sttDrainLoop) {
          this.sttDrainLoop.isMono = isMono;
          console.log(`[InWorldSession] Decode format applied to drain loop: mono=${isMono}`);
        }
        clearInterval(monoDetectInterval);
      }
    }, 200);
    // Safety: stop polling after 10s even if no decode happens
    setTimeout(() => clearInterval(monoDetectInterval), 10000);

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

  get persona(): PersonaEngine {
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
      // Single flush for ALL accumulated sentences — avoids EXCESSIVE_FLUSH
      if (this.ttsService?.isConnected && this._ttsSpeaking) {
        console.log('[InWorldSession] Flushing TTS (single flush for entire response)');
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
    gathering: { withPunctuation: 1500, withoutPunctuation: 3000 },
    roleplay:  { withPunctuation: 300,  withoutPunctuation: 800 },
    feedback:  { withPunctuation: 300,  withoutPunctuation: 600 },
    idle:      { withPunctuation: 300,  withoutPunctuation: 800 },
  };

  private static readonly STT_EOT_BY_STATE: Record<string, { eotThreshold: number; eotTimeoutMs: number }> = {
    gathering: { eotThreshold: 0.85, eotTimeoutMs: 9000 },
    roleplay:  { eotThreshold: 0.70, eotTimeoutMs: 4000 },
    feedback:  { eotThreshold: 0.70, eotTimeoutMs: 5000 },
    idle:      { eotThreshold: 0.70, eotTimeoutMs: 5000 },
  };

  private handleAITranscript(event: TranscriptEvent): void {
    if (!this._aiMode) return;
    if (!event.isFinal) return;
    if (!event.text.trim()) return;

    if (this._ttsSpeaking || this._echoSuppressTimer !== null) {
      console.log(
        `[InWorldSession] AI: skipping "${event.text.slice(0, 40)}" ` +
        `(speaking=${this._ttsSpeaking}, suppressed=${this._echoSuppressTimer !== null})`,
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

  private startAISuppression(): void {
    this._llmDone = false;
    if (this._echoSuppressTimer) clearTimeout(this._echoSuppressTimer);
    // Set timer immediately so handleAITranscript sees _echoSuppressTimer !== null
    // during the polling phase. pollDrainThenSuppress will replace it each tick.
    this._echoSuppressTimer = setTimeout(() => this.pollDrainThenSuppress(), 0);
  }

  /**
   * Polls OutboundAudioEncoder until drained, then holds suppression for an
   * additional 1500ms to cover server round-trip echo latency.
   *
   * _echoSuppressTimer remains non-null throughout so handleAITranscript()
   * continues to skip self-echo transcripts during the entire drain + buffer.
   */
  private pollDrainThenSuppress(): void {
    const buffered = this.audioEncoder?.available ?? 0;
    if (buffered >= SAMPLES_PER_SLICE) {
      // Still draining — keep polling every 50ms
      console.log(`[InWorldSession] AI suppression: draining outbound audio (${buffered} samples buffered)`);
      this._echoSuppressTimer = setTimeout(() => this.pollDrainThenSuppress(), 50);
    } else {
      // Drained — start post-drain echo latency buffer
      const postDrainMs = 1500;
      console.log(`[InWorldSession] Outbound audio drained — suppressing STT for ${postDrainMs}ms (echo latency buffer)`);
      this._echoSuppressTimer = setTimeout(() => {
        this._echoSuppressTimer = null;
        console.log('[InWorldSession] AI suppression window ended');
      }, postDrainMs);
    }
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

  private lastServerTime = 0;

  onTick(pNotice: any): void {
    this.lastServerTime = pNotice.pData.tmServer;
    try {
      this.personaSession.onTick();
    } catch (err) {
      console.error('[InWorldSession] onTick delegation error:', err);
    }
    this.drainOutboundAudio();
  }

  private drainOutboundAudio(): void {
    if (!this.audioEncoder || this.audioEncoder.available < SAMPLES_PER_SLICE) return;

    const now = performance.now();
    if (now - this.lastAudioDrainMs < 14.5) return;
    this.lastAudioDrainMs = now;

    const slice = this.audioEncoder.drainSlice();
    if (!slice) return;
    this.sendAudioUpdate(slice);
  }

  private sendAudioUpdate(slice: AudioSlice): void {
    if (!this.lastPState) {
      console.warn('[InWorldSession] Cannot send audio UPDATE — no cached pState (teleportTo not called yet)');
      return;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pRPersona = this.personaSession.pRPersona as any;
    if (!pRPersona) return;

    try {
      pRPersona.Send('UPDATE', {
        tmStamp: this.lastServerTime || Date.now(),
        pState: this.lastPState,
        wSamples: slice.wSamples,
        wCodec: slice.wCodec,
        wSize: slice.wSize,
        abData: slice.abData,
      });
    } catch (err) {
      console.error('[InWorldSession] Audio UPDATE Send failed:', err);
    }
  }

  public teleportTo(celestialId: string, position: { x: number; y: number; z: number }): void {
    if (!this.personaSession || !this.personaSession.pRPersona) {
      console.error('[InWorldSession] No PersonaSession or pRPersona for teleport');
      return;
    }

    // Sync ProximityAvatarList with the new local position
    if (this.visualizer) {
      const personaId = this.personaSession.personaId;
      this.visualizer.updateProximityListPosition(Number(personaId), position);
      console.log('[InWorldSession] Updated ProximityAvatarList with teleport position');
    }

    ///console.debug(`[InWorldSession] Sending UPDATE to reposition to ${celestialId}:`, position);

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const pRPersona = this.personaSession.pRPersona as any;

      const tmStamp: number = this.lastServerTime || Date.now();

      // Cache position state for reuse in audio-only UPDATEs
      this.lastCelestialId = celestialId;

      const updatePayload = {
        tmStamp,
        pState: {
          bControl: 0,
          bVolume: 0,
          wFlag: 0,
          bSerial_A: 0,
          bSerial_B: 0,
          wOrder: 0,
          bCoordSys: 156, // Universal coordinate system (matches RP1Demo PersonaPuppet)
          pPosition_Head: {
            pParent: {
              twObjectIx: Number(celestialId),
              wClass: 71, // MapModelType.Celestial
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
          bHand_Left: Array.from(new Uint8Array(6)),   // Default neutral hand grip (all zeros)
          bHand_Right: Array.from(new Uint8Array(6)),  // Default neutral hand grip (all zeros)
          bFace: [24, 23, 22, 21],                     // Default neutral face expression
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
}
