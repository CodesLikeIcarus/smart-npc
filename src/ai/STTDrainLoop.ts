/**
 * STTDrainLoop – periodically drains decoded PCM from an AudioFrameBuffer,
 * converts it to STT-ready format, and ships it to the STTService.
 *
 * The loop runs on a `setInterval` timer (not requestAnimationFrame) so that
 * it continues ticking even when the browser tab is backgrounded — important
 * for a metaverse client where the user may switch to another window while
 * the avatar keeps listening.
 *
 * Lifecycle
 * ─────────
 *   const drain = new STTDrainLoop(audioCapture.buffer, sttService);
 *   drain.start();       // begin draining
 *   …
 *   drain.stop();        // stop draining
 */

import type { AudioFrameBuffer } from '../audio/AudioFrameBuffer.js';
import type { STTService } from './STTService.js';
import { prepareForSTT } from '../audio/PCMConverter.js';

/** Configuration for the drain loop. */
export interface STTDrainLoopOptions {
  /**
   * Drain interval in milliseconds.  Shorter = lower latency but more
   * WebSocket sends.  Default: 100 (10 Hz).
   *
   * At 48 kHz stereo, 100 ms ≈ 9 600 interleaved samples per tick.
   * After conversion to mono 16 kHz this becomes ~1 600 Int16 samples
   * (~3.2 KB per send).  Deepgram handles this easily.
   */
  intervalMs?: number;

  /**
   * Target STT sample rate.  Must match the rate configured on the
   * STTService.  Default: 16 000.
   */
  targetSampleRate?: number;

  /**
   * Minimum number of samples in the ring buffer before a drain is attempted.
   * Prevents sending near-empty frames that waste bandwidth.
   * Default: 960 (one MVRP audio slice, ~10 ms at 48 kHz stereo).
   */
  minSamples?: number;

  /**
   * Gain multiplier applied to audio before AGC.
   * Default: 1.0 (AGC handles normalization now).
   */
  gain?: number;

  /**
   * Source sample rate of the decoded audio from MVRP.
   * Default: 48000, but MVRP typically uses 24000.
   */
  srcSampleRate?: number;

  /**
   * Whether the decoded audio is mono (true) or interleaved stereo (false).
   * When mono, stereoToMono is skipped to avoid halving amplitude.
   * Default: false (stereo).
   */
  isMono?: boolean;
}

export class STTDrainLoop {
  private readonly buffer: AudioFrameBuffer;
  private readonly sttService: STTService;
  private readonly opts: Required<STTDrainLoopOptions>;

  private readBuf: Float32Array;
  private timerId: ReturnType<typeof setInterval> | null = null;
  private _running = false;
  private totalSamplesRead = 0;
  private totalBytesSent = 0;
  private startTimeMs = 0;
  private emptyDrainStreak = 0;

