import { describe, it, expect } from 'vitest';
import {
  stereoToMono,
  downsample,
  float32ToInt16,
  prepareForSTT,
  resampleTo48k,
  int16ToFloat32,
  applyAGC,
} from '../src/audio/PCMConverter.js';

describe('stereoToMono', () => {
  it('averages L+R pairs into mono samples', () => {
    const stereo = new Float32Array([0.5, 0.3, -0.2, 0.4, 1.0, -1.0]);
    const mono = stereoToMono(stereo);

    expect(mono.length).toBe(3);
    expect(mono[0]).toBeCloseTo(0.4);
    expect(mono[1]).toBeCloseTo(0.1);
    expect(mono[2]).toBeCloseTo(0.0);
  });

  it('returns empty array for empty input', () => {
    const mono = stereoToMono(new Float32Array(0));
    expect(mono.length).toBe(0);
  });

  it('handles identical L+R channels', () => {
    const stereo = new Float32Array([0.7, 0.7, -0.3, -0.3]);
    const mono = stereoToMono(stereo);

    expect(mono[0]).toBeCloseTo(0.7);
    expect(mono[1]).toBeCloseTo(-0.3);
  });
});

describe('downsample', () => {
  it('returns same buffer when rates are equal', () => {
    const buf = new Float32Array([0.1, 0.2, 0.3]);
    const result = downsample(buf, 16000, 16000);
    expect(result).toBe(buf);
  });

  it('reduces sample count by rate ratio (48k → 16k = 3:1)', () => {
    const buf = new Float32Array(4800);
    for (let i = 0; i < buf.length; i++) buf[i] = Math.sin(i * 0.01);

    const result = downsample(buf, 48000, 16000);
    expect(result.length).toBe(1600);
  });

  it('preserves first sample value', () => {
    const buf = new Float32Array([0.42, 0.0, 0.0, 0.0, 0.0, 0.0]);
    const result = downsample(buf, 48000, 16000);
    expect(result[0]).toBeCloseTo(0.42);
  });
});

describe('float32ToInt16', () => {
  it('maps 1.0 to Int16 max (32767)', () => {
    const result = float32ToInt16(new Float32Array([1.0]));
    expect(result[0]).toBe(32767);
  });

  it('maps -1.0 to Int16 min (-32768)', () => {
    const result = float32ToInt16(new Float32Array([-1.0]));
    expect(result[0]).toBe(-32768);
  });

  it('maps 0.0 to 0', () => {
    const result = float32ToInt16(new Float32Array([0.0]));
    expect(result[0]).toBe(0);
  });

  it('clamps values beyond ±1', () => {
    const result = float32ToInt16(new Float32Array([2.0, -5.0]));
    expect(result[0]).toBe(32767);
    expect(result[1]).toBe(-32768);
  });
});

describe('int16ToFloat32', () => {
  it('maps 32767 back to ~1.0', () => {
    const result = int16ToFloat32(new Int16Array([32767]));
    expect(result[0]).toBeCloseTo(1.0, 3);
  });

  it('maps -32768 back to -1.0', () => {
    const result = int16ToFloat32(new Int16Array([-32768]));
    expect(result[0]).toBeCloseTo(-1.0, 3);
  });

  it('maps 0 back to 0.0', () => {
    const result = int16ToFloat32(new Int16Array([0]));
    expect(result[0]).toBe(0.0);
  });
});

describe('prepareForSTT', () => {
  it('converts stereo 48kHz Float32 → mono 16kHz Int16 ArrayBuffer', () => {
    const stereo48k = new Float32Array(9600);
    for (let i = 0; i < stereo48k.length; i++) {
      stereo48k[i] = Math.sin(i * 0.05) * 0.5;
    }

    const result = prepareForSTT(stereo48k, 16000);

    expect(result).toBeInstanceOf(ArrayBuffer);

    const int16View = new Int16Array(result);
    expect(int16View.length).toBe(1600);
  });

  it('produces non-zero output for non-silent input', () => {
    const stereo48k = new Float32Array(960);
    for (let i = 0; i < stereo48k.length; i++) stereo48k[i] = 0.8;

    const result = prepareForSTT(stereo48k, 16000);
    const int16View = new Int16Array(result);

    const hasNonZero = Array.from(int16View).some(v => v !== 0);
    expect(hasNonZero).toBe(true);
  });

  it('defaults to 16kHz target rate', () => {
    const stereo48k = new Float32Array(960);
    const result16k = prepareForSTT(stereo48k, 16000);
    const resultDefault = prepareForSTT(stereo48k);

    expect(new Int16Array(result16k).length).toBe(new Int16Array(resultDefault).length);
  });
});

describe('resampleTo48k', () => {
  it('returns same buffer when already 48kHz', () => {
    const buf = new Float32Array([0.1, 0.2]);
    const result = resampleTo48k(buf, 48000);
    expect(result).toBe(buf);
  });

  it('doubles length for 24kHz → 48kHz', () => {
    const buf = new Float32Array(2400);
    for (let i = 0; i < buf.length; i++) buf[i] = Math.sin(i * 0.02);

    const result = resampleTo48k(buf, 24000);
    expect(result.length).toBe(4800);
  });

  it('triples length for 16kHz → 48kHz', () => {
    const buf = new Float32Array(1600);
    const result = resampleTo48k(buf, 16000);
    expect(result.length).toBe(4800);
  });

  it('preserves first and last sample values approximately', () => {
    const buf = new Float32Array([0.5, 0.3, -0.1, 0.8]);
    const result = resampleTo48k(buf, 16000);
    expect(result[0]).toBeCloseTo(0.5, 2);
    expect(result[result.length - 1]).toBeCloseTo(0.8, 2);
  });
});

