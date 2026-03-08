export interface PersonaDefinition {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  voice: string;
  maxTurns: number;
  exitPhrases: string[];
}

export type PersonaState = 'idle' | 'active' | 'complete';

export type ScenarioPersonaState = 'idle' | 'gathering' | 'roleplay' | 'feedback' | 'complete';
