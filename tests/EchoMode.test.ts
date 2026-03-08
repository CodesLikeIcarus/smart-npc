import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Echo mode tests exercise the STT → TTS round-trip logic without requiring
 * the full InWorldSession dependency chain (PersonaPuppet, ProximityAudio, etc.).
 *
 * We test the core echo state machine: suppression, debounce, and wiring.
 */

// ─── Minimal echo state machine (mirrors InWorldSession echo logic) ─────

class EchoController {
  echoMode = false;
  ttsSpeaking = false;
  suppressTimer: ReturnType<typeof setTimeout> | null = null;
  ttsConnected = false;

  speakCalls: string[] = [];
  onFlushedCallback: (() => void) | null = null;

  setEchoMode(enabled: boolean): void {
    if (this.echoMode === enabled) return;
    this.echoMode = enabled;
    if (!enabled) {
      this.ttsSpeaking = false;
      if (this.suppressTimer) {
        clearTimeout(this.suppressTimer);
        this.suppressTimer = null;
      }
    }
  }

  handleTranscript(text: string, isFinal: boolean): void {
    if (!this.echoMode) return;
    if (!isFinal) return;
    if (!text.trim()) return;

    if (this.ttsSpeaking || this.suppressTimer !== null) return;
    if (!this.ttsConnected) return;

    this.ttsSpeaking = true;
    this.speakCalls.push(text);
  }

  simulateFlushed(suppressMs = 500): void {
    this.ttsSpeaking = false;
    if (this.suppressTimer) clearTimeout(this.suppressTimer);
    this.suppressTimer = setTimeout(() => {
      this.suppressTimer = null;
    }, suppressMs);
  }
}

let echo: EchoController;

beforeEach(() => {
  echo = new EchoController();
  echo.ttsConnected = true;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Echo mode state', () => {
  it('starts disabled', () => {
    expect(echo.echoMode).toBe(false);
  });

  it('can be toggled on and off', () => {
    echo.setEchoMode(true);
    expect(echo.echoMode).toBe(true);
    echo.setEchoMode(false);
    expect(echo.echoMode).toBe(false);
  });

  it('is idempotent', () => {
    echo.setEchoMode(true);
    echo.setEchoMode(true);
    expect(echo.echoMode).toBe(true);
  });

  it('clears suppression state on disable', () => {
    echo.setEchoMode(true);
    echo.ttsSpeaking = true;
    echo.suppressTimer = setTimeout(() => {}, 1000);
    echo.setEchoMode(false);
    expect(echo.ttsSpeaking).toBe(false);
    expect(echo.suppressTimer).toBeNull();
  });
});

describe('Echo transcript handling', () => {
  it('ignores transcripts when echo mode is off', () => {
    echo.handleTranscript('hello', true);
    expect(echo.speakCalls).toHaveLength(0);
  });

  it('ignores interim transcripts', () => {
    echo.setEchoMode(true);
    echo.handleTranscript('hello', false);
    expect(echo.speakCalls).toHaveLength(0);
  });

  it('ignores empty final transcripts', () => {
    echo.setEchoMode(true);
    echo.handleTranscript('', true);
    echo.handleTranscript('   ', true);
    expect(echo.speakCalls).toHaveLength(0);
  });

  it('speaks final transcript when echo mode is on', () => {
    echo.setEchoMode(true);
    echo.handleTranscript('Hello world', true);
    expect(echo.speakCalls).toEqual(['Hello world']);
    expect(echo.ttsSpeaking).toBe(true);
  });

  it('does not speak when TTS is not connected', () => {
    echo.setEchoMode(true);
    echo.ttsConnected = false;
    echo.handleTranscript('Hello', true);
    expect(echo.speakCalls).toHaveLength(0);
  });
});

describe('Echo suppression', () => {
  it('blocks new transcripts while TTS is speaking', () => {
    echo.setEchoMode(true);
    echo.handleTranscript('first', true);
    expect(echo.speakCalls).toEqual(['first']);

    echo.handleTranscript('second', true);
    expect(echo.speakCalls).toEqual(['first']);
  });

  it('blocks transcripts during suppression window after flush', () => {
    echo.setEchoMode(true);
    echo.handleTranscript('first', true);
    echo.simulateFlushed(500);

    expect(echo.ttsSpeaking).toBe(false);
    expect(echo.suppressTimer).not.toBeNull();

    echo.handleTranscript('echo feedback', true);
    expect(echo.speakCalls).toEqual(['first']);
  });

  it('allows new transcripts after suppression window expires', () => {
    echo.setEchoMode(true);
    echo.handleTranscript('first', true);
    echo.simulateFlushed(500);

    vi.advanceTimersByTime(500);
    expect(echo.suppressTimer).toBeNull();

    echo.handleTranscript('second', true);
    expect(echo.speakCalls).toEqual(['first', 'second']);
  });

  it('handles rapid flush cycles', () => {
    echo.setEchoMode(true);

    echo.handleTranscript('one', true);
    echo.simulateFlushed(500);
    vi.advanceTimersByTime(500);

    echo.handleTranscript('two', true);
    echo.simulateFlushed(500);
    vi.advanceTimersByTime(500);

    echo.handleTranscript('three', true);
    expect(echo.speakCalls).toEqual(['one', 'two', 'three']);
  });
});

describe('Echo mode disable during activity', () => {
  it('stops mid-speech when disabled', () => {
    echo.setEchoMode(true);
    echo.handleTranscript('speaking', true);
    expect(echo.ttsSpeaking).toBe(true);

    echo.setEchoMode(false);
    expect(echo.ttsSpeaking).toBe(false);

    echo.handleTranscript('after disable', true);
    expect(echo.speakCalls).toEqual(['speaking']);
  });

  it('clears suppression timer on disable', () => {
    echo.setEchoMode(true);
    echo.handleTranscript('hello', true);
    echo.simulateFlushed(500);

    echo.setEchoMode(false);
    expect(echo.suppressTimer).toBeNull();

    vi.advanceTimersByTime(500);
    echo.setEchoMode(true);
    echo.handleTranscript('new session', true);
    expect(echo.speakCalls).toEqual(['hello', 'new session']);
  });
});
