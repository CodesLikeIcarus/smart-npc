import type { PersonaDefinition, PersonaState } from './PersonaDefinition.js';
import { PERSONA_PRESETS, PERSONA_SCENARIO_COACH } from './presets.js';

/**
 * Maximum number of gathering turns before forcing a transition to roleplay.
 * Acts as a safety ceiling so the conversation never gets stuck in gathering.
 */
const GATHERING_MAX_TURNS = 10;

/**
 * Minimum number of gathering turns required before a setup-complete signal
 * can trigger the transition. Prevents premature transitions if the LLM
 * emits the signal too early.
 */
const GATHERING_MIN_TURNS = 3;

/**
 * Marker the LLM embeds in its response when scenario setup is complete.
 * PersonaEngine scans for this to trigger gathering → roleplay.
 */
export const SETUP_COMPLETE_MARKER = '[SETUP_COMPLETE]';

export class PersonaEngine {
  private _active: PersonaDefinition | null = null;
  private _state: PersonaState = 'idle';
  private _turnCount = 0;
  private _setupComplete = false;

  onPersonaChanged: ((persona: PersonaDefinition) => void) | null = null;
  onStateChanged: ((state: PersonaState, turnCount: number) => void) | null = null;
  onExitDetected: ((phrase: string) => void) | null = null;
  onTurnLimitReached: ((turnCount: number) => void) | null = null;

  get presets(): readonly PersonaDefinition[] {
    return PERSONA_PRESETS;
  }

  get active(): PersonaDefinition | null {
    return this._active;
  }

  get state(): PersonaState {
    return this._state;
  }

  get turnCount(): number {
    return this._turnCount;
  }

  get maxTurns(): number {
    return this._active?.maxTurns ?? 0;
  }

  get turnsRemaining(): number {
    if (!this._active?.maxTurns) return Infinity;
    return Math.max(0, this._active.maxTurns - this._turnCount);
  }

  loadPersona(persona: PersonaDefinition): void {
    this._active = persona;
    this._turnCount = 0;
    this._state = 'gathering';
    this._setupComplete = false;
    console.log(
      `[PersonaEngine] Loaded: "${persona.name}" (voice=${persona.voice}, ` +
      `maxTurns=${persona.maxTurns || 'unlimited'})`,
    );
    this.onPersonaChanged?.(persona);
    this.onStateChanged?.(this._state, this._turnCount);
  }

  loadPreset(id: string): PersonaDefinition | null {
    const preset = PERSONA_PRESETS.find(p => p.id === id) ?? null;
    if (preset) {
      this.loadPersona(preset);
    } else {
      console.warn(`[PersonaEngine] Preset "${id}" not found`);
    }
    return preset;
  }

  loadDefaultCoach(): PersonaDefinition {
    this.loadPersona(PERSONA_SCENARIO_COACH);
    return PERSONA_SCENARIO_COACH;
  }

  unload(): void {
    const prev = this._active?.name ?? 'none';
    this._active = null;
    this._turnCount = 0;
    this._state = 'idle';
    this._setupComplete = false;
    console.log(`[PersonaEngine] Unloaded persona (was: "${prev}")`);
    this.onStateChanged?.(this._state, this._turnCount);
  }

  getSystemPrompt(): string {
    return this._active?.systemPrompt ?? '';
  }

  getVoice(): string {
    return this._active?.voice ?? 'aura-2-thalia-en';
  }

  markSetupComplete(): void {
    if (this._state !== 'gathering') return;
    this._setupComplete = true;
    console.log(`[PersonaEngine] Setup marked complete (turn ${this._turnCount})`);

    if (this._turnCount >= GATHERING_MIN_TURNS) {
      this.transitionToRoleplay('setup-complete signal');
    }
  }

  checkResponseForSetupSignal(llmResponse: string): boolean {
    if (this._state !== 'gathering') return false;
    if (llmResponse.includes(SETUP_COMPLETE_MARKER)) {
      this.markSetupComplete();
      return true;
    }
    return false;
  }

