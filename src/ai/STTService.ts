/**
 * STTService – Deepgram v2 (Flux) streaming speech-to-text.
 *
 * Uses the `/v2/listen` endpoint with the turn-based event model.
 * All server responses are `TurnInfo` messages with an inner `event` field:
 *   StartOfTurn → Update* → EndOfTurn
 *   (optionally: EagerEndOfTurn → TurnResumed if eager threshold is set)
 *
 * Auth uses the `['token', apiKey]` WebSocket subprotocol (browser-safe).
 * Raw WebSocket — zero SDK dependency.
 */

export interface TranscriptEvent {
  text: string;
  isFinal: boolean;
  isInterim: boolean;
  confidence: number;
  turnIndex: number;
}

export interface STTServiceOptions {
  model?: string;
  sampleRate?: number;
  encoding?: string;
  endpoint?: string;
  eotThreshold?: number;
  eagerEotThreshold?: number;
  eotTimeoutMs?: number;
}

export type STTConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error';

export type TurnEvent = 'StartOfTurn' | 'Update' | 'EagerEndOfTurn' | 'TurnResumed' | 'EndOfTurn';

export class STTService {
  private ws: WebSocket | null = null;
  private _state: STTConnectionState = 'disconnected';
  private keepAliveTimer: ReturnType<typeof setInterval> | null = null;
  private connectStartMs = 0;
  private totalTranscripts = 0;
  private totalFinalTranscripts = 0;
  private totalBytesReceived = 0;
  readonly opts: Required<Omit<STTServiceOptions, 'eagerEotThreshold'>> & { eagerEotThreshold?: number };

  onTranscript: ((event: TranscriptEvent) => void) | null = null;
  onStateChange: ((state: STTConnectionState) => void) | null = null;
  onTurnStart: ((turnIndex: number) => void) | null = null;
  onTurnEnd: ((turnIndex: number, confidence: number) => void) | null = null;
  onTurnResumed: ((turnIndex: number) => void) | null = null;
  onError: ((error: Error) => void) | null = null;

  constructor(options?: STTServiceOptions) {
    this.opts = {
      model: options?.model ?? 'flux-general-en',
      sampleRate: options?.sampleRate ?? 16000,
      encoding: options?.encoding ?? 'linear16',
      endpoint: options?.endpoint ?? 'wss://api.deepgram.com/v2/listen',
      eotThreshold: options?.eotThreshold ?? 0.7,
      eotTimeoutMs: options?.eotTimeoutMs ?? 3000,
      eagerEotThreshold: options?.eagerEotThreshold,
    };
  }

  connect(apiKey: string): Promise<void> {
    if (this.ws) this.disconnect();

    return new Promise<void>((resolve, reject) => {
      this.setState('connecting');
      this.connectStartMs = performance.now();

      const params = new URLSearchParams({
        model: this.opts.model,
        encoding: this.opts.encoding,
        sample_rate: String(this.opts.sampleRate),
        eot_threshold: String(this.opts.eotThreshold),
        eot_timeout_ms: String(this.opts.eotTimeoutMs),
      });

      if (this.opts.eagerEotThreshold !== undefined) {
        params.set('eager_eot_threshold', String(this.opts.eagerEotThreshold));
      }

      const url = `${this.opts.endpoint}?${params.toString()}`;
      console.log(`[STTService] Connecting to: ${url.replace(/token.*/, 'token=***')}`);
      console.log(`[STTService] Config: model=${this.opts.model} rate=${this.opts.sampleRate} encoding=${this.opts.encoding} eot=${this.opts.eotThreshold} timeout=${this.opts.eotTimeoutMs}ms`);
      this.ws = new WebSocket(url, ['token', apiKey]);

      this.ws.onopen = () => {
        this.setState('connected');
        this.startKeepAlive();
        const elapsed = (performance.now() - this.connectStartMs).toFixed(0);
        console.log(`[STTService] Connected to Deepgram v2 (${elapsed}ms handshake)`);
        resolve();
      };

      this.ws.onmessage = (event: MessageEvent) => {
        this.handleMessage(event);
      };

      this.ws.onerror = () => {
        const err = new Error('[STTService] WebSocket connection error');
        console.error(err.message);
        this.onError?.(err);
        this.setState('error');
        reject(err);
      };

      this.ws.onclose = (event: CloseEvent) => {
        console.log(
          `[STTService] Closed: code=${event.code} reason=${event.reason} | ` +
          `sent=${this.sendCount} PCMs (${(this.totalBytesReceived / 1024).toFixed(1)}KB), ` +
          `transcripts=${this.totalTranscripts} (${this.totalFinalTranscripts} final)`
        );
        this.stopKeepAlive();
        this.setState('disconnected');
        this.ws = null;
      };
    });
  }