describe('applyAGC', () => {
  it('normalizes quiet audio to target RMS', () => {
    const samples = new Float32Array(1000);
    for (let i = 0; i < samples.length; i++) samples[i] = Math.sin(i * 0.1) * 0.01;

    const rmsBefore = Math.sqrt(samples.reduce((s, v) => s + v * v, 0) / samples.length);
    expect(rmsBefore).toBeLessThan(0.01);

    applyAGC(samples, 0.15, 50, 0.0005);

    const rmsAfter = Math.sqrt(samples.reduce((s, v) => s + v * v, 0) / samples.length);
    expect(rmsAfter).toBeCloseTo(0.15, 1);
  });

  it('does not modify silence (below silenceRMS threshold)', () => {
    const samples = new Float32Array(100);
    for (let i = 0; i < samples.length; i++) samples[i] = 0.0001;

    const before = Array.from(samples);
    applyAGC(samples, 0.15, 50, 0.001);

    for (let i = 0; i < samples.length; i++) {
      expect(samples[i]).toBe(before[i]);
    }
  });

  it('caps gain at maxGain to prevent noise explosion', () => {
    const samples = new Float32Array(1000);
    for (let i = 0; i < samples.length; i++) samples[i] = Math.sin(i * 0.1) * 0.001;

    applyAGC(samples, 0.15, 10, 0.0001);

    let peak = 0;
    for (let i = 0; i < samples.length; i++) {
      const abs = Math.abs(samples[i]!);
      if (abs > peak) peak = abs;
    }
    expect(peak).toBeLessThanOrEqual(0.011);
  });

  it('handles empty array without error', () => {
    const samples = new Float32Array(0);
    expect(() => applyAGC(samples)).not.toThrow();
  });

  it('handles NaN values gracefully', () => {
    const samples = new Float32Array([0.1, NaN, 0.1, NaN, 0.1]);
    expect(() => applyAGC(samples)).not.toThrow();
  });

  it('does not amplify already-loud audio excessively', () => {
    const samples = new Float32Array(1000);
    for (let i = 0; i < samples.length; i++) samples[i] = Math.sin(i * 0.1) * 0.5;

    applyAGC(samples, 0.15, 50, 0.0005);

    const rmsAfter = Math.sqrt(samples.reduce((s, v) => s + v * v, 0) / samples.length);
    expect(rmsAfter).toBeCloseTo(0.15, 1);
  });
});

describe('prepareForSTT with isMono', () => {
  it('skips stereoToMono when isMono=true', () => {
    const mono24k = new Float32Array(240);
    for (let i = 0; i < mono24k.length; i++) mono24k[i] = Math.sin(i * 0.1) * 0.5;

    const result = prepareForSTT(mono24k, 16000, 24000, 1.0, true);
    const int16View = new Int16Array(result);

    expect(int16View.length).toBe(160);

    const hasNonZero = Array.from(int16View).some(v => v !== 0);
    expect(hasNonZero).toBe(true);
  });

  it('applies stereoToMono when isMono=false (default)', () => {
    const stereo24k = new Float32Array(480);
    for (let i = 0; i < stereo24k.length; i++) stereo24k[i] = Math.sin(i * 0.1) * 0.5;

    const result = prepareForSTT(stereo24k, 16000, 24000, 1.0, false);
    const int16View = new Int16Array(result);

    expect(int16View.length).toBe(160);
  });

  it('mono passthrough preserves more amplitude than stereo with zeros', () => {
    const monoSamples = new Float32Array(480);
    for (let i = 0; i < 240; i++) {
      monoSamples[i * 2] = Math.sin(i * 0.1) * 0.05;
      monoSamples[i * 2 + 1] = 0;
    }

    const stereoResult = prepareForSTT(monoSamples, 16000, 24000, 1.0, false);
    const stereoView = new Int16Array(stereoResult);
    const stereoMaxAbs = Math.max(...Array.from(stereoView).map(Math.abs));

    const monoOnly = new Float32Array(240);
    for (let i = 0; i < 240; i++) monoOnly[i] = Math.sin(i * 0.1) * 0.05;

    const monoResult = prepareForSTT(monoOnly, 16000, 24000, 1.0, true);
    const monoView = new Int16Array(monoResult);
    const monoMaxAbs = Math.max(...Array.from(monoView).map(Math.abs));

    expect(monoMaxAbs).toBeGreaterThanOrEqual(stereoMaxAbs);
  });
});

describe('round-trip: float32 → int16 → float32', () => {
  it('reconstructs original values within quantization error', () => {
    const original = new Float32Array([0.0, 0.5, -0.5, 0.99, -0.99]);
    const int16 = float32ToInt16(original);
    const recovered = int16ToFloat32(int16);

    for (let i = 0; i < original.length; i++) {
      expect(recovered[i]).toBeCloseTo(original[i], 3);
    }
  });
});
