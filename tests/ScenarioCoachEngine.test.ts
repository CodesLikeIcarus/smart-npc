import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ScenarioCoachEngine, SETUP_COMPLETE_MARKER } from '../src/persona/ScenarioCoachEngine.js';
import { PERSONA_SCENARIO_COACH, PERSONA_ASSISTANT } from '../src/persona/presets.js';
import type { PersonaDefinition } from '../src/persona/PersonaDefinition.js';

let engine: ScenarioCoachEngine;

beforeEach(() => {
  engine = new ScenarioCoachEngine();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('ScenarioCoachEngine initialization', () => {
  it('starts in idle state', () => {
    expect(engine.active).toBeNull();
    expect(engine.state).toBe('idle');
    expect(engine.turnCount).toBe(0);
  });
});

describe('loadPersona', () => {
  it('sets state to gathering on load', () => {
    engine.loadPersona(PERSONA_SCENARIO_COACH);
    expect(engine.active).toBe(PERSONA_SCENARIO_COACH);
    expect(engine.state).toBe('gathering');
    expect(engine.turnCount).toBe(0);
  });

  it('fires onStateChanged with gathering', () => {
    const cb = vi.fn();
    engine.onStateChanged = cb;
    engine.loadPersona(PERSONA_SCENARIO_COACH);
    expect(cb).toHaveBeenCalledWith('gathering', 0);
  });
});

describe('loadDefaultCoach', () => {
  it('loads the scenario coach preset', () => {
    const result = engine.loadDefaultCoach();
    expect(result).toBe(PERSONA_SCENARIO_COACH);
    expect(engine.active?.id).toBe('scenario-coach');
    expect(engine.state).toBe('gathering');
  });
});

describe('gathering to roleplay transitions', () => {
  it('does NOT transition from gathering on turn count alone (below ceiling)', () => {
    engine.loadPersona(PERSONA_SCENARIO_COACH);
    for (let i = 0; i < 5; i++) engine.recordTurn();
    expect(engine.state).toBe('gathering');
  });

  it('transitions when setup-complete signal received after min turns', () => {
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
});

describe('setup-complete detection', () => {
  it('detects marker in LLM response text', () => {
    engine.loadPersona(PERSONA_SCENARIO_COACH);
    for (let i = 0; i < 3; i++) engine.recordTurn();

    const detected = engine.checkResponseForSetupSignal(
      `Great, let me get into character now! ${SETUP_COMPLETE_MARKER}`,
    );
    expect(detected).toBe(true);
    expect(engine.state).toBe('roleplay');
  });

  it('ignores marker when not in gathering state', () => {
    engine.loadPersona(PERSONA_SCENARIO_COACH);
    for (let i = 0; i < 3; i++) engine.recordTurn();
    engine.markSetupComplete();
    expect(engine.state).toBe('roleplay');

    const detected = engine.checkResponseForSetupSignal(`Something ${SETUP_COMPLETE_MARKER}`);
    expect(detected).toBe(false);
  });

  it('returns false when response has no marker', () => {
    engine.loadPersona(PERSONA_SCENARIO_COACH);
    engine.recordTurn();
    const detected = engine.checkResponseForSetupSignal('Just a normal response');
    expect(detected).toBe(false);
    expect(engine.state).toBe('gathering');
  });
});

describe('feedback transitions', () => {
  it('transitions to feedback when maxTurns reached', () => {
    const persona: PersonaDefinition = { ...PERSONA_SCENARIO_COACH, maxTurns: 5 };
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
});

describe('exit detection', () => {
  it('transitions to feedback state on exit', () => {
    engine.loadPersona(PERSONA_SCENARIO_COACH);
    expect(engine.checkForExit('I want to stop this')).toBe(true);
    expect(engine.state).toBe('feedback');
  });

  it('is case-insensitive', () => {
    engine.loadPersona(PERSONA_SCENARIO_COACH);
    expect(engine.checkForExit('I WANT TO STOP THIS')).toBe(true);
    expect(engine.state).toBe('feedback');
  });

  it('fires onExitDetected callback', () => {
    const cb = vi.fn();
    engine.onExitDetected = cb;
    engine.loadPersona(PERSONA_SCENARIO_COACH);
    engine.checkForExit('I want to stop this');
    expect(cb).toHaveBeenCalledWith('i want to stop this');
  });
});

describe('buildTurnAwarePrompt', () => {
  it('includes gathering SETUP note when in gathering state', () => {
    engine.loadPersona(PERSONA_SCENARIO_COACH);
    const prompt = engine.buildTurnAwarePrompt();
    expect(prompt).toContain('scenario-based roleplay coach');
    expect(prompt).toContain('SETUP mode');
    expect(prompt).toContain(SETUP_COMPLETE_MARKER);
    expect(prompt).not.toContain('wrapping up');
    expect(prompt).not.toContain('COACH MODE');
  });

  it('adds wind-down note when 3 turns remaining in roleplay', () => {
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

describe('unload', () => {
  it('clears scenario state and resets to idle', () => {
    engine.loadPersona(PERSONA_SCENARIO_COACH);
    engine.markSetupComplete();
    engine.recordTurn();
    engine.recordTurn();
    engine.recordTurn();

    engine.unload();
    expect(engine.active).toBeNull();
    expect(engine.state).toBe('idle');
    expect(engine.turnCount).toBe(0);
  });
});

describe('reset', () => {
  it('resets to gathering when persona loaded', () => {
    engine.loadPersona(PERSONA_SCENARIO_COACH);
    engine.markSetupComplete();
    engine.recordTurn();
    engine.recordTurn();
    engine.recordTurn();
    engine.recordTurn();
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

describe('turn tracking', () => {
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
