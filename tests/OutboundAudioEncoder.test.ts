import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  OutboundAudioEncoder,
  MVRP_RATE,
  SAMPLES_PER_SLICE,
  BYTES_PER_SLICE,
  CODEC_PCM16,
} from '../src/audio/OutboundAudioEncoder.js';

describe('OutboundAudioEncoder constants', () => {
  it('has correct MVRP audio parameters', () => {
    expect(MVRP_RATE).toBe(24000);
    expect(SAMPLES_PER_SLICE).toBe(375);
    expect(BYTES_PER_SLICE).toBe(750);
    expect(CODEC_PCM16).toBe(0);
    expect(MVRP_RATE / 64).toBe(SAMPLES_PER_SLICE);
    expect(SAMPLES_PER_SLICE * 2).toBe(BYTES_PER_SLICE);
  });
});

describe('OutboundAudioEncoder constructor', () => {
  it('initialises with zero buffered samples', () => {
    const enc = new OutboundAudioEncoder();
    expect(enc.available).toBe(0);
  });

  it('accepts custom buffer duration', () => {
    const enc = new OutboundAudioEncoder(1);
    expect(enc.available).toBe(0);
  });
});

describe('pushAudio — same rate (24 kHz)', () => {
  it('buffers samples at native rate without resampling', () => {
    const enc = new OutboundAudioEncoder();
    const samples = new Int16Array(100);
    samples.fill(1234);

    enc.pushAudio(samples, MVRP_RATE);
    expect(enc.available).toBe(100);
  });

  it('accumulates multiple pushes', () => {
    const enc = new OutboundAudioEncoder();
    enc.pushAudio(new Int16Array(200), MVRP_RATE);
    enc.pushAudio(new Int16Array(300), MVRP_RATE);
    expect(enc.available).toBe(500);
  });
});

describe('pushAudio — resampling 48 kHz → 24 kHz', () => {
  it('halves the sample count for 2:1 decimation', () => {
    const enc = new OutboundAudioEncoder();
    const samples48k = new Int16Array(960);
    enc.pushAudio(samples48k, 48000);
    expect(enc.available).toBe(480);
  });

  it('preserves sample values at even indices (2:1 pick)', () => {
    const enc = new OutboundAudioEncoder();
    const input = new Int16Array([100, 200, 300, 400, 500, 600]);
    enc.pushAudio(input, 48000);
    expect(enc.available).toBe(3);

    // Push enough to drain a slice — fill up to 375
    enc.pushAudio(new Int16Array(375 - 3), MVRP_RATE);
    const slice = enc.drainSlice();
    expect(slice).not.toBeNull();

    // First 3 samples should be the even-index picks: 100, 300, 500
    const view = new Int16Array(slice!.abData.buffer, slice!.abData.byteOffset, 3);
    expect(view[0]).toBe(100);
    expect(view[1]).toBe(300);
    expect(view[2]).toBe(500);
  });

  it('handles non-integer ratio resampling', () => {
    const enc = new OutboundAudioEncoder();
    const samples16k = new Int16Array(1600);
    enc.pushAudio(samples16k, 16000);
    // 16kHz → 24kHz: ratio = 16000/24000 = 0.667, outLen = floor(1600/0.667) = 2400
    expect(enc.available).toBe(2400);
  });
});

describe('drainSlice', () => {
  it('returns null when fewer than 375 samples buffered', () => {
    const enc = new OutboundAudioEncoder();
    enc.pushAudio(new Int16Array(374), MVRP_RATE);
    expect(enc.drainSlice()).toBeNull();
  });

  it('returns a valid AudioSlice with exactly 375 samples', () => {
    const enc = new OutboundAudioEncoder();
    enc.pushAudio(new Int16Array(SAMPLES_PER_SLICE), MVRP_RATE);
    const slice = enc.drainSlice();

    expect(slice).not.toBeNull();
    expect(slice!.wSamples).toBe(SAMPLES_PER_SLICE);
    expect(slice!.wCodec).toBe(CODEC_PCM16);
    expect(slice!.wSize).toBe(BYTES_PER_SLICE);
    expect(slice!.abData).toBeInstanceOf(Uint8Array);
    expect(slice!.abData.byteLength).toBe(BYTES_PER_SLICE);
  });

  it('drains multiple slices sequentially', () => {
    const enc = new OutboundAudioEncoder();
    enc.pushAudio(new Int16Array(SAMPLES_PER_SLICE * 3), MVRP_RATE);

    const s1 = enc.drainSlice();
    const s2 = enc.drainSlice();
    const s3 = enc.drainSlice();
    const s4 = enc.drainSlice();

    expect(s1).not.toBeNull();
    expect(s2).not.toBeNull();
    expect(s3).not.toBeNull();
    expect(s4).toBeNull();
    expect(enc.available).toBe(0);
  });

  it('preserves audio data fidelity in sliced output', () => {
    const enc = new OutboundAudioEncoder();
    const input = new Int16Array(SAMPLES_PER_SLICE);
    for (let i = 0; i < SAMPLES_PER_SLICE; i++) {
      input[i] = (i * 7) % 32767;
    }

    enc.pushAudio(input, MVRP_RATE);
    const slice = enc.drainSlice()!;

    const output = new Int16Array(
      slice.abData.buffer, slice.abData.byteOffset, SAMPLES_PER_SLICE
    );
    for (let i = 0; i < SAMPLES_PER_SLICE; i++) {
      expect(output[i]).toBe(input[i]);
    }
  });

  it('reduces available count after drain', () => {
    const enc = new OutboundAudioEncoder();
    enc.pushAudio(new Int16Array(1000), MVRP_RATE);
    expect(enc.available).toBe(1000);

    enc.drainSlice();
    expect(enc.available).toBe(625);

    enc.drainSlice();
    expect(enc.available).toBe(250);
  });
});

