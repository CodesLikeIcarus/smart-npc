import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PersonaEngine, SETUP_COMPLETE_MARKER } from '../src/persona/PersonaEngine.js';
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
  it('sets active persona and resets state', () => {
    engine.loadPersona(PERSONA_SCENARIO_COACH);
    expect(engine.active).toBe(PERSONA_SCENARIO_COACH);
    expect(engine.state).toBe('gathering');
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
    engine.loadPersona(PERSONA_SCENARIO_COACH);
    expect(cb).toHaveBeenCalledWith('gathering', 0);
  });
});

describe('loadPreset', () => {
  it('loads by ID', () => {
    const result = engine.loadPreset('scenario-coach');
    expect(result).toBe(PERSONA_SCENARIO_COACH);
    expect(engine.active).toBe(PERSONA_SCENARIO_COACH);
  });

  it('returns null for unknown ID', () => {
    const result = engine.loadPreset('nonexistent');
    expect(result).toBeNull();
    expect(engine.active).toBeNull();
  });
});

describe('loadDefaultCoach', () => {
  it('loads the scenario coach preset', () => {
    const result = engine.loadDefaultCoach();
    expect(result).toBe(PERSONA_SCENARIO_COACH);
    expect(engine.active?.id).toBe('scenario-coach');
  });
});

describe('unload', () => {
  it('clears active persona and resets to idle', () => {
    engine.loadPersona(PERSONA_SCENARIO_COACH);
    engine.unload();
    expect(engine.active).toBeNull();
    expect(engine.state).toBe('idle');
    expect(engine.turnCount).toBe(0);
  });
});

describe('getSystemPrompt', () => {
  it('returns active persona system prompt', () => {
    engine.loadPersona(PERSONA_SCENARIO_COACH);
    expect(engine.getSystemPrompt()).toContain('scenario-based coach');
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
    engine.loadPersona(PERSONA_SCENARIO_COACH);
    engine.recordTurn();
    expect(engine.turnCount).toBe(1);
    engine.recordTurn();
    expect(engine.turnCount).toBe(2);
  });

  it('does NOT transition from gathering to roleplay on turn count alone', () => {
    engine.loadPersona(PERSONA_SCENARIO_COACH);
    expect(engine.state).toBe('gathering');
    for (let i = 0; i < 5; i++) engine.recordTurn();
    expect(engine.state).toBe('gathering');
  });

  it('transitions gathering→roleplay when setup-complete signal received after min turns', () => {
    engine.loadPersona(PERSONA_SCENARIO_COACH);
    engine.recordTurn();
    engine.recordTurn();
    engine.recordTurn();
    expect(engine.state).toBe('gathering');

    engine.markSetupComplete();
    expect(engine.state).toBe('roleplay');
  });

  it('defers transition if setup-complete signal arrives before min turns', () => {
    engine.loadPersona(PERSONA_SCENARIO_COACH);
    engine.recordTurn();
    engine.markSetupComplete();
    expect(engine.state).toBe('gathering');

    engine.recordTurn();
    expect(engine.state).toBe('gathering');
    engine.recordTurn();
    expect(engine.state).toBe('roleplay');
  });

  it('forces roleplay transition at gathering ceiling (10 turns)', () => {
    engine.loadPersona(PERSONA_SCENARIO_COACH);
    for (let i = 0; i < 9; i++) engine.recordTurn();
    expect(engine.state).toBe('gathering');
    engine.recordTurn();
    expect(engine.state).toBe('roleplay');
  });

  it('detects setup-complete marker in LLM response text', () => {
    engine.loadPersona(PERSONA_SCENARIO_COACH);
    for (let i = 0; i < 3; i++) engine.recordTurn();

    const detected = engine.checkResponseForSetupSignal(
      `Great, let me get into character now! ${SETUP_COMPLETE_MARKER}`,
    );
    expect(detected).toBe(true);
    expect(engine.state).toBe('roleplay');
  });

  it('ignores setup-complete marker when not in gathering state', () => {
    engine.loadPersona(PERSONA_SCENARIO_COACH);
    for (let i = 0; i < 3; i++) engine.recordTurn();
    engine.markSetupComplete();
    expect(engine.state).toBe('roleplay');

    const detected = engine.checkResponseForSetupSignal(`Something ${SETUP_COMPLETE_MARKER}`);
    expect(detected).toBe(false);
  });

  it('returns false when LLM response has no setup marker', () => {
    engine.loadPersona(PERSONA_SCENARIO_COACH);
    engine.recordTurn();
    const detected = engine.checkResponseForSetupSignal('Just a normal response');
    expect(detected).toBe(false);
    expect(engine.state).toBe('gathering');
  });

  it('transitions to feedback when maxTurns reached', () => {
    const persona: PersonaDefinition = {
      ...PERSONA_SCENARIO_COACH,
      maxTurns: 5,
    };
    engine.loadPersona(persona);
    engine.markSetupComplete();

    for (let i = 0; i < 5; i++) engine.recordTurn();
    expect(engine.state).toBe('feedback');
    expect(engine.turnCount).toBe(5);
  });

  it('fires onTurnLimitReached when maxTurns hit', () => {
    const cb = vi.fn();
    engine.onTurnLimitReached = cb;
    const persona: PersonaDefinition = { ...PERSONA_SCENARIO_COACH, maxTurns: 3 };
    engine.loadPersona(persona);
    engine.markSetupComplete();

    engine.recordTurn();
    engine.recordTurn();
    expect(cb).not.toHaveBeenCalled();
    engine.recordTurn();
    expect(cb).toHaveBeenCalledWith(3);
  });

  it('reports turnsRemaining correctly', () => {
    engine.loadPersona(PERSONA_SCENARIO_COACH);
    expect(engine.turnsRemaining).toBe(20);
    engine.recordTurn();
    expect(engine.turnsRemaining).toBe(19);
  });

  it('reports Infinity turnsRemaining when maxTurns is 0', () => {
    engine.loadPersona(PERSONA_ASSISTANT);
    expect(engine.turnsRemaining).toBe(Infinity);
  });

  it('does not go below 0 turnsRemaining', () => {
    const persona: PersonaDefinition = { ...PERSONA_SCENARIO_COACH, maxTurns: 2 };
    engine.loadPersona(persona);
    engine.recordTurn();
    engine.recordTurn();
    engine.recordTurn();
    expect(engine.turnsRemaining).toBe(0);
  });
});