  constructor(
    buffer: AudioFrameBuffer,
    sttService: STTService,
    options?: STTDrainLoopOptions,
  ) {
    this.buffer = buffer;
    this.sttService = sttService;
    this.opts = {
      intervalMs: options?.intervalMs ?? 100,
      targetSampleRate: options?.targetSampleRate ?? 16000,
      minSamples: options?.minSamples ?? 960,
      gain: options?.gain ?? 1.0,
      srcSampleRate: options?.srcSampleRate ?? 48000,
      isMono: options?.isMono ?? false,
    };

    // Pre-allocate a read buffer large enough for one drain interval.
    // At 48 kHz stereo, 100 ms → 9 600 interleaved samples.
    const maxSamplesPerTick = Math.ceil(
      48000 * 2 * (this.opts.intervalMs / 1000),
    );
    this.readBuf = new Float32Array(maxSamplesPerTick);
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────────

  /**
   * Start the drain loop.  Idempotent.
   */
  start(): void {
    if (this._running) return;
    this._running = true;
    this.startTimeMs = performance.now();
    this.drainCount = 0;
    this.totalSamplesRead = 0;
    this.totalBytesSent = 0;
    this.emptyDrainStreak = 0;

    this.timerId = setInterval(() => this.drain(), this.opts.intervalMs);
    console.log(
      `[STTDrainLoop] Started (interval=${this.opts.intervalMs}ms, ` +
      `targetRate=${this.opts.targetSampleRate}Hz, ` +
      `srcRate=${this.opts.srcSampleRate}Hz, mono=${this.opts.isMono})`,
    );
  }

  /**
   * Stop the drain loop.  Idempotent.
   */
  stop(): void {
    if (!this._running) return;
    this._running = false;

    if (this.timerId !== null) {
      clearInterval(this.timerId);
      this.timerId = null;
    }

    const elapsedSec = (performance.now() - this.startTimeMs) / 1000;
    console.log(
      `[STTDrainLoop] Stopped after ${elapsedSec.toFixed(1)}s | ` +
      `drains=${this.drainCount}, samples=${this.totalSamplesRead}, ` +
      `sent=${(this.totalBytesSent / 1024).toFixed(1)}KB`,
    );
  }

  /** `true` while the loop is ticking. */
  get isRunning(): boolean {
    return this._running;
  }

  set isMono(value: boolean) {
    this.opts.isMono = value;
  }

  // ─── Core ───────────────────────────────────────────────────────────────

  /**
   * Single drain tick: read available samples from the ring buffer, convert
   * to the STT format, and send to the STTService.
   */
  private drainCount = 0;

  private drain(): void {
    if (!this.sttService.isConnected) {
      if (this.drainCount % 50 === 0) {
        console.warn('[STTDrainLoop] STT not connected — skipping drain');
      }
      this.drainCount++;
      return;
    }

    const available = this.buffer.available;
    if (available < this.opts.minSamples) {
      this.emptyDrainStreak++;
      if (this.emptyDrainStreak === 50) {
        console.warn(
          `[STTDrainLoop] 50 consecutive empty drains — buffer starved ` +
          `(available=${available}, min=${this.opts.minSamples})`
        );
      }
      this.drainCount++;
      return;
    }

    this.emptyDrainStreak = 0;

    if (available > this.readBuf.length) {
      console.log(`[STTDrainLoop] Expanding read buffer: ${this.readBuf.length} → ${available}`);
      this.readBuf = new Float32Array(available);
    }

    const samplesRead = this.buffer.read(this.readBuf, available);
    if (samplesRead === 0) {
      console.debug('[STTDrainLoop] Read returned 0 samples');
      return;
    }

    const raw = this.readBuf.subarray(0, samplesRead);

    const pcm = prepareForSTT(raw, this.opts.targetSampleRate, this.opts.srcSampleRate, this.opts.gain, this.opts.isMono);
    this.sttService.sendPCM(pcm);

    this.totalSamplesRead += samplesRead;
    this.totalBytesSent += pcm.byteLength;
    this.drainCount++;

    if (this.drainCount % 20 === 0) {
      let peak = 0;
      let sumSq = 0;
      let validCount = 0;
      for (let i = 0; i < samplesRead; i++) {
        const v = raw[i]!;
        if (!Number.isFinite(v)) continue;
        const abs = Math.abs(v);
        if (abs > peak) peak = abs;
        sumSq += v * v;
        validCount++;
      }
      const rms = validCount > 0 ? Math.sqrt(sumSq / validCount) : 0;
      const elapsedSec = (performance.now() - this.startTimeMs) / 1000;
      console.log(
        `[STTDrainLoop] #${this.drainCount} (${elapsedSec.toFixed(1)}s) | ` +
        `read=${samplesRead} avail=${available} | ` +
        `pcm=${pcm.byteLength}B total=${(this.totalBytesSent / 1024).toFixed(1)}KB | ` +
        `peak=${peak.toFixed(4)} rms=${rms.toFixed(4)} | ` +
        `srcRate=${this.opts.srcSampleRate} mono=${this.opts.isMono}`
      );
    }
  }
}
