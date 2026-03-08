import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PersonaEngine } from '../src/persona/PersonaEngine.js';
import { PERSONA_SCENARIO_COACH, PERSONA_ASSISTANT, PERSONA_PRESETS } from '../src/persona/presets.js';
import type { PersonaDefinition } from '../src/persona/PersonaDefinition.js';

let engine: PersonaEngine;

beforeEach(() => {
  engine = new PersonaEngine();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('PersonaEngine initialization', () => {
  it('starts in idle state with no active persona', () => {
    expect(engine.active).toBeNull();
    expect(engine.state).toBe('idle');
    expect(engine.turnCount).toBe(0);
  });

  it('exposes preset personas', () => {
    expect(engine.presets.length).toBeGreaterThanOrEqual(2);
    expect(engine.presets.find(p => p.id === 'scenario-coach')).toBeDefined();
    expect(engine.presets.find(p => p.id === 'assistant')).toBeDefined();
  });
});

describe('loadPersona', () => {
  it('sets active persona and transitions to active state', () => {
    engine.loadPersona(PERSONA_ASSISTANT);
    expect(engine.active).toBe(PERSONA_ASSISTANT);
    expect(engine.state).toBe('active');
    expect(engine.turnCount).toBe(0);
  });

  it('fires onPersonaChanged callback', () => {
    const cb = vi.fn();
    engine.onPersonaChanged = cb;
    engine.loadPersona(PERSONA_ASSISTANT);
    expect(cb).toHaveBeenCalledWith(PERSONA_ASSISTANT);
  });

  it('fires onStateChanged callback', () => {
    const cb = vi.fn();
    engine.onStateChanged = cb;
    engine.loadPersona(PERSONA_ASSISTANT);
    expect(cb).toHaveBeenCalledWith('active', 0);
  });
});

describe('loadPreset', () => {
  it('loads by ID', () => {
    const result = engine.loadPreset('assistant');
    expect(result).toBe(PERSONA_ASSISTANT);
    expect(engine.active).toBe(PERSONA_ASSISTANT);
  });

  it('returns null for unknown ID', () => {
    const result = engine.loadPreset('nonexistent');
    expect(result).toBeNull();
    expect(engine.active).toBeNull();
  });
});

describe('unload', () => {
  it('clears active persona and resets to idle', () => {
    engine.loadPersona(PERSONA_ASSISTANT);
    engine.unload();
    expect(engine.active).toBeNull();
    expect(engine.state).toBe('idle');
    expect(engine.turnCount).toBe(0);
  });
});

describe('getSystemPrompt', () => {
  it('returns active persona system prompt', () => {
    engine.loadPersona(PERSONA_ASSISTANT);
    expect(engine.getSystemPrompt()).toContain('friendly and helpful AI assistant');
  });

  it('returns empty string when no persona loaded', () => {
    expect(engine.getSystemPrompt()).toBe('');
  });
});

describe('getVoice', () => {
  it('returns active persona voice', () => {
    engine.loadPersona(PERSONA_SCENARIO_COACH);
    expect(engine.getVoice()).toBe('aura-2-thalia-en');
  });

  it('returns persona-specific voice', () => {
    engine.loadPersona(PERSONA_ASSISTANT);
    expect(engine.getVoice()).toBe('aura-2-apollo-en');
  });

  it('returns default voice when no persona loaded', () => {
    expect(engine.getVoice()).toBe('aura-2-thalia-en');
  });
});

describe('turn tracking', () => {
  it('increments turn count on recordTurn', () => {
    engine.loadPersona(PERSONA_ASSISTANT);
    engine.recordTurn();
    expect(engine.turnCount).toBe(1);
    engine.recordTurn();
    expect(engine.turnCount).toBe(2);
  });

  it('reports turnsRemaining correctly with maxTurns', () => {
    const persona: PersonaDefinition = { ...PERSONA_SCENARIO_COACH, maxTurns: 20 };
    engine.loadPersona(persona);
    expect(engine.turnsRemaining).toBe(20);
    engine.recordTurn();
    expect(engine.turnsRemaining).toBe(19);
  });

  it('reports Infinity turnsRemaining when maxTurns is 0', () => {
    engine.loadPersona(PERSONA_ASSISTANT);
    expect(engine.turnsRemaining).toBe(Infinity);
  });

  it('does not go below 0 turnsRemaining', () => {
    const persona: PersonaDefinition = { ...PERSONA_ASSISTANT, maxTurns: 2 };
    engine.loadPersona(persona);
    engine.recordTurn();
    engine.recordTurn();
    engine.recordTurn();
    expect(engine.turnsRemaining).toBe(0);
  });
});

describe('exit detection', () => {
  it('detects exit phrases and returns true', () => {
    engine.loadPersona(PERSONA_SCENARIO_COACH);
    expect(engine.checkForExit('I want to stop this')).toBe(true);
  });

  it('is case-insensitive', () => {
    engine.loadPersona(PERSONA_SCENARIO_COACH);
    expect(engine.checkForExit('I WANT TO STOP THIS')).toBe(true);
  });

  it('detects phrases within longer text', () => {
    engine.loadPersona(PERSONA_SCENARIO_COACH);
    expect(engine.checkForExit('Actually, I want to stop this roleplay now')).toBe(true);
  });

  it('does not false-positive on unrelated text', () => {
    engine.loadPersona(PERSONA_SCENARIO_COACH);
    expect(engine.checkForExit('Hello, I am doing great')).toBe(false);
  });

  it('fires onExitDetected callback', () => {
    const cb = vi.fn();
    engine.onExitDetected = cb;
    engine.loadPersona(PERSONA_SCENARIO_COACH);
    engine.checkForExit('I want to stop this');
    expect(cb).toHaveBeenCalledWith('i want to stop this');
  });

  it('returns false when no exit phrases defined', () => {
    engine.loadPersona(PERSONA_ASSISTANT);
    expect(engine.checkForExit('I want to stop this')).toBe(false);
  });

  it('does not change state in base class', () => {
    engine.loadPersona(PERSONA_SCENARIO_COACH);
    engine.checkForExit('I want to stop this');
    expect(engine.state).toBe('active');
  });
});

describe('buildTurnAwarePrompt', () => {
  it('returns base system prompt without augmentation', () => {
    engine.loadPersona(PERSONA_ASSISTANT);
    const prompt = engine.buildTurnAwarePrompt();
    expect(prompt).toBe(PERSONA_ASSISTANT.systemPrompt);
  });

  it('returns empty string when no persona loaded', () => {
    expect(engine.buildTurnAwarePrompt()).toBe('');
  });
});

describe('reset', () => {
  it('resets turn count and state to active when persona loaded', () => {
    engine.loadPersona(PERSONA_ASSISTANT);
    engine.recordTurn();
    engine.recordTurn();
    expect(engine.turnCount).toBe(2);

    engine.reset();
    expect(engine.turnCount).toBe(0);
    expect(engine.state).toBe('active');
  });

  it('resets to idle when no persona loaded', () => {
    engine.reset();
    expect(engine.state).toBe('idle');
  });
});

describe('subclass extension points', () => {
  it('allows subclass to override initializeState', () => {
    class CustomEngine extends PersonaEngine {
      protected override initializeState(): void {
        this._state = 'custom-init';
      }
    }
    const custom = new CustomEngine();
    custom.loadPersona(PERSONA_ASSISTANT);
    expect(custom.state).toBe('custom-init');
  });

  it('allows subclass to override handleTurnRecorded', () => {
    let hookCalled = false;
    class CustomEngine extends PersonaEngine {
      protected override handleTurnRecorded(): void {
        hookCalled = true;
      }
    }
    const custom = new CustomEngine();
    custom.loadPersona(PERSONA_ASSISTANT);
    custom.recordTurn();
    expect(hookCalled).toBe(true);
  });

  it('allows subclass to override handleExitDetected', () => {
    class CustomEngine extends PersonaEngine {
      protected override handleExitDetected(phrase: string): void {
        this.setState('custom-exit');
        this.onExitDetected?.(phrase);
      }
    }
    const custom = new CustomEngine();
    custom.loadPersona(PERSONA_SCENARIO_COACH);
    custom.checkForExit('I want to stop this');
    expect(custom.state).toBe('custom-exit');
  });

  it('allows subclass to override buildTurnAwarePrompt', () => {
    class CustomEngine extends PersonaEngine {
      override buildTurnAwarePrompt(): string {
        const base = super.buildTurnAwarePrompt();
        return base + '\n[CUSTOM AUGMENTATION]';
      }
    }
    const custom = new CustomEngine();
    custom.loadPersona(PERSONA_ASSISTANT);
    const prompt = custom.buildTurnAwarePrompt();
    expect(prompt).toContain(PERSONA_ASSISTANT.systemPrompt);
    expect(prompt).toContain('[CUSTOM AUGMENTATION]');
  });
});

describe('preset definitions', () => {
  it('scenario coach has exit phrases', () => {
    expect(PERSONA_SCENARIO_COACH.exitPhrases.length).toBeGreaterThan(0);
  });

  it('scenario coach has 20 maxTurns', () => {
    expect(PERSONA_SCENARIO_COACH.maxTurns).toBe(20);
  });

  it('assistant has no exit phrases or turn limit', () => {
    expect(PERSONA_ASSISTANT.exitPhrases).toHaveLength(0);
    expect(PERSONA_ASSISTANT.maxTurns).toBe(0);
  });

  it('all presets have required fields', () => {
    for (const preset of PERSONA_PRESETS) {
      expect(preset.id).toBeTruthy();
      expect(preset.name).toBeTruthy();
      expect(preset.description).toBeTruthy();
      expect(preset.systemPrompt).toBeTruthy();
      expect(preset.voice).toBeTruthy();
    }
  });
});
