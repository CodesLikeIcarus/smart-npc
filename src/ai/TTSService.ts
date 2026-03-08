import { int16ToFloat32 } from '../audio/PCMConverter.js';

export interface TTSServiceOptions {
  model?: string;
  sampleRate?: number;
  endpoint?: string;
}

export type TTSConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error';

export class TTSService {
  private ws: WebSocket | null = null;
  private _state: TTSConnectionState = 'disconnected';
  private audioCtx: AudioContext | null = null;
  private nextPlayTime = 0;
  private apiKey: string | null = null;

  // ─── Logging / diagnostics ────────────────────────────────────────────
  private connectStartMs = 0;
  private speakStartMs = 0;
  private flushAudioDurationSec = 0;
  private flushChunkCount = 0;
  private totalSpeakCalls = 0;
  private totalCharsSent = 0;

  readonly opts: Required<TTSServiceOptions>;

  onStateChange: ((state: TTSConnectionState) => void) | null = null;
  onError: ((error: Error) => void) | null = null;
  onFlushed: (() => void) | null = null;
  onAudioChunk: ((samples: Float32Array) => void) | null = null;
  onRawAudioData: ((samples: Int16Array) => void) | null = null;

  constructor(options?: TTSServiceOptions) {
    this.opts = {
      model: options?.model ?? 'aura-2-thalia-en',
      sampleRate: options?.sampleRate ?? 48000,
      endpoint: options?.endpoint ?? 'wss://api.deepgram.com/v1/speak',
    };
  }

  connect(apiKey: string, audioCtx?: AudioContext): Promise<void> {
    if (this.ws) this.disconnect();
    this.apiKey = apiKey;

    return new Promise<void>((resolve, reject) => {
      this.setState('connecting');
      this.connectStartMs = performance.now();

      this.audioCtx = audioCtx ?? new AudioContext({ sampleRate: this.opts.sampleRate });

      const params = new URLSearchParams({
        model: this.opts.model,
        encoding: 'linear16',
        sample_rate: String(this.opts.sampleRate),
        container: 'none',
      });

      const url = `${this.opts.endpoint}?${params.toString()}`;
      console.log(`[TTSService] Connecting to: ${url}`);
      console.log(`[TTSService] Config: model=${this.opts.model} rate=${this.opts.sampleRate}`);

      this.ws = new WebSocket(url, ['token', apiKey]);
      this.ws.binaryType = 'arraybuffer';

      this.ws.onopen = () => {
        this.setState('connected');
        this.nextPlayTime = 0;
        const elapsed = (performance.now() - this.connectStartMs).toFixed(0);
        console.log(`[TTSService] Connected to Deepgram TTS (${elapsed}ms handshake)`);
        resolve();
      };

      this.ws.onmessage = (event: MessageEvent) => {
        this.handleMessage(event);
      };

      this.ws.onerror = () => {
        const err = new Error('[TTSService] WebSocket connection error');
        console.error(err.message);
        this.onError?.(err);
        this.setState('error');
        reject(err);
      };

      this.ws.onclose = (event: CloseEvent) => {
        console.log(`[TTSService] Closed: code=${event.code} reason=${event.reason}`);
        this.setState('disconnected');
        this.ws = null;
      };
    });
  }

