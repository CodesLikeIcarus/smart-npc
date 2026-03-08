import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { STTService, type TranscriptEvent, type STTConnectionState } from '../src/ai/STTService.js';

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState = MockWebSocket.CONNECTING;
  url: string;
  protocol: string;
  sentMessages: (string | ArrayBuffer)[] = [];

  onopen: ((ev: Event) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;

  constructor(url: string, protocols?: string | string[]) {
    this.url = url;
    this.protocol = Array.isArray(protocols) ? protocols.join(', ') : (protocols ?? '');
  }

  send(data: string | ArrayBuffer): void {
    this.sentMessages.push(data);
  }

  close(): void {
    this.readyState = MockWebSocket.CLOSED;
  }

  simulateOpen(): void {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.(new Event('open'));
  }

  simulateMessage(data: Record<string, unknown>): void {
    this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(data) }));
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
    constructor(url: string, protocols?: string | string[]) {
      super(url, protocols);
      mockWs = this;
    }
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('STTService constructor', () => {
  it('uses v2 defaults when no options provided', () => {
    const stt = new STTService();
    expect(stt.opts.model).toBe('flux-general-en');
    expect(stt.opts.endpoint).toBe('wss://api.deepgram.com/v2/listen');
    expect(stt.opts.sampleRate).toBe(16000);
    expect(stt.opts.encoding).toBe('linear16');
    expect(stt.opts.eotThreshold).toBe(0.7);
    expect(stt.opts.eotTimeoutMs).toBe(3000);
  });

  it('accepts custom options', () => {
    const stt = new STTService({
      model: 'custom-model',
      sampleRate: 24000,
      eotThreshold: 0.9,
      eotTimeoutMs: 5000,
      eagerEotThreshold: 0.5,
    });
    expect(stt.opts.model).toBe('custom-model');
    expect(stt.opts.sampleRate).toBe(24000);
    expect(stt.opts.eotThreshold).toBe(0.9);
    expect(stt.opts.eotTimeoutMs).toBe(5000);
    expect(stt.opts.eagerEotThreshold).toBe(0.5);
  });
});

describe('STTService connect', () => {
  it('constructs correct v2 URL with query params', async () => {
    const stt = new STTService();
    const connectPromise = stt.connect('test-api-key');

    expect(mockWs.url).toContain('wss://api.deepgram.com/v2/listen?');
    expect(mockWs.url).toContain('model=flux-general-en');
    expect(mockWs.url).toContain('encoding=linear16');
    expect(mockWs.url).toContain('sample_rate=16000');
    expect(mockWs.url).toContain('eot_threshold=0.7');
    expect(mockWs.url).toContain('eot_timeout_ms=3000');

    mockWs.simulateOpen();
    await connectPromise;
  });

  it('includes eager_eot_threshold when set', async () => {
    const stt = new STTService({ eagerEotThreshold: 0.5 });
    const connectPromise = stt.connect('test-key');
    expect(mockWs.url).toContain('eager_eot_threshold=0.5');
    mockWs.simulateOpen();
    await connectPromise;
  });

  it('uses subprotocol auth with token', async () => {
    const stt = new STTService();
    const connectPromise = stt.connect('my-secret-key');
    expect(mockWs.protocol).toContain('my-secret-key');
    expect(mockWs.protocol).toContain('token');
    mockWs.simulateOpen();
    await connectPromise;
  });

  it('transitions to connected state on open', async () => {
    const stt = new STTService();
    const states: STTConnectionState[] = [];
    stt.onStateChange = (s) => states.push(s);

    const connectPromise = stt.connect('key');
    mockWs.simulateOpen();
    await connectPromise;

    expect(states).toContain('connecting');
    expect(states).toContain('connected');
    expect(stt.isConnected).toBe(true);
  });

  it('rejects on WebSocket error', async () => {
    const stt = new STTService();
    const connectPromise = stt.connect('key');
    mockWs.simulateError();

    await expect(connectPromise).rejects.toThrow();
    expect(stt.state).toBe('error');
  });
});

