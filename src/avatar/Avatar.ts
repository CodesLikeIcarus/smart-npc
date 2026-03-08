import { PersonaInfo } from "../types/index.js";

/**
 * Avatar - base class for all avatar representations in the world.
 * Provides common lifecycle hooks and transform management.
 */
export abstract class Avatar {
  protected personaInfo: PersonaInfo;
  protected _spawned: boolean = false;

  constructor(personaInfo: PersonaInfo) {
    this.personaInfo = personaInfo;
  }

  get spawned(): boolean {
    return this._spawned;
  }

  get personaId(): string {
    return this.personaInfo.personaId;
  }

  get displayName(): string {
    return this.personaInfo.displayName;
  }

  abstract spawn(): Promise<void>;
  abstract despawn(): Promise<void>;
}
