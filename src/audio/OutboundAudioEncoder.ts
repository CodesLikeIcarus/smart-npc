/**
 * OutboundAudioEncoder – buffers TTS audio and produces MVRP-compatible
 * audio slices for transmission into the metaverse world.
 *
 * Pipeline:
 *   TTS (48 kHz Int16) → resample to 24 kHz → ring buffer → drain 375-sample
 *   slices → PCM16 codec 0 → MVRP UPDATE payload.
 *
 * MVRP audio format:
 *   - Sample rate: 24 000 Hz (mono)
 *   - Slice rate: 64 slices/second (every ~15.625 ms)
 *   - Samples per slice: 375 (24000 / 64)
 *   - Codec 0: raw PCM16 (signed 16-bit little-endian), 750 bytes per slice
 */

// ─── Constants ──────────────────────────────────────────────────────────────

/** MVRP's audio sample rate. */
export const MVRP_RATE = 24000;

/** Number of Int16 samples per MVRP audio slice (24000 Hz / 64 slices/sec). */
export const SAMPLES_PER_SLICE = 375;

/** Byte size of one encoded slice at codec 0 (375 samples × 2 bytes). */
export const BYTES_PER_SLICE = 750;

/** MVRP codec identifier for raw PCM16. */
export const CODEC_PCM16 = 0;

// ─── Types ──────────────────────────────────────────────────────────────────

/** One MVRP-ready audio slice, ready to embed into an UPDATE message. */
export interface AudioSlice {
  /** Number of audio samples in this slice (always 375). */
  wSamples: number;
  /** Codec identifier (0 = raw PCM16). */
  wCodec: number;
  /** Encoded data size in bytes (always 750 for codec 0). */
  wSize: number;
  /** Encoded audio bytes (raw Int16 little-endian). */
  abData: Uint8Array;
}

// ─── Encoder ────────────────────────────────────────────────────────────────

export class OutboundAudioEncoder {
  private buffer: Int16Array;
  private writePos = 0;
  private readPos = 0;
  private readonly capacity: number;

  // Logging / diagnostics
  private totalSamplesPushed = 0;
  private totalSlicesDrained = 0;
  private overrunCount = 0;

  /**
   * @param bufferDurationSec  Ring buffer capacity in seconds of 24 kHz audio.
   *                           Default 5 s = 120 000 samples ≈ 234 KB.
   */
  constructor(bufferDurationSec = 5) {
    this.capacity = Math.ceil(MVRP_RATE * bufferDurationSec);
    this.buffer = new Int16Array(this.capacity);
  }

  // ─── Public API ─────────────────────────────────────────────────────────

  /**
   * Push raw Int16 PCM samples into the ring buffer, resampling from
   * `srcRate` to 24 kHz if necessary.
   *
   * @param int16Samples  Raw Int16 PCM samples from the TTS service.
   * @param srcRate       Source sample rate in Hz (e.g. 48 000).
   */
  pushAudio(int16Samples: Int16Array, srcRate: number): void {
    const resampled = srcRate !== MVRP_RATE
      ? this.resampleInt16(int16Samples, srcRate, MVRP_RATE)
      : int16Samples;

    const samplesNeeded = resampled.length;
    const spaceLeft = this.capacity - (this.writePos - this.readPos);

    if (samplesNeeded > spaceLeft) {
      this.overrunCount++;
      if (this.overrunCount <= 5 || this.overrunCount % 50 === 0) {
        console.warn(
          `[OutboundAudioEncoder] Buffer overrun #${this.overrunCount}: ` +
          `need ${samplesNeeded} samples, only ${spaceLeft} available. Dropping oldest.`
        );
      }
      // Advance readPos to make room
      this.readPos = this.writePos - (this.capacity - samplesNeeded);
      if (this.readPos < 0) this.readPos = 0;
    }

    // Compact if writePos would overflow the physical array
    if (this.writePos + samplesNeeded > this.capacity) {
      this.compact();
    }

    this.buffer.set(resampled, this.writePos);
    this.writePos += samplesNeeded;
    this.totalSamplesPushed += samplesNeeded;

    if (this.totalSamplesPushed <= resampled.length) {
      console.log(
        `[OutboundAudioEncoder] First push: ${int16Samples.length} samples @ ${srcRate} Hz ` +
        `→ ${resampled.length} samples @ ${MVRP_RATE} Hz`
      );
    }
  }

