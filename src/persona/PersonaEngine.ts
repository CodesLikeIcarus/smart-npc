import type { PersonaDefinition } from './PersonaDefinition.js';
import { PERSONA_PRESETS } from './presets.js';

export class PersonaEngine {
  protected _active: PersonaDefinition | null = null;
  protected _state: string = 'idle';
  protected _turnCount = 0;

  onPersonaChanged: ((persona: PersonaDefinition) => void) | null = null;
  onStateChanged: ((state: string, turnCount: number) => void) | null = null;
  onExitDetected: ((phrase: string) => void) | null = null;

  get presets(): readonly PersonaDefinition[] {
    return PERSONA_PRESETS;
  }

  get active(): PersonaDefinition | null {
    return this._active;
  }

  get state(): string {
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
    this.initializeState();
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

  unload(): void {
    const prev = this._active?.name ?? 'none';
    this._active = null;
    this._turnCount = 0;
    this._state = 'idle';
    console.log(`[PersonaEngine] Unloaded persona (was: "${prev}")`);
    this.onStateChanged?.(this._state, this._turnCount);
  }

  getSystemPrompt(): string {
    return this._active?.systemPrompt ?? '';
  }

  getVoice(): string {
    return this._active?.voice ?? 'aura-2-thalia-en';
  }

  /** Display name of the active persona, or 'none'. */
  get personaName(): string {
    return this._active?.name ?? 'none';
  }

  recordTurn(): void {
    this._turnCount++;
    this.handleTurnRecorded();
    console.log(
      `[PersonaEngine] Turn ${this._turnCount}` +
      (this._active?.maxTurns ? `/${this._active.maxTurns}` : '') +
      ` (state: ${this._state})`,
    );
  }

  /** Alias for {@link recordTurn} — used by Realtime API integration. */
  advanceTurn(): void {
    this.recordTurn();
  }

  checkForExit(userText: string): boolean {
    if (!this._active?.exitPhrases?.length) return false;
    const normalized = userText.toLowerCase().trim();
    for (const phrase of this._active.exitPhrases) {
      if (normalized.includes(phrase)) {
        console.log(`[PersonaEngine] Exit phrase detected: "${phrase}"`);
        this.handleExitDetected(phrase);
        return true;
      }
    }
    return false;
  }

  buildTurnAwarePrompt(): string {
    return this._active?.systemPrompt ?? '';
  }

  reset(): void {
    this._turnCount = 0;
    if (this._active) {
      this.initializeState();
    } else {
      this._state = 'idle';
    }
    console.log(`[PersonaEngine] Reset: turns=0, state=${this._state}`);
    this.onStateChanged?.(this._state, this._turnCount);
  }

  protected initializeState(): void {
    this._state = 'active';
  }

  protected handleTurnRecorded(): void {
    // Subclasses override for custom turn logic (state transitions, limits, etc.)
  }

  protected handleExitDetected(phrase: string): void {
    this.onExitDetected?.(phrase);
  }

  protected setState(newState: string, reason?: string): void {
    const prev = this._state;
    this._state = newState;
    if (reason) {
      console.log(`[PersonaEngine] State: ${prev} -> ${newState} (${reason})`);
    }
    this.onStateChanged?.(this._state, this._turnCount);
  }
}
