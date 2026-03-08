import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LLMService } from '../src/ai/LLMService.js';

function sseChunk(content: string): string {
  return `data: ${JSON.stringify({
    id: 'chatcmpl-test',
    choices: [{ delta: { content }, finish_reason: null }],
  })}\n\n`;
}

const SSE_DONE = 'data: [DONE]\n\n';

function sseStop(): string {
  return `data: ${JSON.stringify({
    id: 'chatcmpl-test',
    choices: [{ delta: {}, finish_reason: 'stop' }],
  })}\n\n`;
}

function createStreamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let idx = 0;
  return new ReadableStream({
    pull(controller) {
      if (idx < chunks.length) {
        controller.enqueue(encoder.encode(chunks[idx]));
        idx++;
      } else {
        controller.close();
      }
    },
  });
}

function mockFetchSuccess(chunks: string[]): void {
  const stream = createStreamFromChunks(chunks);
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    body: stream,
    text: () => Promise.resolve(''),
  }));
}

function mockFetchError(status: number, body: string): void {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: false,
    status,
    text: () => Promise.resolve(body),
  }));
}

let llm: LLMService;

beforeEach(() => {
  llm = new LLMService({
    apiKey: 'test-key',
    model: 'gpt-4o',
    endpoint: 'https://api.openai.com/v1/chat/completions',
    maxHistoryMessages: 10,
    temperature: 0.7,
  });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'debug').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('LLMService constructor', () => {
  it('sets default options', () => {
    const service = new LLMService();
    expect(service.opts.model).toBe('gpt-4o');
    expect(service.opts.maxHistoryMessages).toBe(20);
    expect(service.opts.temperature).toBe(0.7);
  });

  it('accepts custom options', () => {
    expect(llm.opts.apiKey).toBe('test-key');
    expect(llm.opts.model).toBe('gpt-4o');
    expect(llm.opts.maxHistoryMessages).toBe(10);
  });

  it('starts in non-streaming state', () => {
    expect(llm.isStreaming).toBe(false);
  });

  it('starts with empty history', () => {
    expect(llm.conversationHistory).toHaveLength(0);
  });
});

describe('sendMessage — streaming', () => {
  it('streams tokens from SSE response', async () => {
    const tokens: string[] = [];
    llm.onToken = (t) => tokens.push(t);

    mockFetchSuccess([
      sseChunk('Hello'),
      sseChunk(' world'),
      sseChunk('!'),
      sseStop(),
      SSE_DONE,
    ]);

    const result = await llm.sendMessage('Hi');
    expect(result).toBe('Hello world!');
    expect(tokens).toEqual(['Hello', ' world', '!']);
  });

  it('fires onComplete with full response', async () => {
    let completed = '';
    llm.onComplete = (r) => { completed = r; };

    mockFetchSuccess([
      sseChunk('Done.'),
      sseStop(),
      SSE_DONE,
    ]);

    await llm.sendMessage('test');
    expect(completed).toBe('Done.');
  });

  it('adds user and assistant messages to history', async () => {
    mockFetchSuccess([
      sseChunk('Reply.'),
      sseStop(),
      SSE_DONE,
    ]);

    await llm.sendMessage('Question?');
    const history = llm.conversationHistory;
    expect(history).toHaveLength(2);
    expect(history[0]).toEqual({ role: 'user', content: 'Question?' });
    expect(history[1]).toEqual({ role: 'assistant', content: 'Reply.' });
  });

  it('sends correct request to OpenAI API', async () => {
    mockFetchSuccess([sseChunk('Hi.'), SSE_DONE]);

    await llm.sendMessage('Hello');

    const fetchCall = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(fetchCall[0]).toBe('https://api.openai.com/v1/chat/completions');

    const requestBody = JSON.parse(fetchCall[1].body);
    expect(requestBody.model).toBe('gpt-4o');
    expect(requestBody.stream).toBe(true);
    expect(requestBody.temperature).toBe(0.7);
    expect(requestBody.messages[0].role).toBe('system');
    expect(requestBody.messages[1]).toEqual({ role: 'user', content: 'Hello' });

    const headers = fetchCall[1].headers;
    expect(headers['Authorization']).toBe('Bearer test-key');
  });

  it('handles multi-line SSE data in a single chunk', async () => {
    const tokens: string[] = [];
    llm.onToken = (t) => tokens.push(t);

    const combined = sseChunk('One') + sseChunk(' two');
    mockFetchSuccess([combined, SSE_DONE]);

    await llm.sendMessage('test');
    expect(tokens).toEqual(['One', ' two']);
  });
});

describe('sentence boundary detection', () => {
  it('fires onSentence for complete sentences', async () => {
    const sentences: string[] = [];
    llm.onSentence = (s) => sentences.push(s);

    mockFetchSuccess([
      sseChunk('Hello world. '),
      sseChunk('How are you?'),
      SSE_DONE,
    ]);

    await llm.sendMessage('test');
    expect(sentences).toEqual(['Hello world.', 'How are you?']);
  });

  it('handles sentence split across multiple tokens', async () => {
    const sentences: string[] = [];
    llm.onSentence = (s) => sentences.push(s);

    mockFetchSuccess([
      sseChunk('I am '),
      sseChunk('fine. '),
      sseChunk('Thanks'),
      sseChunk('!'),
      SSE_DONE,
    ]);

    await llm.sendMessage('test');
    expect(sentences).toEqual(['I am fine.', 'Thanks!']);
  });

  it('flushes remaining buffer on stream end', async () => {
    const sentences: string[] = [];
    llm.onSentence = (s) => sentences.push(s);

    mockFetchSuccess([
      sseChunk('No period at end'),
      SSE_DONE,
    ]);

    await llm.sendMessage('test');
    expect(sentences).toEqual(['No period at end']);
  });

  it('handles exclamation marks as sentence boundaries', async () => {
    const sentences: string[] = [];
    llm.onSentence = (s) => sentences.push(s);

    mockFetchSuccess([
      sseChunk('Wow! '),
      sseChunk('Amazing! '),
      sseChunk('Cool'),
      SSE_DONE,
    ]);

    await llm.sendMessage('test');
    expect(sentences).toEqual(['Wow!', 'Amazing!', 'Cool']);
  });

  it('handles question marks as sentence boundaries', async () => {
    const sentences: string[] = [];
    llm.onSentence = (s) => sentences.push(s);

    mockFetchSuccess([
      sseChunk('Really? '),
      sseChunk('Yes.'),
      SSE_DONE,
    ]);

    await llm.sendMessage('test');
    expect(sentences).toEqual(['Really?', 'Yes.']);
  });

  it('does not split on abbreviations like Mr. or Dr.', async () => {
    const sentences: string[] = [];
    llm.onSentence = (s) => sentences.push(s);

    mockFetchSuccess([
      sseChunk('Mr.Smith is here'),
      SSE_DONE,
    ]);

    await llm.sendMessage('test');
    expect(sentences).toEqual(['Mr.Smith is here']);
  });
});

describe('conversation history', () => {
  it('maintains history across multiple messages', async () => {
    mockFetchSuccess([sseChunk('Reply 1.'), SSE_DONE]);
    await llm.sendMessage('Message 1');

    mockFetchSuccess([sseChunk('Reply 2.'), SSE_DONE]);
    await llm.sendMessage('Message 2');

    const history = llm.conversationHistory;
    expect(history).toHaveLength(4);
    expect(history[0]).toEqual({ role: 'user', content: 'Message 1' });
    expect(history[1]).toEqual({ role: 'assistant', content: 'Reply 1.' });
    expect(history[2]).toEqual({ role: 'user', content: 'Message 2' });
    expect(history[3]).toEqual({ role: 'assistant', content: 'Reply 2.' });
  });

  it('trims history to maxHistoryMessages', async () => {
    const service = new LLMService({
      apiKey: 'test-key',
      maxHistoryMessages: 4,
    });

    for (let i = 0; i < 4; i++) {
      mockFetchSuccess([sseChunk(`Reply ${i}.`), SSE_DONE]);
      await service.sendMessage(`Message ${i}`);
    }

    const history = service.conversationHistory;
    expect(history.length).toBeLessThanOrEqual(4);
    expect(history[history.length - 1].content).toBe('Reply 3.');
  });

  it('clearHistory empties history', async () => {
    mockFetchSuccess([sseChunk('Hello.'), SSE_DONE]);
    await llm.sendMessage('Hi');
    expect(llm.conversationHistory).toHaveLength(2);

    llm.clearHistory();
    expect(llm.conversationHistory).toHaveLength(0);
  });

  it('sends history in requests', async () => {
    const fetchSpy = vi.fn();

    fetchSpy.mockResolvedValueOnce({
      ok: true,
      body: createStreamFromChunks([sseChunk('First reply.'), SSE_DONE]),
      text: () => Promise.resolve(''),
    });

    fetchSpy.mockResolvedValueOnce({
      ok: true,
      body: createStreamFromChunks([sseChunk('Second reply.'), SSE_DONE]),
      text: () => Promise.resolve(''),
    });

    vi.stubGlobal('fetch', fetchSpy);

    await llm.sendMessage('First message');
    await llm.sendMessage('Second message');

    const secondCall = fetchSpy.mock.calls[1];
    const body = JSON.parse(secondCall[1].body);
    expect(body.messages).toHaveLength(4);
    expect(body.messages[0].role).toBe('system');
    expect(body.messages[1]).toEqual({ role: 'user', content: 'First message' });
    expect(body.messages[2]).toEqual({ role: 'assistant', content: 'First reply.' });
    expect(body.messages[3]).toEqual({ role: 'user', content: 'Second message' });
  });
});

describe('setSystemPrompt', () => {
  it('updates the system prompt used in requests', async () => {
    llm.setSystemPrompt('You are a pirate.');

    mockFetchSuccess([sseChunk('Arr.'), SSE_DONE]);
    await llm.sendMessage('Hello');

    const body = JSON.parse((fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    expect(body.messages[0]).toEqual({ role: 'system', content: 'You are a pirate.' });
  });
});

describe('abort', () => {
  it('aborts an in-flight request', async () => {
    let abortSignal: AbortSignal | null = null;

    vi.stubGlobal('fetch', vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      abortSignal = init.signal ?? null;
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          reject(new DOMException('The user aborted a request.', 'AbortError'));
        });
      });
    }));

    const promise = llm.sendMessage('test');
    llm.abort();

    const result = await promise;
    expect(result).toBe('');
    expect(abortSignal?.aborted).toBe(true);
    expect(llm.isStreaming).toBe(false);
  });

  it('is safe to call when not streaming', () => {
    expect(() => llm.abort()).not.toThrow();
  });
});

