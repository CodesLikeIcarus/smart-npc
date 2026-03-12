export type RealtimeConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface RealtimeServiceOptions {
  model?: string;
  voice?: string;
  instructions?: string;
  turnDetection?: {
    type: 'server_vad';
    threshold?: number;
    prefix_padding_ms?: number;
    silence_duration_ms?: number;
  };
}

const DEFAULT_MODEL = 'gpt-4o-mini-realtime-preview';
const DEFAULT_VOICE = 'alloy';

export class RealtimeService {
  private ws: WebSocket | null = null;
  private _state: RealtimeConnectionState = 'disconnected';
  private _isResponding = false;
  private connectStartMs = 0;
  private _loggedFirstAudioDelta = false;
  private _assistantTranscriptBuffer = '';

  readonly opts: Required<RealtimeServiceOptions>;

  onStateChange: ((state: RealtimeConnectionState) => void) | null = null;
  onAudioDelta: ((pcm16: Int16Array) => void) | null = null;
  onUserTranscript: ((text: string, isFinal: boolean) => void) | null = null;
  onAssistantTranscript: ((text: string) => void) | null = null;
  onResponseStart: (() => void) | null = null;
  onResponseDone: (() => void) | null = null;
  onError: ((error: Error) => void) | null = null;

  constructor(options?: RealtimeServiceOptions) {
    this.opts = {
      model: options?.model ?? DEFAULT_MODEL,
      voice: options?.voice ?? DEFAULT_VOICE,
      instructions: options?.instructions ?? '',
      turnDetection: options?.turnDetection ?? {
        type: 'server_vad' as const,
        threshold: 0.5,
        prefix_padding_ms: 300,
        silence_duration_ms: 500,
      },
    };
  }

  get state(): RealtimeConnectionState { return this._state; }
  get isConnected(): boolean { return this._state === 'connected'; }
  get isResponding(): boolean { return this._isResponding; }

  private setState(s: RealtimeConnectionState): void {
    if (this._state === s) return;
    console.log(`[RealtimeService] State: ${this._state} → ${s}`);
    this._state = s;
    this.onStateChange?.(s);
  }

  async connect(apiKey: string): Promise<void> {
    if (this._state === 'connected' || this._state === 'connecting') return;

    this.setState('connecting');
    this.connectStartMs = performance.now();

    const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(this.opts.model)}`;
    console.log(`[RealtimeService] Connecting to: ${url}`);

    this.ws = new WebSocket(url, [
      'realtime',
      `openai-insecure-api-key.${apiKey}`,
      'openai-beta.realtime-v1',
    ]);

    this.ws.onopen = () => {
      const elapsed = Math.round(performance.now() - this.connectStartMs);
      console.log(`[RealtimeService] Connected (${elapsed}ms handshake)`);
      this.setState('connected');
      this.sendSessionUpdate();
    };

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data as string);
        this.handleServerEvent(msg);
      } catch {
        console.warn('[RealtimeService] Unparseable message');
      }
    };

    this.ws.onerror = () => {
      this.setState('error');
      this.onError?.(new Error('WebSocket error'));
    };

    this.ws.onclose = (event) => {
      console.log(`[RealtimeService] Closed: code=${event.code} reason=${event.reason}`);
      this.setState('disconnected');
    };
  }

  disconnect(): void {
    if (this.ws) {
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onerror = null;
      this.ws.onclose = null;
      if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
        this.ws.close();
      }
      this.ws = null;
    }
    this._isResponding = false;
    this.setState('disconnected');
  }

  sendAudio(pcm16: Int16Array): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (this._isResponding) return;

    const bytes = new Uint8Array(pcm16.buffer, pcm16.byteOffset, pcm16.byteLength);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }

    this.ws.send(JSON.stringify({
      type: 'input_audio_buffer.append',
      audio: btoa(binary),
    }));
  }

  updateSession(opts: Partial<RealtimeServiceOptions>): void {
    if (opts.instructions !== undefined) this.opts.instructions = opts.instructions;
    if (opts.voice !== undefined) this.opts.voice = opts.voice;
    if (opts.turnDetection !== undefined) this.opts.turnDetection = opts.turnDetection;
    if (this.isConnected) this.sendSessionUpdate();
  }

  private sendSessionUpdate(): void {
    this.send({
      type: 'session.update',
      session: {
        modalities: ['text', 'audio'],
        instructions: this.opts.instructions,
        voice: this.opts.voice,
        input_audio_format: 'pcm16',
        output_audio_format: 'pcm16',
        turn_detection: this.opts.turnDetection,
        input_audio_transcription: { model: 'gpt-4o-mini-transcribe' },
      },
    });
  }

  private send(data: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  private handleServerEvent(msg: Record<string, unknown>): void {
    const type = msg.type as string;

    switch (type) {
      case 'session.created':
        console.log(`[RealtimeService] Session created: ${(msg.session as Record<string, unknown>)?.id ?? 'unknown'}`);
        break;

      case 'session.updated':
        console.log('[RealtimeService] Session config applied');
        break;

      case 'input_audio_buffer.speech_started':
        console.log('[RealtimeService] User speech started');
        break;

      case 'input_audio_buffer.speech_stopped':
        console.log('[RealtimeService] User speech stopped');
        break;

      case 'conversation.item.input_audio_transcription.completed':
        {
          const text = (msg.transcript as string) ?? '';
          if (text.trim()) {
            console.log(`[RealtimeService] User: "${text.slice(0, 80)}"`);
            this.onUserTranscript?.(text, true);
          }
        }
        break;

      case 'response.created':
        this._isResponding = true;
        this._assistantTranscriptBuffer = '';
        this._loggedFirstAudioDelta = false;
        console.log('[RealtimeService] Response started');
        this.onResponseStart?.();
        break;

      case 'response.audio.delta':
        {
          const b64 = (msg.delta as string) ?? '';
          if (b64) {
            const pcm16 = this.base64ToPcm16(b64);
            if (!this._loggedFirstAudioDelta) {
              console.log(`[RealtimeService] First audio delta: ${pcm16.length} samples`);
              this._loggedFirstAudioDelta = true;
            }
            this.onAudioDelta?.(pcm16);
          }
        }
        break;

      case 'response.audio_transcript.delta':
        this._assistantTranscriptBuffer += (msg.delta as string) ?? '';
        break;

      case 'response.audio_transcript.done':
        {
          const text = (msg.transcript as string) ?? this._assistantTranscriptBuffer;
          if (text.trim()) {
            console.log(`[RealtimeService] Assistant: "${text.slice(0, 80)}"`);
            this.onAssistantTranscript?.(text);
          }
          this._assistantTranscriptBuffer = '';
        }
        break;

      case 'response.done':
        this._isResponding = false;
        console.log('[RealtimeService] Response done');
        this.onResponseDone?.();
        break;

      case 'error':
        {
          const errMsg = ((msg.error as Record<string, unknown>)?.message as string) ?? 'Unknown error';
          console.error(`[RealtimeService] Error: ${errMsg}`);
          this.onError?.(new Error(errMsg));
        }
        break;

      case 'rate_limits.updated':
        break;

      default:
        console.debug(`[RealtimeService] Unhandled event: ${type}`);
    }
  }

  private base64ToPcm16(b64: string): Int16Array {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new Int16Array(bytes.buffer);
  }
}