  disconnect(): void {
    if (!this.ws) return;

    this.stopKeepAlive();

    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'CloseStream' }));
    }

    const ws = this.ws;
    this.ws = null;
    setTimeout(() => {
      if (ws.readyState !== WebSocket.CLOSED) ws.close();
    }, 2000);

    this.setState('disconnected');
  }

  private sendCount = 0;

  sendPCM(pcm: ArrayBuffer): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(pcm);
    this.totalBytesReceived += pcm.byteLength;
    this.sendCount++;
    if (this.sendCount % 20 === 1) {
      console.log(
        `[STTService] Sent PCM #${this.sendCount} (${pcm.byteLength} bytes) | ` +
        `total=${(this.totalBytesReceived / 1024).toFixed(1)}KB | ws.readyState=${this.ws.readyState}`
      );
    }
  }

  get state(): STTConnectionState { return this._state; }
  get isConnected(): boolean { return this._state === 'connected'; }

  /**
   * Dynamically reconfigure EOT thresholds on the live WebSocket connection.
   * Uses the Deepgram v2 `Configure` control message (March 2026+).
   * Only sends fields that differ from current opts to avoid no-op messages.
   */
  configure(thresholds: { eotThreshold?: number; eotTimeoutMs?: number }): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.warn('[STTService] Cannot configure — WebSocket not open');
      return false;
    }

    const payload: Record<string, unknown> = { type: 'Configure', thresholds: {} };
    const t = payload['thresholds'] as Record<string, number>;
    let changed = false;

    if (thresholds.eotThreshold !== undefined && thresholds.eotThreshold !== this.opts.eotThreshold) {
      t['eot_threshold'] = thresholds.eotThreshold;
      (this.opts as { eotThreshold: number }).eotThreshold = thresholds.eotThreshold;
      changed = true;
    }
    if (thresholds.eotTimeoutMs !== undefined && thresholds.eotTimeoutMs !== this.opts.eotTimeoutMs) {
      t['eot_timeout_ms'] = thresholds.eotTimeoutMs;
      (this.opts as { eotTimeoutMs: number }).eotTimeoutMs = thresholds.eotTimeoutMs;
      changed = true;
    }

    if (!changed) return false;

    console.log(`[STTService] Sending Configure: eot_threshold=${t['eot_threshold'] ?? '(unchanged)'}, eot_timeout_ms=${t['eot_timeout_ms'] ?? '(unchanged)'}`);
    this.ws.send(JSON.stringify(payload));
    return true;
  }

  private setState(state: STTConnectionState): void {
    const prev = this._state;
    this._state = state;
    if (prev !== state) {
      console.log(`[STTService] State: ${prev} → ${state}`);
    }
    this.onStateChange?.(state);
  }

  // v2 has NO KeepAlive message (only CloseStream and Configure are valid).
  // The connection stays alive as long as audio frames are being sent.
  // Sending silence PCM frames during gaps is the v2 keep-alive pattern.
  private startKeepAlive(): void {
    // no-op for v2
  }

  private stopKeepAlive(): void {
    if (this.keepAliveTimer !== null) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }
  }

  /**
   * v2 server messages have a top-level `type` field:
   *   - `Connected`        → handshake confirmation
   *   - `TurnInfo`         → all transcript/turn events (inner `event` field)
   *   - `ConfigureSuccess` → response to Configure message
   *   - `Error`            → fatal error
   */
  private handleMessage(event: MessageEvent): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(String(event.data));
    } catch {
      console.warn('[STTService] Non-JSON message:', String(event.data).slice(0, 200));
      return;
    }

    const type = msg['type'] as string;
    console.log(`[STTService] ← ${type}${type === 'TurnInfo' ? '.' + (msg['event'] as string) : ''} | seq=${msg['sequence_id'] ?? '?'}`, msg);

    switch (type) {
      case 'Connected':
        console.log(`[STTService] Session: ${msg['request_id']}`);
        break;

      case 'TurnInfo':
        this.handleTurnInfo(msg);
        break;

      case 'Error':
        console.error('[STTService] Deepgram error:', msg);
        this.onError?.(new Error((msg['description'] as string) ?? 'Unknown Deepgram error'));
        break;

      case 'ConfigureSuccess':
        console.log('[STTService] Configure accepted:', msg);
        break;

      default:
        console.debug(`[STTService] Unhandled type: ${type}`);
        break;
    }
  }

  private handleTurnInfo(msg: Record<string, unknown>): void {
    const turnEvent = msg['event'] as TurnEvent;
    const turnIndex = (msg['turn_index'] as number) ?? 0;
    const transcript = (msg['transcript'] as string) ?? '';
    const eotConfidence = (msg['end_of_turn_confidence'] as number) ?? 0;

    switch (turnEvent) {
      case 'StartOfTurn':
        this.onTurnStart?.(turnIndex);
        break;

      case 'Update':
        if (transcript.length > 0) {
          this.totalTranscripts++;
          console.log(`[STTService] interim #${this.totalTranscripts}: "${transcript}" (eot=${eotConfidence.toFixed(2)})`);
          this.onTranscript?.({
            text: transcript,
            isFinal: false,
            isInterim: true,
            confidence: eotConfidence,
            turnIndex,
          });
        }
        break;

      case 'EagerEndOfTurn':
        if (transcript.length > 0) {
          this.onTranscript?.({
            text: transcript,
            isFinal: false,
            isInterim: true,
            confidence: eotConfidence,
            turnIndex,
          });
        }
        break;

      case 'TurnResumed':
        console.log(`[STTService] TurnResumed: turn=${turnIndex} — user continued speaking`);
        this.onTurnResumed?.(turnIndex);
        break;

      case 'EndOfTurn':
        if (transcript.length > 0) {
          this.totalTranscripts++;
          this.totalFinalTranscripts++;
          console.log(
            `[STTService] FINAL #${this.totalFinalTranscripts}: "${transcript}" ` +
            `(eot=${eotConfidence.toFixed(2)}, turn=${turnIndex})`
          );
          this.onTranscript?.({
            text: transcript,
            isFinal: true,
            isInterim: false,
            confidence: eotConfidence,
            turnIndex,
          });
        }
        this.onTurnEnd?.(turnIndex, eotConfidence);
        break;
    }
  }
}