describe('error handling', () => {
  it('fires onError on API errors', async () => {
    let error: Error | null = null;
    llm.onError = (e) => { error = e; };

    mockFetchError(429, 'Rate limited');

    await expect(llm.sendMessage('test')).rejects.toThrow('API error 429');
    expect(error).not.toBeNull();
    expect(error!.message).toContain('429');
  });

  it('resets streaming state after error', async () => {
    llm.onError = () => {};
    mockFetchError(500, 'Server error');

    try { await llm.sendMessage('test'); } catch { /* expected */ }
    expect(llm.isStreaming).toBe(false);
  });

  it('handles missing response body', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      body: null,
      text: () => Promise.resolve(''),
    }));

    await expect(llm.sendMessage('test')).rejects.toThrow('No response body reader');
  });
});

describe('isStreaming', () => {
  it('is true during active stream', async () => {
    let streamingDuringFetch = false;

    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => {
      streamingDuringFetch = llm.isStreaming;
      return Promise.resolve({
        ok: true,
        body: createStreamFromChunks([sseChunk('Hi.'), SSE_DONE]),
        text: () => Promise.resolve(''),
      });
    }));

    await llm.sendMessage('test');
    expect(streamingDuringFetch).toBe(true);
    expect(llm.isStreaming).toBe(false);
  });
});