describe('exit detection', () => {
  it('detects exit phrases', () => {
    engine.loadPersona(PERSONA_SCENARIO_COACH);
    expect(engine.checkForExit('I want to stop this')).toBe(true);
    expect(engine.state).toBe('feedback');
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
    expect(engine.state).toBe('gathering');
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
});

describe('buildTurnAwarePrompt', () => {
  it('returns base prompt with gathering note early in session', () => {
    engine.loadPersona(PERSONA_SCENARIO_COACH);
    const prompt = engine.buildTurnAwarePrompt();
    expect(prompt).toContain('scenario-based coach');
    expect(prompt).toContain('SETUP mode');
    expect(prompt).not.toContain('wrapping up');
    expect(prompt).not.toContain('COACH MODE');
  });

  it('adds gathering system note when in gathering state', () => {
    engine.loadPersona(PERSONA_SCENARIO_COACH);
    const prompt = engine.buildTurnAwarePrompt();
    expect(prompt).toContain(SETUP_COMPLETE_MARKER);
    expect(prompt).toContain('SETUP mode');
  });

  it('adds wind-down note when 3 turns remaining', () => {
    const persona: PersonaDefinition = { ...PERSONA_SCENARIO_COACH, maxTurns: 10 };
    engine.loadPersona(persona);
    engine.markSetupComplete();
    for (let i = 0; i < 7; i++) engine.recordTurn();

    const prompt = engine.buildTurnAwarePrompt();
    expect(prompt).toContain('3 exchanges remaining');
    expect(prompt).toContain('wrapping up');
  });

  it('adds feedback note when in feedback state', () => {
    const persona: PersonaDefinition = { ...PERSONA_SCENARIO_COACH, maxTurns: 5 };
    engine.loadPersona(persona);
    engine.markSetupComplete();
    for (let i = 0; i < 5; i++) engine.recordTurn();

    expect(engine.state).toBe('feedback');
    const prompt = engine.buildTurnAwarePrompt();
    expect(prompt).toContain('COACH MODE');
  });

  it('returns empty string when no persona loaded', () => {
    expect(engine.buildTurnAwarePrompt()).toBe('');
  });
});

describe('reset', () => {
  it('resets turn count, setupComplete flag, and state to gathering', () => {
    engine.loadPersona(PERSONA_SCENARIO_COACH);
    engine.markSetupComplete();
    engine.recordTurn();
    engine.recordTurn();
    engine.recordTurn();
    engine.recordTurn();
    expect(engine.turnCount).toBe(4);
    expect(engine.state).toBe('roleplay');

    engine.reset();
    expect(engine.turnCount).toBe(0);
    expect(engine.state).toBe('gathering');

    for (let i = 0; i < 5; i++) engine.recordTurn();
    expect(engine.state).toBe('gathering');
  });

  it('resets to idle when no persona loaded', () => {
    engine.reset();
    expect(engine.state).toBe('idle');
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