describe('buffer overrun handling', () => {
  it('drops oldest samples when buffer is full', () => {
    const enc = new OutboundAudioEncoder(0.1); // ~2400 sample capacity
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Fill beyond capacity
    enc.pushAudio(new Int16Array(2400), MVRP_RATE);
    enc.pushAudio(new Int16Array(1000), MVRP_RATE);

    expect(warnSpy).toHaveBeenCalled();
    expect(enc.diagnostics.overruns).toBeGreaterThan(0);

    warnSpy.mockRestore();
  });

  it('still produces valid slices after overrun', () => {
    const enc = new OutboundAudioEncoder(0.1);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});

    enc.pushAudio(new Int16Array(2400), MVRP_RATE);
    enc.pushAudio(new Int16Array(1000), MVRP_RATE);

    const slice = enc.drainSlice();
    expect(slice).not.toBeNull();
    expect(slice!.wSamples).toBe(SAMPLES_PER_SLICE);
    expect(slice!.abData.byteLength).toBe(BYTES_PER_SLICE);

    vi.restoreAllMocks();
  });
});

describe('reset', () => {
  it('clears all buffered data', () => {
    const enc = new OutboundAudioEncoder();
    vi.spyOn(console, 'log').mockImplementation(() => {});

    enc.pushAudio(new Int16Array(1000), MVRP_RATE);
    expect(enc.available).toBe(1000);

    enc.reset();
    expect(enc.available).toBe(0);
    expect(enc.drainSlice()).toBeNull();

    vi.restoreAllMocks();
  });

  it('resets diagnostic counters', () => {
    const enc = new OutboundAudioEncoder();
    vi.spyOn(console, 'log').mockImplementation(() => {});

    enc.pushAudio(new Int16Array(SAMPLES_PER_SLICE), MVRP_RATE);
    enc.drainSlice();

    enc.reset();
    const diag = enc.diagnostics;
    expect(diag.totalPushed).toBe(0);
    expect(diag.totalDrained).toBe(0);
    expect(diag.overruns).toBe(0);
    expect(diag.buffered).toBe(0);

    vi.restoreAllMocks();
  });
});

describe('diagnostics', () => {
  it('tracks push and drain counts', () => {
    const enc = new OutboundAudioEncoder();
    vi.spyOn(console, 'log').mockImplementation(() => {});

    enc.pushAudio(new Int16Array(SAMPLES_PER_SLICE * 2), MVRP_RATE);
    enc.drainSlice();
    enc.drainSlice();

    const diag = enc.diagnostics;
    expect(diag.totalPushed).toBe(SAMPLES_PER_SLICE * 2);
    expect(diag.totalDrained).toBe(2);
    expect(diag.buffered).toBe(0);

    vi.restoreAllMocks();
  });
});

describe('compact (internal)', () => {
  it('handles push after many drains (compaction triggers)', () => {
    const enc = new OutboundAudioEncoder(1); // 24000 capacity
    vi.spyOn(console, 'log').mockImplementation(() => {});

    // Fill and drain repeatedly to advance readPos near capacity
    for (let i = 0; i < 60; i++) {
      enc.pushAudio(new Int16Array(SAMPLES_PER_SLICE), MVRP_RATE);
      enc.drainSlice();
    }
    expect(enc.available).toBe(0);

    // This push should trigger compaction and succeed
    enc.pushAudio(new Int16Array(SAMPLES_PER_SLICE), MVRP_RATE);
    expect(enc.available).toBe(SAMPLES_PER_SLICE);

    const slice = enc.drainSlice();
    expect(slice).not.toBeNull();

    vi.restoreAllMocks();
  });
});

describe('end-to-end: TTS 48kHz → MVRP slice', () => {
  it('produces correct slices from typical TTS chunk', () => {
    const enc = new OutboundAudioEncoder();
    vi.spyOn(console, 'log').mockImplementation(() => {});

    // Deepgram TTS sends ~1920 samples at 48kHz (40ms chunks)
    const ttsChunk = new Int16Array(1920);
    for (let i = 0; i < 1920; i++) {
      ttsChunk[i] = Math.round(Math.sin(i * 0.1) * 16000);
    }

    enc.pushAudio(ttsChunk, 48000);
    // 1920 / 2 = 960 samples at 24kHz
    expect(enc.available).toBe(960);

    // Should produce 2 full slices (375 * 2 = 750) with 210 remaining
    const s1 = enc.drainSlice();
    const s2 = enc.drainSlice();
    const s3 = enc.drainSlice();

    expect(s1).not.toBeNull();
    expect(s2).not.toBeNull();
    expect(s3).toBeNull();
    expect(enc.available).toBe(210);

    vi.restoreAllMocks();
  });
});