describe('STTService message handling', () => {
  let stt: STTService;

  beforeEach(async () => {
    stt = new STTService();
    const p = stt.connect('key');
    mockWs.simulateOpen();
    await p;
  });

  it('handles Connected message', () => {
    mockWs.simulateMessage({
      type: 'Connected',
      request_id: 'test-uuid',
      sequence_id: 0,
    });
  });

  it('emits onTurnStart for StartOfTurn event', () => {
    const turns: number[] = [];
    stt.onTurnStart = (idx) => turns.push(idx);

    mockWs.simulateMessage({
      type: 'TurnInfo',
      event: 'StartOfTurn',
      turn_index: 0,
      transcript: '',
      end_of_turn_confidence: 0,
    });

    expect(turns).toEqual([0]);
  });

  it('emits interim transcript for Update event', () => {
    const events: TranscriptEvent[] = [];
    stt.onTranscript = (e) => events.push(e);

    mockWs.simulateMessage({
      type: 'TurnInfo',
      event: 'Update',
      turn_index: 0,
      transcript: 'hello world',
      end_of_turn_confidence: 0.3,
    });

    expect(events).toHaveLength(1);
    expect(events[0].text).toBe('hello world');
    expect(events[0].isFinal).toBe(false);
    expect(events[0].isInterim).toBe(true);
    expect(events[0].turnIndex).toBe(0);
  });

  it('ignores Update with empty transcript', () => {
    const events: TranscriptEvent[] = [];
    stt.onTranscript = (e) => events.push(e);

    mockWs.simulateMessage({
      type: 'TurnInfo',
      event: 'Update',
      turn_index: 0,
      transcript: '',
      end_of_turn_confidence: 0,
    });

    expect(events).toHaveLength(0);
  });

  it('emits final transcript for EndOfTurn event', () => {
    const events: TranscriptEvent[] = [];
    stt.onTranscript = (e) => events.push(e);

    const turnEnds: Array<{ idx: number; conf: number }> = [];
    stt.onTurnEnd = (idx, conf) => turnEnds.push({ idx, conf });

    mockWs.simulateMessage({
      type: 'TurnInfo',
      event: 'EndOfTurn',
      turn_index: 0,
      transcript: 'I need to cancel my order',
      end_of_turn_confidence: 0.95,
    });

    expect(events).toHaveLength(1);
    expect(events[0].text).toBe('I need to cancel my order');
    expect(events[0].isFinal).toBe(true);
    expect(events[0].isInterim).toBe(false);
    expect(events[0].confidence).toBe(0.95);

    expect(turnEnds).toHaveLength(1);
    expect(turnEnds[0].conf).toBe(0.95);
  });

  it('handles EagerEndOfTurn as interim', () => {
    const events: TranscriptEvent[] = [];
    stt.onTranscript = (e) => events.push(e);

    mockWs.simulateMessage({
      type: 'TurnInfo',
      event: 'EagerEndOfTurn',
      turn_index: 1,
      transcript: 'early signal',
      end_of_turn_confidence: 0.6,
    });

    expect(events).toHaveLength(1);
    expect(events[0].isFinal).toBe(false);
    expect(events[0].isInterim).toBe(true);
  });

  it('handles TurnResumed without emitting transcript', () => {
    const events: TranscriptEvent[] = [];
    stt.onTranscript = (e) => events.push(e);

    mockWs.simulateMessage({
      type: 'TurnInfo',
      event: 'TurnResumed',
      turn_index: 1,
      transcript: 'some text',
      end_of_turn_confidence: 0,
    });

    expect(events).toHaveLength(0);
  });

  it('emits onTurnResumed callback for TurnResumed event', () => {
    const resumed: number[] = [];
    stt.onTurnResumed = (idx) => resumed.push(idx);

    mockWs.simulateMessage({
      type: 'TurnInfo',
      event: 'TurnResumed',
      turn_index: 2,
      transcript: '',
      end_of_turn_confidence: 0,
    });

    expect(resumed).toEqual([2]);
  });

  it('handles Error messages', () => {
    const errors: Error[] = [];
    stt.onError = (e) => errors.push(e);

    mockWs.simulateMessage({
      type: 'Error',
      code: 'INTERNAL_SERVER_ERROR',
      description: 'Something broke',
    });

    expect(errors).toHaveLength(1);
    expect(errors[0].message).toBe('Something broke');
  });

  it('handles non-JSON messages gracefully', () => {
    mockWs.onmessage?.(new MessageEvent('message', { data: 'not json{{{' }));
  });
});