  /**
   * Number of buffered samples available for draining.
   */
  get available(): number {
    return this.writePos - this.readPos;
  }

  /**
   * Extract one 375-sample MVRP audio slice from the buffer, or return null
   * if insufficient samples are buffered.
   */
  drainSlice(): AudioSlice | null {
    if (this.available < SAMPLES_PER_SLICE) return null;

    const slice = this.buffer.slice(this.readPos, this.readPos + SAMPLES_PER_SLICE);
    this.readPos += SAMPLES_PER_SLICE;

    // Convert Int16Array to Uint8Array (little-endian, which is native on all
    // modern JS engines — Int16Array already stores in platform byte order,
    // and MVRP expects LE on the wire which matches x86/ARM/WASM).
    const abData = new Uint8Array(slice.buffer, slice.byteOffset, slice.byteLength);

    this.totalSlicesDrained++;

    if (this.totalSlicesDrained === 1) {
      console.log(
        `[OutboundAudioEncoder] First slice drained: ${SAMPLES_PER_SLICE} samples, ` +
        `${BYTES_PER_SLICE} bytes (codec 0 PCM16)`
      );
    } else if (this.totalSlicesDrained % 100 === 0) {
      console.log(
        `[OutboundAudioEncoder] Slices drained: ${this.totalSlicesDrained}, ` +
        `overruns: ${this.overrunCount}, buffered: ${this.available}`
      );
    }

    return {
      wSamples: SAMPLES_PER_SLICE,
      wCodec: CODEC_PCM16,
      wSize: BYTES_PER_SLICE,
      abData,
    };
  }

  /**
   * Clear the ring buffer and reset all counters.
   */
  reset(): void {
    this.writePos = 0;
    this.readPos = 0;
    this.totalSamplesPushed = 0;
    this.totalSlicesDrained = 0;
    this.overrunCount = 0;
    console.log('[OutboundAudioEncoder] Reset');
  }

  /** Total number of samples pushed (after resampling) since creation/reset. */
  get diagnostics(): { totalPushed: number; totalDrained: number; overruns: number; buffered: number } {
    return {
      totalPushed: this.totalSamplesPushed,
      totalDrained: this.totalSlicesDrained,
      overruns: this.overrunCount,
      buffered: this.available,
    };
  }

  // ─── Internal ───────────────────────────────────────────────────────────

  /**
   * Compact the ring buffer by shifting unread data to position 0.
   */
  private compact(): void {
    const unread = this.available;
    if (unread > 0) {
      this.buffer.copyWithin(0, this.readPos, this.writePos);
    }
    this.readPos = 0;
    this.writePos = unread;
  }

  /**
   * Resample Int16 PCM from srcRate to dstRate using nearest-sample decimation.
   * For the 48 kHz → 24 kHz case this is a simple 2:1 decimation (pick every
   * other sample), which is computationally trivial.
   */
  private resampleInt16(input: Int16Array, srcRate: number, dstRate: number): Int16Array {
    if (srcRate === dstRate) return input;

    const ratio = srcRate / dstRate;
    const outLen = Math.floor(input.length / ratio);
    const output = new Int16Array(outLen);

    // Fast path for exact 2:1 decimation (48 kHz → 24 kHz)
    if (ratio === 2) {
      for (let i = 0; i < outLen; i++) {
        output[i] = input[i * 2]!;
      }
      return output;
    }

    // General nearest-sample decimation
    for (let i = 0; i < outLen; i++) {
      output[i] = input[Math.floor(i * ratio)]!;
    }
    return output;
  }
}