  recordTurn(): void {
    this._turnCount++;

    if (this._state === 'gathering') {
      if (this._setupComplete && this._turnCount >= GATHERING_MIN_TURNS) {
        this.transitionToRoleplay('setup-complete signal + min turns met');
      } else if (this._turnCount >= GATHERING_MAX_TURNS) {
        console.warn(`[PersonaEngine] Gathering hit ceiling (${GATHERING_MAX_TURNS} turns) — forcing roleplay`);
        this.transitionToRoleplay('gathering ceiling');
      }
    }

    if (this._active?.maxTurns && this._turnCount >= this._active.maxTurns) {
      this._state = 'feedback';
      console.log(
        `[PersonaEngine] Turn limit reached (${this._turnCount}/${this._active.maxTurns}) — switching to feedback`,
      );
      this.onStateChanged?.(this._state, this._turnCount);
      this.onTurnLimitReached?.(this._turnCount);
    }

    console.log(
      `[PersonaEngine] Turn ${this._turnCount}` +
      (this._active?.maxTurns ? `/${this._active.maxTurns}` : '') +
      ` (state: ${this._state})`,
    );
  }

  private transitionToRoleplay(reason: string): void {
    this._state = 'roleplay';
    console.log(`[PersonaEngine] State: gathering -> roleplay (${reason}, turn ${this._turnCount})`);
    this.onStateChanged?.(this._state, this._turnCount);
  }

  checkForExit(userText: string): boolean {
    if (!this._active?.exitPhrases?.length) return false;
    const normalized = userText.toLowerCase().trim();
    for (const phrase of this._active.exitPhrases) {
      if (normalized.includes(phrase)) {
        console.log(`[PersonaEngine] Exit phrase detected: "${phrase}"`);
        this._state = 'feedback';
        this.onStateChanged?.(this._state, this._turnCount);
        this.onExitDetected?.(phrase);
        return true;
      }
    }
    return false;
  }

  buildTurnAwarePrompt(): string {
    if (!this._active) return '';
    let prompt = this._active.systemPrompt;

    if (this._state === 'gathering') {
      prompt += `\n\n[SYSTEM NOTE: You are currently in SETUP mode. When you have gathered ALL scenario details (scenario description, character to play, personality/tone, difficulty level, and difficulty examples) and confirmed them with the user, include the exact marker ${SETUP_COMPLETE_MARKER} at the very end of your response (after your visible text). This signals the system to transition into roleplay mode. Do NOT include this marker until the user has confirmed the setup is complete.]`;
    }

    if (this._active.maxTurns && this._turnCount > 0) {
      const remaining = this._active.maxTurns - this._turnCount;
      if (remaining <= 3 && remaining > 0 && this._state === 'roleplay') {
        prompt += `\n\n[SYSTEM NOTE: Only ${remaining} exchanges remaining. Begin wrapping up the scenario naturally and prepare to transition to coach feedback mode.]`;
      } else if (remaining <= 0 && this._state === 'feedback') {
        prompt += `\n\n[SYSTEM NOTE: The scenario has reached its ${this._active.maxTurns}-exchange limit. Switch to coach persona now. Give specific, constructive feedback on what the user did well and what they could improve, referencing actual things they said.]`;
      }
    }

    if (this._state === 'feedback') {
      prompt += `\n\n[SYSTEM NOTE: You are now in COACH MODE. Do not continue the roleplay. Provide feedback: what the user did well, what they could improve, and specific suggestions for practice.]`;
    }

    return prompt;
  }

  reset(): void {
    this._turnCount = 0;
    this._setupComplete = false;
    this._state = this._active ? 'gathering' : 'idle';
    console.log(`[PersonaEngine] Reset: turns=0, state=${this._state}`);
    this.onStateChanged?.(this._state, this._turnCount);
  }
}
