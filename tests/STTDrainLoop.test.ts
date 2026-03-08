import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { STTDrainLoop } from '../src/ai/STTDrainLoop.js';
import type { AudioFrameBuffer } from '../src/audio/AudioFrameBuffer.js';
import type { STTService } from '../src/ai/STTService.js';

function createMockBuffer(availableSamples: number): AudioFrameBuffer {
  return {
    available: availableSamples,
    read(dest: Float32Array, count: number): number {
      const toRead = Math.min(count, availableSamples);
      for (let i = 0; i < toRead; i++) {
        dest[i] = Math.sin(i * 0.01) * 0.5;
      }
      return toRead;
    },
  } as unknown as AudioFrameBuffer;
}

function createMockSTTService(connected: boolean) {
  const sent: ArrayBuffer[] = [];
  return {
    isConnected: connected,
    sendPCM(pcm: ArrayBuffer) { sent.push(pcm); },
    sent,
  } as unknown as STTService & { sent: ArrayBuffer[] };
}

describe('STTDrainLoop lifecycle', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('starts and stops cleanly', () => {
    const buffer = createMockBuffer(0);
    const stt = createMockSTTService(true);
    const drain = new STTDrainLoop(buffer, stt);

    expect(drain.isRunning).toBe(false);

    drain.start();
    expect(drain.isRunning).toBe(true);

    drain.stop();
    expect(drain.isRunning).toBe(false);
  });

  it('is idempotent for start and stop', () => {
    const buffer = createMockBuffer(0);
    const stt = createMockSTTService(true);
    const drain = new STTDrainLoop(buffer, stt);

    drain.start();
    drain.start();
    expect(drain.isRunning).toBe(true);

    drain.stop();
    drain.stop();
    expect(drain.isRunning).toBe(false);
  });
});

describe('STTDrainLoop draining', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('sends PCM data when buffer has samples and STT is connected', () => {
    const buffer = createMockBuffer(9600);
    const stt = createMockSTTService(true);
    const drain = new STTDrainLoop(buffer, stt);

    drain.start();
    vi.advanceTimersByTime(100);

    expect(stt.sent.length).toBeGreaterThan(0);
    expect(stt.sent[0]).toBeInstanceOf(ArrayBuffer);

    drain.stop();
  });

  it('does not send when STT is disconnected', () => {
    const buffer = createMockBuffer(9600);
    const stt = createMockSTTService(false);
    const drain = new STTDrainLoop(buffer, stt);

    drain.start();
    vi.advanceTimersByTime(100);

    expect(stt.sent.length).toBe(0);

    drain.stop();
  });

  it('does not send when buffer has fewer samples than minimum', () => {
    const buffer = createMockBuffer(100);
    const stt = createMockSTTService(true);
    const drain = new STTDrainLoop(buffer, stt, { minSamples: 960 });

    drain.start();
    vi.advanceTimersByTime(100);

    expect(stt.sent.length).toBe(0);

    drain.stop();
  });

  it('drains on each interval tick', () => {
    const buffer = createMockBuffer(9600);
    const stt = createMockSTTService(true);
    const drain = new STTDrainLoop(buffer, stt, { intervalMs: 50 });

    drain.start();
    vi.advanceTimersByTime(200);

    expect(stt.sent.length).toBe(4);

    drain.stop();
  });

  it('converts output to correct size for 16kHz mono Int16', () => {
    const buffer = createMockBuffer(9600);
    const stt = createMockSTTService(true);
    const drain = new STTDrainLoop(buffer, stt, { targetSampleRate: 16000 });

    drain.start();
    vi.advanceTimersByTime(100);

    const sentBuf = stt.sent[0];
    const int16View = new Int16Array(sentBuf);

    // 9600 stereo samples → 4800 mono → 1600 at 16kHz → 1600 Int16 samples
    expect(int16View.length).toBe(1600);

    drain.stop();
  });
});