describe('STTService sendPCM', () => {
  it('sends binary ArrayBuffer when connected', async () => {
    const stt = new STTService();
    const p = stt.connect('key');
    mockWs.simulateOpen();
    await p;

    const pcm = new ArrayBuffer(320);
    stt.sendPCM(pcm);

    expect(mockWs.sentMessages).toContainEqual(pcm);
  });

  it('silently drops audio when not connected', () => {
    const stt = new STTService();
    stt.sendPCM(new ArrayBuffer(320));
  });
});

describe('STTService configure', () => {
  let stt: STTService;

  beforeEach(async () => {
    stt = new STTService();
    const p = stt.connect('key');
    mockWs.simulateOpen();
    await p;
  });

  it('sends Configure message with eotThreshold', () => {
    const result = stt.configure({ eotThreshold: 0.8 });

    expect(result).toBe(true);
    const configMsg = mockWs.sentMessages.find(
      m => typeof m === 'string' && m.includes('Configure')
    ) as string;
    expect(configMsg).toBeDefined();
    const parsed = JSON.parse(configMsg);
    expect(parsed.type).toBe('Configure');
    expect(parsed.thresholds.eot_threshold).toBe(0.8);
  });

  it('sends Configure message with eotTimeoutMs', () => {
    const result = stt.configure({ eotTimeoutMs: 5000 });

    expect(result).toBe(true);
    const configMsg = mockWs.sentMessages.find(
      m => typeof m === 'string' && m.includes('Configure')
    ) as string;
    const parsed = JSON.parse(configMsg);
    expect(parsed.thresholds.eot_timeout_ms).toBe(5000);
  });

  it('sends Configure with both thresholds', () => {
    const result = stt.configure({ eotThreshold: 0.85, eotTimeoutMs: 4000 });

    expect(result).toBe(true);
    const configMsg = mockWs.sentMessages.find(
      m => typeof m === 'string' && m.includes('Configure')
    ) as string;
    const parsed = JSON.parse(configMsg);
    expect(parsed.thresholds.eot_threshold).toBe(0.85);
    expect(parsed.thresholds.eot_timeout_ms).toBe(4000);
  });

  it('returns false when WebSocket is not open', () => {
    stt.disconnect();
    const result = stt.configure({ eotThreshold: 0.8 });

    expect(result).toBe(false);
  });

  it('returns false when no values changed (dedup)', () => {
    const result = stt.configure({ eotThreshold: 0.7 });

    expect(result).toBe(false);
    const configMsgs = mockWs.sentMessages.filter(
      m => typeof m === 'string' && m.includes('Configure')
    );
    expect(configMsgs).toHaveLength(0);
  });

  it('updates internal opts after sending', () => {
    stt.configure({ eotThreshold: 0.9, eotTimeoutMs: 6000 });

    expect(stt.opts.eotThreshold).toBe(0.9);
    expect(stt.opts.eotTimeoutMs).toBe(6000);
  });

  it('only sends changed fields', () => {
    stt.configure({ eotThreshold: 0.8 });
    mockWs.sentMessages = [];

    stt.configure({ eotTimeoutMs: 4000 });

    const configMsg = mockWs.sentMessages.find(
      m => typeof m === 'string' && m.includes('Configure')
    ) as string;
    const parsed = JSON.parse(configMsg);
    expect(parsed.thresholds.eot_threshold).toBeUndefined();
    expect(parsed.thresholds.eot_timeout_ms).toBe(4000);
  });
});

describe('STTService disconnect', () => {
  it('sends CloseStream message', async () => {
    const stt = new STTService();
    const p = stt.connect('key');
    mockWs.simulateOpen();
    await p;

    stt.disconnect();

    const closeMsg = mockWs.sentMessages.find(
      m => typeof m === 'string' && m.includes('CloseStream')
    );
    expect(closeMsg).toBeDefined();
    expect(stt.state).toBe('disconnected');
  });
});
