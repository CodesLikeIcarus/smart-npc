/**
 * Metadata snapshot returned by `AudioFrameBuffer.info`.
 */
export interface AudioFrameBufferInfo {
  /** Sample rate of the buffered audio (Hz). */
  sampleRate: number;
  /** Number of interleaved channels (1 = mono, 2 = stereo). */
  channelCount: number;
  /** Total capacity of the ring buffer in samples. */
  capacity: number;
  /** Number of samples currently available for reading. */
  available: number;
}

/**
 * AudioFrameBuffer – a fixed-capacity lock-free ring buffer for decoded PCM
 * audio samples.
 *
 * Designed for single-threaded (JavaScript main-thread) use.  Samples are
 * stored as Float32 values; callers are responsible for normalising raw int16
 * data to the range −1 … +1 before writing if normalised values are needed.
 *
 * When the buffer is full and new samples arrive, the oldest samples are
 * silently overwritten so that latency stays bounded.
 *
 * Usage
 * ─────
 *   const buf = new AudioFrameBuffer(48000 * 2 * 4, 48000, 2); // 4 s stereo
 *   buf.write(newSamples);        // append decoded frame
 *   const out = new Float32Array(960 * 2);
 *   const n = buf.read(out);      // consume up to 1 frame
 */
export class AudioFrameBuffer {
  private readonly data: Float32Array;
  private head: number = 0;   // next read position
  private tail: number = 0;   // next write position
  private count: number = 0;  // samples currently in buffer

  /** Sample rate of the audio held in this buffer (Hz). */
  readonly sampleRate: number;

  /** Number of interleaved channels stored in this buffer. */
  readonly channelCount: number;

  /**
   * @param capacity     Total number of samples the ring buffer can hold.
   *                     Must be a positive integer.
   * @param sampleRate   Sample rate in Hz.  Default: 48000.
   * @param channelCount Number of interleaved channels.  Default: 2 (stereo).
   */
  constructor(capacity: number, sampleRate = 48000, channelCount = 2) {
    if (capacity <= 0 || !Number.isInteger(capacity)) {
      throw new RangeError('[AudioFrameBuffer] capacity must be a positive integer');
    }
    this.data = new Float32Array(capacity);
    this.sampleRate = sampleRate;
    this.channelCount = channelCount;
  }

  // ─── Properties ───────────────────────────────────────────────────────────

  /** Total capacity of the ring buffer in samples. */
  get capacity(): number {
    return this.data.length;
  }

  /** Number of samples currently available for reading. */
  get available(): number {
    return this.count;
  }

  // ─── Write ────────────────────────────────────────────────────────────────

  /**
   * Append `length` samples from `samples` starting at `offset` into the
   * ring buffer.  When the buffer is full the oldest samples are overwritten.
   *
   * @param samples  Source sample array (any numeric array-like type).
   * @param offset   Index in `samples` to start reading from.  Default: 0.
   * @param length   Number of samples to copy.  Defaults to
   *                 `samples.length - offset`.
   */
  write(samples: ArrayLike<number>, offset = 0, length?: number): void {
    const len = length ?? (samples.length - offset);
    const cap = this.data.length;

    for (let i = 0; i < len; i++) {
      this.data[this.tail] = samples[offset + i] as number;
      this.tail = (this.tail + 1) % cap;

      if (this.count < cap) {
        this.count++;
      } else {
        // Buffer full – advance head to discard oldest sample.
        this.head = (this.head + 1) % cap;
      }
    }
  }

  // ─── Read ─────────────────────────────────────────────────────────────────

  /**
   * Copy up to `out.length` (or `length`) samples out of the ring buffer into
   * `out`, consuming them.
   *
   * @param out     Destination typed array.
   * @param length  Maximum samples to read.  Defaults to `out.length`.
   * @returns       Actual number of samples copied.
   */
  read(out: Float32Array, length?: number): number {
    const len = Math.min(length ?? out.length, this.count);
    const cap = this.data.length;

    for (let i = 0; i < len; i++) {
      out[i] = this.data[this.head] as number;
      this.head = (this.head + 1) % cap;
    }
    this.count -= len;
    return len;
  }

  /**
   * Copy up to `out.length` (or `length`) samples out of the ring buffer
   * without consuming them (non-destructive peek).
   *
   * @param out     Destination typed array.
   * @param length  Maximum samples to peek.  Defaults to `out.length`.
   * @returns       Actual number of samples copied.
   */
  peek(out: Float32Array, length?: number): number {
    const len = Math.min(length ?? out.length, this.count);
    const cap = this.data.length;
    let pos = this.head;

    for (let i = 0; i < len; i++) {
      out[i] = this.data[pos] as number;
      pos = (pos + 1) % cap;
    }
    return len;
  }

  // ─── Utility ──────────────────────────────────────────────────────────────

  /**
   * Discard all buffered samples, resetting the ring buffer to an empty state.
   */
  clear(): void {
    this.head = 0;
    this.tail = 0;
    this.count = 0;
  }

  /**
   * Returns a snapshot of buffer metadata for diagnostics or speech-to-text
   * integration.
   */
  get info(): AudioFrameBufferInfo {
    return {
      sampleRate: this.sampleRate,
      channelCount: this.channelCount,
      capacity: this.capacity,
      available: this.count,
    };
  }
}
