import type { PersonaDefinition, ScenarioPersonaState } from './PersonaDefinition.js';
import { PersonaEngine } from './PersonaEngine.js';
import { PERSONA_SCENARIO_COACH } from './presets.js';

const GATHERING_MAX_TURNS = 10;
const GATHERING_MIN_TURNS = 3;

export const SETUP_COMPLETE_MARKER = '[SETUP_COMPLETE]';

export class ScenarioCoachEngine extends PersonaEngine {
  private _setupComplete = false;

  onTurnLimitReached: ((turnCount: number) => void) | null = null;

  override get state(): ScenarioPersonaState {
    return this._state as ScenarioPersonaState;
  }

  loadDefaultCoach(): PersonaDefinition {
    this.loadPersona(PERSONA_SCENARIO_COACH);
    return PERSONA_SCENARIO_COACH;
  }

  markSetupComplete(): void {
    if (this._state !== 'gathering') return;
    this._setupComplete = true;
    console.log(`[ScenarioCoachEngine] Setup marked complete (turn ${this._turnCount})`);

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

  override buildTurnAwarePrompt(): string {
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

  override unload(): void {
    this._setupComplete = false;
    super.unload();
  }

  override reset(): void {
    this._setupComplete = false;
    super.reset();
  }

  protected override initializeState(): void {
    this._state = 'gathering';
  }

  protected override handleTurnRecorded(): void {
    if (this._state === 'gathering') {
      if (this._setupComplete && this._turnCount >= GATHERING_MIN_TURNS) {
        this.transitionToRoleplay('setup-complete signal + min turns met');
      } else if (this._turnCount >= GATHERING_MAX_TURNS) {
        console.warn(`[ScenarioCoachEngine] Gathering hit ceiling (${GATHERING_MAX_TURNS} turns) — forcing roleplay`);
        this.transitionToRoleplay('gathering ceiling');
      }
    }

    if (this._active?.maxTurns && this._turnCount >= this._active.maxTurns) {
      this._state = 'feedback';
      console.log(
        `[ScenarioCoachEngine] Turn limit reached (${this._turnCount}/${this._active.maxTurns}) — switching to feedback`,
      );
      this.onStateChanged?.(this._state, this._turnCount);
      this.onTurnLimitReached?.(this._turnCount);
    }
  }

  protected override handleExitDetected(phrase: string): void {
    this.setState('feedback', `exit phrase: "${phrase}"`);
    this.onExitDetected?.(phrase);
  }

  private transitionToRoleplay(reason: string): void {
    this.setState('roleplay', `${reason}, turn ${this._turnCount}`);
  }
}