  disconnect(): void {
    if (!this.ws) return;

    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'Close' }));
    }

    const ws = this.ws;
    this.ws = null;
    setTimeout(() => {
      if (ws.readyState !== WebSocket.CLOSED) ws.close();
    }, 2000);

    this.setState('disconnected');
  }

  speak(text: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.warn('[TTSService] Cannot speak — not connected');
      return;
    }

    this.totalSpeakCalls++;
    this.totalCharsSent += text.length;
    this.speakStartMs = performance.now();
    this.flushAudioDurationSec = 0;
    this.flushChunkCount = 0;

    const chunks = this.chunkText(text, 2000);
    console.log(
      `[TTSService] speak #${this.totalSpeakCalls}: ${text.length} chars, ` +
      `${chunks.length} chunk(s), total chars sent=${this.totalCharsSent}`
    );
    for (const chunk of chunks) {
      this.ws.send(JSON.stringify({ type: 'Speak', text: chunk }));
    }
  }

  flush(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    console.log('[TTSService] Sending Flush');
    this.ws.send(JSON.stringify({ type: 'Flush' }));
  }

  speakAndFlush(text: string): void {
    this.speak(text);
    this.flush();
  }

  get state(): TTSConnectionState { return this._state; }
  get isConnected(): boolean { return this._state === 'connected'; }
  get context(): AudioContext | null { return this.audioCtx; }

  private setState(state: TTSConnectionState): void {
    const prev = this._state;
    this._state = state;
    if (prev !== state) {
      console.log(`[TTSService] State: ${prev} → ${state}`);
    }
    this.onStateChange?.(state);
  }

  private handleMessage(event: MessageEvent): void {
    if (event.data instanceof ArrayBuffer) {
      this.handleAudioChunk(event.data);
      return;
    }

    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(String(event.data));
    } catch {
      console.warn('[TTSService] Non-JSON text message:', String(event.data).slice(0, 200));
      return;
    }

    const type = msg['type'] as string;

    switch (type) {
      case 'Flushed': {
        const elapsed = this.speakStartMs > 0
          ? (performance.now() - this.speakStartMs).toFixed(0)
          : '?';
        console.log(
          `[TTSService] Flushed — ${this.flushChunkCount} audio chunks, ` +
          `${this.flushAudioDurationSec.toFixed(2)}s total audio, ` +
          `${elapsed}ms round-trip`
        );
        this.onFlushed?.();
        break;
      }

      case 'Warning':
        console.warn('[TTSService] Warning:', msg);
        break;

      case 'Error':
        console.error('[TTSService] Error:', msg);
        this.onError?.(new Error((msg['description'] as string) ?? 'Deepgram TTS error'));
        break;

      default:
        console.debug(`[TTSService] Message: ${type}`, msg);
        break;
    }
  }

  private chunkCount = 0;

  private handleAudioChunk(buffer: ArrayBuffer): void {
    if (buffer.byteLength === 0) return;

    const pcm16 = new Int16Array(buffer);
    this.onRawAudioData?.(pcm16);
    const float32 = int16ToFloat32(pcm16);
    const chunkDurationSec = pcm16.length / this.opts.sampleRate;

    this.onAudioChunk?.(float32);
    this.schedulePlayback(float32);

    this.chunkCount++;
    this.flushChunkCount++;
    this.flushAudioDurationSec += chunkDurationSec;

    if (this.chunkCount % 10 === 1) {
      console.log(
        `[TTSService] Audio chunk #${this.chunkCount}: ${pcm16.length} samples ` +
        `(${(chunkDurationSec * 1000).toFixed(0)}ms) | ` +
        `flush total: ${this.flushAudioDurationSec.toFixed(2)}s`
      );
    }
  }

  private schedulePlayback(float32: Float32Array): void {
    if (!this.audioCtx) return;

    const audioBuffer = this.audioCtx.createBuffer(1, float32.length, this.opts.sampleRate);
    audioBuffer.copyToChannel(new Float32Array(float32), 0);

    const source = this.audioCtx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(this.audioCtx.destination);

    const now = this.audioCtx.currentTime;
    const startTime = Math.max(now, this.nextPlayTime);
    const gap = startTime - now;
    source.start(startTime);
    this.nextPlayTime = startTime + audioBuffer.duration;

    if (gap > 0.05) {
      console.debug(
        `[TTSService] Playback gap: ${(gap * 1000).toFixed(0)}ms ahead of now ` +
        `(nextPlay=${this.nextPlayTime.toFixed(3)}s)`
      );
    }
  }

  private chunkText(text: string, maxLen: number): string[] {
    if (text.length <= maxLen) return [text];
    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += maxLen) {
      chunks.push(text.slice(i, i + maxLen));
    }
    return chunks;
  }
}
