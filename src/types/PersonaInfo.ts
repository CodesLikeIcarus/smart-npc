export class PersonaInfo {
  readonly personaId: string;
  readonly displayName: string;
  readonly avatarUrl: string;
  readonly worldId: string;
  readonly regionId: string;
  readonly metadata: Record<string, unknown>;

  constructor(
    personaId: string,
    displayName: string,
    avatarUrl: string,
    worldId: string,
    regionId: string,
    metadata: Record<string, unknown> = {}
  ) {
    this.personaId = personaId;
    this.displayName = displayName;
    this.avatarUrl = avatarUrl;
    this.worldId = worldId;
    this.regionId = regionId;
    this.metadata = metadata;
  }

  toJSON(): Record<string, unknown> {
    return {
      personaId: this.personaId,
      displayName: this.displayName,
      avatarUrl: this.avatarUrl,
      worldId: this.worldId,
      regionId: this.regionId,
      metadata: this.metadata,
    };
  }
}
