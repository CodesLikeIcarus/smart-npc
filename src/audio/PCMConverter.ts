/**
 * PCMConverter – audio format conversion utilities for the STT/TTS pipeline.
 *
 * The MVRP audio stream delivers Float32 at 24 kHz (mono or interleaved
 * stereo — auto-detected at runtime).  Cloud STT services require mono
 * Int16 PCM at 16 kHz.  This module bridges the gap and includes AGC
 * to normalize the very quiet MVRP decode-stage output.
 */

// ─── Inbound (MVRP → STT) ──────────────────────────────────────────────────

/**
 * Down-mix interleaved stereo Float32 samples to mono by averaging L+R pairs.
 *
 * @param stereo  Interleaved stereo samples [L0, R0, L1, R1, …].
 * @returns       Mono samples (half the length of the input).
 */
export function stereoToMono(stereo: Float32Array): Float32Array {
  const frames = stereo.length >>> 1;           // integer divide by 2
  const mono = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    mono[i] = (stereo[i * 2]! + stereo[i * 2 + 1]!) * 0.5;
  }
  return mono;
}

/**
 * Downsample a Float32 buffer from `srcRate` to `dstRate` using nearest-sample
 * decimation.  Good enough for speech; a proper polyphase filter is overkill
 * for a hackathon.
 *
 * @param buf      Source samples (mono Float32).
 * @param srcRate  Source sample rate in Hz (e.g. 48 000).
 * @param dstRate  Target sample rate in Hz (e.g. 16 000).
 * @returns        Resampled buffer at `dstRate`.
 */
export function downsample(buf: Float32Array, srcRate: number, dstRate: number): Float32Array {
  if (srcRate === dstRate) return buf;
  const ratio = srcRate / dstRate;
  const outLen = Math.floor(buf.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    out[i] = buf[Math.floor(i * ratio)]!;
  }
  return out;
}

/**
 * Convert normalised Float32 samples (range −1 … +1) to signed 16-bit
 * little-endian integers, which is the format every cloud STT service expects.
 *
 * @param buf  Mono Float32 samples, normalised.
 * @returns    Int16Array suitable for binary WebSocket frames or WAV encoding.
 */
export function float32ToInt16(buf: Float32Array): Int16Array {
  const out = new Int16Array(buf.length);
  for (let i = 0; i < buf.length; i++) {
    const s = Math.max(-1, Math.min(1, buf[i]!));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
  }
  return out;
}

/**
 * Automatic Gain Control — normalizes audio amplitude to a target RMS level.
 * Operates in-place on the provided buffer.
 *
 * @param samples    Mono Float32 samples to normalize (modified in-place).
 * @param targetRMS  Desired RMS amplitude (0.15 ≈ conversational speech level).
 * @param maxGain    Maximum gain multiplier to prevent noise explosion.
 * @param silenceRMS Frames below this RMS are treated as silence (no gain applied).
 */
export function applyAGC(
  samples: Float32Array,
  targetRMS = 0.15,
  maxGain = 50,
  silenceRMS = 0.0005,
): void {
  let sumSq = 0;
  let validCount = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i]!;
    if (!Number.isFinite(v)) continue;
    sumSq += v * v;
    validCount++;
  }
  if (validCount === 0) return;

  const rms = Math.sqrt(sumSq / validCount);
  if (rms < silenceRMS) return;

  const gain = Math.min(targetRMS / rms, maxGain);
  for (let i = 0; i < samples.length; i++) {
    samples[i]! *= gain;
  }
}

export function prepareForSTT(
  input: Float32Array,
  targetRate = 16000,
  srcRate = 48000,
  gain = 1.0,
  isMono = false,
): ArrayBuffer {
  const mono = isMono ? input : stereoToMono(input);
  const resampled = downsample(mono, srcRate, targetRate);

  if (gain !== 1.0) {
    for (let i = 0; i < resampled.length; i++) {
      resampled[i]! *= gain;
    }
  }

  applyAGC(resampled);

  return float32ToInt16(resampled).buffer as ArrayBuffer;
}

// ─── Outbound (TTS → MVRP) ─────────────────────────────────────────────────

/**
 * Upsample a Float32 buffer to 48 kHz using linear interpolation.
 * Used to convert TTS output (typically 24 kHz) to the sample rate the MVRP
 * UPDATE payload expects.
 *
 * @param input    Source samples (mono Float32).
 * @param srcRate  Source sample rate in Hz (e.g. 24 000).
 * @returns        Float32Array at 48 000 Hz.
 */
export function resampleTo48k(input: Float32Array, srcRate: number): Float32Array {
  if (srcRate === 48000) return input;
  const ratio = 48000 / srcRate;
  const outLen = Math.ceil(input.length * ratio);
  const output = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const srcIdx = i / ratio;
    const lo = Math.floor(srcIdx);
    const hi = Math.min(lo + 1, input.length - 1);
    const t = srcIdx - lo;
    output[i] = input[lo]! * (1 - t) + input[hi]! * t;
  }
  return output;
}

/**
 * Convert signed 16-bit PCM (as received from a TTS service) to normalised
 * Float32 suitable for Web Audio API playback.
 *
 * @param int16  Raw Int16 PCM samples.
 * @returns      Float32Array in the range −1 … +1.
 */
export function int16ToFloat32(int16: Int16Array): Float32Array {
  const out = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) {
    out[i] = int16[i]! / 32768.0;
  }
  return out;
}
