/**
 * LLMService — OpenAI GPT-4o streaming chat completions with sentence boundary
 * detection for real-time TTS integration.
 *
 * Uses `fetch()` + `ReadableStream` (SSE) rather than a WebSocket. Streams
 * tokens as they arrive, accumulates them in a sentence buffer, and fires
 * `onSentence` whenever a complete sentence boundary is detected (period,
 * exclamation, or question mark followed by whitespace or end-of-stream).
 *
 * Conversation history is kept in a sliding window so the model retains
 * context across turns without unbounded growth.
 */

export interface LLMServiceOptions {
  /** OpenAI model ID (default: gpt-4o) */
  model?: string;
  /** OpenAI API key */
  apiKey?: string;
  /** Chat completions endpoint URL */
  endpoint?: string;
  /** Max messages (user+assistant) to retain in history (default: 20) */
  maxHistoryMessages?: number;
  /** System prompt prepended to every request */
  systemPrompt?: string;
  /** Sampling temperature 0-2 (default: 0.7) */
  temperature?: number;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export class LLMService {
  readonly opts: Required<LLMServiceOptions>;
  private history: ChatMessage[] = [];
  private abortController: AbortController | null = null;
  private _isStreaming = false;
  private sentenceBuffer = '';

  // ─── Callbacks ─────────────────────────────────────────────────────────
  /** Fired on every delta token from the stream. */
  onToken: ((token: string) => void) | null = null;
  /** Fired when a complete sentence is detected in the token stream. */
  onSentence: ((sentence: string) => void) | null = null;
  /** Fired when the full response has been received. */
  onComplete: ((fullResponse: string) => void) | null = null;
  /** Fired on any error during streaming. */
  onError: ((error: Error) => void) | null = null;

  constructor(options?: LLMServiceOptions) {
    this.opts = {
      model: options?.model ?? 'gpt-4o',
      apiKey: options?.apiKey ?? '',
      endpoint: options?.endpoint ?? 'https://api.openai.com/v1/chat/completions',
      maxHistoryMessages: options?.maxHistoryMessages ?? 20,
      systemPrompt:
        options?.systemPrompt ??
        'You are a friendly and helpful AI assistant inhabiting an avatar in a virtual world. Keep your responses concise and conversational — typically 1-3 sentences.',
      temperature: options?.temperature ?? 0.7,
    };
    console.log(
      `[LLMService] Initialized: model=${this.opts.model} maxHistory=${this.opts.maxHistoryMessages} ` +
      `temp=${this.opts.temperature} endpoint=${this.opts.endpoint}`,
    );
  }

  // ─── Public API ────────────────────────────────────────────────────────

  /** Replace the system prompt (takes effect on next sendMessage). */
  setSystemPrompt(prompt: string): void {
    (this.opts as { systemPrompt: string }).systemPrompt = prompt;
    console.log(`[LLMService] System prompt updated (${prompt.length} chars)`);
  }

  /**
   * Send a user message and stream the assistant response.
   *
   * @returns The complete assistant response once finished.
   */
  async sendMessage(userText: string): Promise<string> {
    if (this._isStreaming) {
      console.warn('[LLMService] Already streaming — aborting previous request');
      this.abort();
    }

    this.history.push({ role: 'user', content: userText });
    this.trimHistory();

    console.log(
      `[LLMService] Sending message (${userText.length} chars), ` +
      `history: ${this.history.length} messages`,
    );

    const messages: ChatMessage[] = [
      { role: 'system', content: this.opts.systemPrompt },
      ...this.history,
    ];

    this.abortController = new AbortController();
    this._isStreaming = true;
    this.sentenceBuffer = '';

    let fullResponse = '';

    try {
      const response = await fetch(this.opts.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.opts.apiKey}`,
        },
        body: JSON.stringify({
          model: this.opts.model,
          messages,
          stream: true,
          temperature: this.opts.temperature,
        }),
        signal: this.abortController.signal,
      });

      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(
          `[LLMService] API error ${response.status}: ${errorBody.slice(0, 500)}`,
        );
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error('[LLMService] No response body reader');

      const decoder = new TextDecoder();
      let sseBuffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        sseBuffer += decoder.decode(value, { stream: true });
        const lines = sseBuffer.split('\n');
        // Keep the last (possibly incomplete) line in the buffer
        sseBuffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data: ')) continue;

          const data = trimmed.slice(6);
          if (data === '[DONE]') continue;

          try {
            const parsed = JSON.parse(data);
            const delta = parsed.choices?.[0]?.delta?.content;
            if (typeof delta === 'string' && delta.length > 0) {
              fullResponse += delta;
              this.onToken?.(delta);
              this.sentenceBuffer += delta;
              this.flushCompleteSentences();
            }
          } catch {
            // Skip unparseable SSE lines — can happen with keep-alive comments
            console.debug('[LLMService] Skipping unparseable SSE line');
          }
        }
      }

      // Flush any remaining text in the sentence buffer
      const remaining = this.sentenceBuffer.trim();
      if (remaining) {
        console.log(`[LLMService] Flushing final sentence fragment (${remaining.length} chars)`);
        this.onSentence?.(remaining);
        this.sentenceBuffer = '';
      }

      this.history.push({ role: 'assistant', content: fullResponse });
      this.trimHistory();

      console.log(
        `[LLMService] Response complete: ${fullResponse.length} chars, ` +
        `history now ${this.history.length} messages`,
      );
      this.onComplete?.(fullResponse);
      return fullResponse;
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        console.log('[LLMService] Request aborted');
        // Still flush any accumulated partial response
        const remaining = this.sentenceBuffer.trim();
        if (remaining) {
          this.onSentence?.(remaining);
          this.sentenceBuffer = '';
        }
        if (fullResponse) {
          this.history.push({ role: 'assistant', content: fullResponse });
          this.trimHistory();
        }
        return fullResponse;
      }

      const error = err instanceof Error ? err : new Error(String(err));
      console.error('[LLMService] Streaming error:', error.message);
      this.onError?.(error);
      throw error;
    } finally {
      this._isStreaming = false;
      this.abortController = null;
    }
  }

  /** Abort the current in-flight generation. */
  abort(): void {
    if (this.abortController) {
      console.log('[LLMService] Aborting current request');
      this.abortController.abort();
      this.abortController = null;
    }
  }

  /** Clear all conversation history. */
  clearHistory(): void {
    const count = this.history.length;
    this.history = [];
    this.sentenceBuffer = '';
    console.log(`[LLMService] History cleared (${count} messages removed)`);
  }

  /** Whether a streaming request is currently in-flight. */
  get isStreaming(): boolean {
    return this._isStreaming;
  }

  /** Current conversation history (read-only copy). */
  get conversationHistory(): readonly ChatMessage[] {
    return [...this.history];
  }

  // ─── Internal ──────────────────────────────────────────────────────────

  /**
   * Split the sentence buffer on sentence-ending punctuation (.!?)
   * followed by whitespace. Emit complete sentences via onSentence.
   * Keep the trailing incomplete fragment in the buffer.
   */
  private flushCompleteSentences(): void {
    // Split on sentence-ending punctuation followed by whitespace
    const parts = this.sentenceBuffer.split(/(?<=[.!?])\s+/);
    if (parts.length > 1) {
      for (let i = 0; i < parts.length - 1; i++) {
        const sentence = parts[i].trim();
        if (sentence) {
          console.log(`[LLMService] Sentence: "${sentence.slice(0, 80)}${sentence.length > 80 ? '...' : ''}"`);
          this.onSentence?.(sentence);
        }
      }
      this.sentenceBuffer = parts[parts.length - 1];
    }
  }

  /** Trim history to the configured sliding window size. */
  private trimHistory(): void {
    const max = this.opts.maxHistoryMessages;
    if (this.history.length > max) {
      const removed = this.history.length - max;
      this.history = this.history.slice(removed);
      console.log(`[LLMService] History trimmed: removed ${removed} oldest messages`);
    }
  }
}
