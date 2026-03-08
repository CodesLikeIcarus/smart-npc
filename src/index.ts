export { LoginClient } from "./client/LoginClient.js";
export { AudioVisualizer } from "./client/AudioVisualizer.js";
export type { VisualizerOptions } from "./client/AudioVisualizer.js";
export { AudioFrameCapture } from "./audio/AudioFrameCapture.js";
export type { AudioFrameCaptureOptions } from "./audio/AudioFrameCapture.js";
export { AudioFrameBuffer } from "./audio/AudioFrameBuffer.js";
export type { AudioFrameBufferInfo } from "./audio/AudioFrameBuffer.js";

export { STTService } from "./ai/STTService.js";
export type { TranscriptEvent, STTServiceOptions, STTConnectionState } from "./ai/STTService.js";
export { STTDrainLoop } from "./ai/STTDrainLoop.js";
export type { STTDrainLoopOptions } from "./ai/STTDrainLoop.js";
export { TTSService } from "./ai/TTSService.js";
export type { TTSServiceOptions, TTSConnectionState } from "./ai/TTSService.js";
export { LLMService } from "./ai/LLMService.js";
export type { LLMServiceOptions, ChatMessage } from "./ai/LLMService.js";
export { PersonaEngine } from "./persona/PersonaEngine.js";
export { ScenarioCoachEngine, SETUP_COMPLETE_MARKER } from "./persona/ScenarioCoachEngine.js";
export type { PersonaDefinition, PersonaState, ScenarioPersonaState } from "./persona/PersonaDefinition.js";
export { PERSONA_PRESETS, PERSONA_SCENARIO_COACH, PERSONA_ASSISTANT } from "./persona/presets.js";
export {
  stereoToMono,
  downsample,
  float32ToInt16,
  prepareForSTT,
  resampleTo48k,
  int16ToFloat32,
  applyAGC,
} from "./audio/PCMConverter.js";
