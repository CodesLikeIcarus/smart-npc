import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TTSService } from '../src/ai/TTSService.js';

class MockWebSocket {
  static OPEN = 1;
  static CLOSED = 3;
  readyState = MockWebSocket.OPEN;
  binaryType = 'blob';
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  sent: (string | ArrayBuffer)[] = [];

  constructor(public url: string, public protocols?: string | string[]) {}

  send(data: string | ArrayBuffer): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = MockWebSocket.CLOSED;
  }

  simulateOpen(): void {
    this.onopen?.(new Event('open'));
  }

  simulateMessage(data: string | ArrayBuffer): void {
    this.onmessage?.({ data } as MessageEvent);
  }

  simulateError(): void {
    this.onerror?.(new Event('error'));
  }

  simulateClose(code = 1000, reason = ''): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ code, reason } as CloseEvent);
  }
}

let mockWs: MockWebSocket;

beforeEach(() => {
  vi.stubGlobal('WebSocket', class extends MockWebSocket {
    constructor(url: string) {
      super(url);
      mockWs = this;
    }
  });

  vi.stubGlobal('AudioContext', class {
    sampleRate = 48000;
    currentTime = 0;
    createBuffer(channels: number, length: number, rate: number) {
      return {
        duration: length / rate,
        copyToChannel: vi.fn(),
      };
    }
    createBufferSource() {
      return {
        buffer: null,
        connect: vi.fn(),
        start: vi.fn(),
      };
    }
    get destination() { return {}; }
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('TTSService connect', () => {
  it('constructs correct URL and uses subprotocol auth', async () => {
    const tts = new TTSService({ model: 'aura-2-zeus-en', sampleRate: 48000 });
    const p = tts.connect('test-key');
    mockWs.simulateOpen();
    await p;

    expect(mockWs.url).toContain('wss://api.deepgram.com/v1/speak');
    expect(mockWs.url).toContain('model=aura-2-zeus-en');
    expect(mockWs.url).toContain('encoding=linear16');
    expect(mockWs.url).toContain('sample_rate=48000');
    expect(mockWs.url).toContain('container=none');
    expect(mockWs.url).not.toContain('token=');
  });

  it('transitions to connected state on open', async () => {
    const tts = new TTSService();
    const states: string[] = [];
    tts.onStateChange = (s) => states.push(s);

    const p = tts.connect('key');
    expect(tts.state).toBe('connecting');

    mockWs.simulateOpen();
    await p;

    expect(tts.state).toBe('connected');
    expect(tts.isConnected).toBe(true);
    expect(states).toContain('connecting');
    expect(states).toContain('connected');
  });

  it('rejects on WebSocket error', async () => {
    const tts = new TTSService();
    const p = tts.connect('key');
    mockWs.simulateError();

    await expect(p).rejects.toThrow('WebSocket connection error');
    expect(tts.state).toBe('error');
  });

  it('uses default model and sample rate', async () => {
    const tts = new TTSService();
    const p = tts.connect('key');
    mockWs.simulateOpen();
    await p;

    expect(mockWs.url).toContain('model=aura-2-thalia-en');
    expect(mockWs.url).toContain('sample_rate=48000');
  });
});

describe('TTSService speak', () => {
  it('sends Speak message with text', async () => {
    const tts = new TTSService();
    const p = tts.connect('key');
    mockWs.simulateOpen();
    await p;

    tts.speak('Hello world');

    const sent = JSON.parse(mockWs.sent[0] as string);
    expect(sent).toEqual({ type: 'Speak', text: 'Hello world' });
  });

  it('chunks text longer than 2000 characters', async () => {
    const tts = new TTSService();
    const p = tts.connect('key');
    mockWs.simulateOpen();
    await p;

    const longText = 'x'.repeat(4500);
    tts.speak(longText);

    expect(mockWs.sent.length).toBe(3);
    const chunk1 = JSON.parse(mockWs.sent[0] as string);
    const chunk2 = JSON.parse(mockWs.sent[1] as string);
    const chunk3 = JSON.parse(mockWs.sent[2] as string);
    expect(chunk1.text.length).toBe(2000);
    expect(chunk2.text.length).toBe(2000);
    expect(chunk3.text.length).toBe(500);
  });

  it('warns when not connected', () => {
    const tts = new TTSService();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    tts.speak('test');
    expect(warnSpy).toHaveBeenCalledWith('[TTSService] Cannot speak — not connected');
  });
});

describe('TTSService flush', () => {
  it('sends Flush message', async () => {
    const tts = new TTSService();
    const p = tts.connect('key');
    mockWs.simulateOpen();
    await p;

    tts.flush();

    const sent = JSON.parse(mockWs.sent[0] as string);
    expect(sent).toEqual({ type: 'Flush' });
  });
});

describe('TTSService speakAndFlush', () => {
  it('sends both Speak and Flush messages', async () => {
    const tts = new TTSService();
    const p = tts.connect('key');
    mockWs.simulateOpen();
    await p;

    tts.speakAndFlush('Hello');

    expect(mockWs.sent.length).toBe(2);
    expect(JSON.parse(mockWs.sent[0] as string)).toEqual({ type: 'Speak', text: 'Hello' });
    expect(JSON.parse(mockWs.sent[1] as string)).toEqual({ type: 'Flush' });
  });
});

describe('TTSService message handling', () => {
  it('handles Flushed control message', async () => {
    const tts = new TTSService();
    const p = tts.connect('key');
    mockWs.simulateOpen();
    await p;

    let flushed = false;
    tts.onFlushed = () => { flushed = true; };

    mockWs.simulateMessage(JSON.stringify({ type: 'Flushed' }));
    expect(flushed).toBe(true);
  });

  it('handles Error control message', async () => {
    const tts = new TTSService();
    const p = tts.connect('key');
    mockWs.simulateOpen();
    await p;

    let errorMsg = '';
    tts.onError = (err) => { errorMsg = err.message; };

    mockWs.simulateMessage(JSON.stringify({
      type: 'Error',
      description: 'Rate limit exceeded',
    }));

    expect(errorMsg).toBe('Rate limit exceeded');
  });

  it('handles binary audio chunks', async () => {
    const tts = new TTSService();
    const p = tts.connect('key');
    mockWs.simulateOpen();
    await p;

    const receivedChunks: Float32Array[] = [];
    tts.onAudioChunk = (samples) => { receivedChunks.push(samples); };

    const pcm16 = new Int16Array([1000, -1000, 16384, -16384]);
    mockWs.simulateMessage(pcm16.buffer);

    expect(receivedChunks.length).toBe(1);
    expect(receivedChunks[0].length).toBe(4);
    expect(receivedChunks[0][0]).toBeCloseTo(1000 / 32768, 3);
  });

  it('ignores empty audio buffers', async () => {
    const tts = new TTSService();
    const p = tts.connect('key');
    mockWs.simulateOpen();
    await p;

    let chunkCount = 0;
    tts.onAudioChunk = () => { chunkCount++; };

    mockWs.simulateMessage(new ArrayBuffer(0));
    expect(chunkCount).toBe(0);
  });

  it('handles Warning messages without error callback', async () => {
    const tts = new TTSService();
    const p = tts.connect('key');
    mockWs.simulateOpen();
    await p;

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockWs.simulateMessage(JSON.stringify({ type: 'Warning', message: 'slow' }));
    expect(warnSpy).toHaveBeenCalled();
  });
});

describe('TTSService disconnect', () => {
  it('sends Close message', async () => {
    const tts = new TTSService();
    const p = tts.connect('key');
    mockWs.simulateOpen();
    await p;

    tts.disconnect();

    const closeSent = mockWs.sent.find(
      (s) => typeof s === 'string' && JSON.parse(s).type === 'Close'
    );
    expect(closeSent).toBeDefined();
    expect(tts.state).toBe('disconnected');
  });

  it('handles disconnect when not connected', () => {
    const tts = new TTSService();
    expect(() => tts.disconnect()).not.toThrow();
  });
});
