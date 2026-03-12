/**
 * RP1 server configuration and environment settings.
 */
export const Config = {
  /** Base URL for the Persona authentication server */
  AUTH_BASE_URL: "https://prod-persona.rp1.com",

  /** Member login endpoint */
  AUTH_LOGIN_PATH: "/login",

  /** Guest login endpoint */
  AUTH_GUEST_PATH: "/login/guest",

  /** Token refresh endpoint */
  AUTH_REFRESH_PATH: "/login/refresh",

  /** Request timeout in milliseconds */
  TIMEOUT_MS: 15_000,

  /** localStorage key for persisted auth token */
  TOKEN_STORAGE_KEY: "rp1_auth_token",

  /** Default persona ID used when none is provided */
  DEFAULT_PERSONA_ID: "default",
} as const;

/** Derived full endpoint URLs */
export const Endpoints = {
  login: `${Config.AUTH_BASE_URL}${Config.AUTH_LOGIN_PATH}`,
  guestLogin: `${Config.AUTH_BASE_URL}${Config.AUTH_GUEST_PATH}`,
  tokenRefresh: `${Config.AUTH_BASE_URL}${Config.AUTH_REFRESH_PATH}`,
} as const;

declare const process: { env: Record<string, string | undefined> };

export const DeepgramConfig = {
  API_KEY: process.env.DEEPGRAM_API_KEY ?? '',
  API_ENDPOINT: process.env.DEEPGRAM_API_ENDPOINT ?? 'wss://api.deepgram.com/v1/listen',
  MODEL: process.env.DEEPGRAM_MODEL_DEFAULT ?? 'nova-3',
  ENCODING: process.env.DEEPGRAM_ENCODING_DEFAULT ?? 'linear16',
  SAMPLE_RATE: Number(process.env.DEEPGRAM_SAMPLE_RATE_DEFAULT ?? '16000'),
  EOT_THRESHOLD: Number(process.env.DEEPGRAM_EOT_THRESHOLD_DEFAULT ?? '0.7'),
  EOT_TIMEOUT_MS: Number(process.env.DEEPGRAM_EOT_TIMEOUT_MS_DEFAULT ?? '5000'),

  TTS_ENDPOINT: process.env.DEEPGRAM_TTS_ENDPOINT ?? 'wss://api.deepgram.com/v1/speak',
  TTS_MODEL: process.env.DEEPGRAM_TTS_MODEL_DEFAULT ?? 'aura-2-thalia-en',
  TTS_SAMPLE_RATE: Number(process.env.DEEPGRAM_TTS_SAMPLE_RATE_DEFAULT ?? '48000'),
} as const;

export const OpenAIConfig = {
  API_KEY: process.env.OPENAI_API_KEY ?? '',
  API_ENDPOINT: process.env.OPENAI_API_ENDPOINT ?? 'https://api.openai.com/v1/chat/completions',
  MODEL: process.env.OPENAI_MODEL_DEFAULT ?? 'gpt-4o',
  MAX_HISTORY: Number(process.env.OPENAI_MAX_HISTORY_DEFAULT ?? '20'),
  TEMPERATURE: Number(process.env.OPENAI_TEMPERATURE_DEFAULT ?? '0.7'),
  SYSTEM_PROMPT: process.env.OPENAI_SYSTEM_PROMPT_DEFAULT ??
    'You are a friendly and helpful AI assistant inhabiting an avatar in a virtual world. Keep your responses concise and conversational — typically 1-3 sentences.',
  REALTIME_MODEL: process.env.OPENAI_REALTIME_MODEL ?? 'gpt-4o-mini-realtime-preview',
  REALTIME_VOICE: process.env.OPENAI_REALTIME_VOICE ?? 'alloy',
} as const;
