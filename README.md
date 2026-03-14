# Smart NPC

**LLM-powered inhabitants for the open metaverse.**

Smart NPC extends RP1's [PersonaLogin](https://github.com/MetaversalCorp/PersonaLogin) Avatar Stub to spawn autonomous, AI-driven avatars that can **hear**, **think**, and **speak** — all inside the RP1 open metaverse.

> Built by **Team Metalicious** (Daniel Schofield & Padmaja Surendranath) at the RP1 Metaverse Hackathon, March 2026.

---

## The Problem

RP1 worlds are ghost towns. Visitors arrive, look around, and leave. The existing roaming bots in RP1 Plaza are silent and brainless. Building anything smarter requires deep SDK expertise — there's no way for community builders to self-serve.

## The Solution

Smart NPC gives every world living, intelligent residents. Authenticate via RP1's existing persona auth, let an LLM generate responses and actions, and send continuous avatar UPDATE messages — no new auth flows, no SDK expertise required.

```typescript
// spawn a shopkeeper in 3 lines
import { SmartNPC } from 'smart-npc';
const npc = new SmartNPC('shopkeeper_ada', { llm: 'claude' });
await npc.spawn();   // she's live in RP1
```

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  COMMUNITY BUILDER LAYER                                │
│  Shop · Pet · Quest · Brand · Guide · Educator · RP NPC │
├─────────────────────────────────────────────────────────┤
│  SMART NPC FRAMEWORK                                    │
│  NPC Config · Persona Factory · LLM Adapter             │
│  Behavior Engine · World Bridge                         │
├─────────────────────────────────────────────────────────┤
│  RP1 PLATFORM                                           │
│  PersonaLogin SDK · Avatar UPDATE · MV Fabric           │
└─────────────────────────────────────────────────────────┘
```

### Source Layout

```
src/
├── ai/                  # AI service integrations
│   ├── STTService.ts        # Deepgram v2 Flux streaming speech-to-text
│   ├── STTDrainLoop.ts      # Timer-based drain: audio buffer → PCM → STT
│   ├── TTSService.ts        # Deepgram TTS WebSocket, gapless audio scheduling
│   ├── LLMService.ts        # OpenAI GPT-4o streaming chat completions
│   └── RealtimeService.ts   # OpenAI Realtime API (unified STT+LLM+TTS)
├── audio/               # Audio capture and encoding pipeline
│   ├── AudioFrameBuffer.ts      # Lock-free ring buffer for PCM samples
│   ├── AudioFrameCapture.ts     # Decode interception bridge
│   ├── AVStreamAudioPlayer.ts   # Spatial audio playback (GainNode → PannerNode)
│   ├── OutboundAudioEncoder.ts  # TTS → MVRP codec 0 slices for broadcast
│   ├── PCMConverter.ts          # Mono/stereo, resample, AGC, int16↔float32
│   └── ProximityAudioManager.ts # MVRP decode interceptor, format auto-detection
├── avatar/              # Avatar model and control
│   ├── Avatar.ts
│   └── PersonaPuppet.ts     # Spawn, moveTo, sendUpdate
├── client/              # Session management and UI
│   ├── LoginClient.ts       # Entry point — auth flow + UI wiring
│   ├── AuthService.ts       # Persona authentication
│   ├── UserSession.ts       # RUser model, persona enumeration
│   ├── PersonaSession.ts    # RPersona model, RPERSONA_ENTER
│   ├── InWorldSession.ts    # World session — STT/TTS/LLM/Realtime lifecycle
│   ├── AudioVisualizer.ts   # Waveform visualizer
│   └── ProximityAvatarList/Listener.ts  # Nearby avatar tracking
├── persona/             # Dynamic character profiles
│   ├── PersonaDefinition.ts     # PersonaDefinition interface + state types
│   ├── PersonaEngine.ts         # Base engine: load, turn tracking, exit detection
│   ├── ScenarioCoachEngine.ts   # Multi-phase roleplay coach (gather → roleplay → feedback)
│   └── presets.ts               # Built-in personas (Scenario Coach, Assistant, Hype Goblin)
├── types/               # Shared type definitions
├── config.ts            # Deepgram + OpenAI + RP1 configuration
└── index.ts             # Public API exports
```

---

## Key Features

| Feature | Description |
|---|---|
| **Talk** | LLM dialogue with per-NPC memory and persona. Streaming sentence-boundary detection for natural TTS pacing. |
| **Listen** | Real-time speech-to-text via Deepgram v2 Flux. Captures audio from nearby avatars through MVRP decode interception. |
| **Speak** | Text-to-speech via Deepgram Aura-2. Gapless audio scheduling. Broadcasts voice to other users via MVRP UPDATE payloads. |
| **Personas** | Dynamic character profiles — name, backstory, personality, voice, turn limits, exit phrases. Swap personas at runtime. |
| **Scenario Coach** | Multi-phase roleplay engine: guided setup → in-character roleplay → coach feedback. Configurable difficulty and turn limits. |
| **Realtime Mode** | OpenAI Realtime API — single WebSocket replaces the entire STT → LLM → TTS pipeline for lowest latency. |
| **Echo Mode** | STT → TTS round-trip for testing. Avatar repeats what it hears with feedback suppression. |
| **Outbound Audio** | TTS audio is resampled to 24 kHz, sliced into 375-sample frames, and broadcast as MVRP codec 0 in UPDATE payloads. |

### Built-in Personas

| Persona | Voice | Description |
|---|---|---|
| **Scenario Coach** | `aura-2-thalia-en` | Roleplay practice coach. Guides setup, stays in character, provides specific feedback. |
| **Virtual Assistant** | `aura-2-apollo-en` | General-purpose metaverse assistant. Concise, conversational. |
| **Hype Goblin** | `aura-2-aurora-en` | Wildly enthusiastic creature who thinks you're the greatest human alive. |

---

## Quickstart

### Prerequisites

- **Node.js** v18+
- **npm** v9+
- API keys for **Deepgram** and **OpenAI**

### Setup

```bash
git clone https://github.com/CodesLikeIcarus/smart-npc.git
cd smart-npc
npm install
```

### Environment

Create a `.env` file in the project root:

```env
# Deepgram (STT + TTS)
DEEPGRAM_API_KEY=<your-deepgram-key>

# OpenAI (LLM + Realtime)
OPENAI_API_KEY=<your-openai-key>
```

<details>
<summary>Full environment variables</summary>

```env
# Deepgram STT
DEEPGRAM_API_KEY=<key>
DEEPGRAM_API_ENDPOINT=wss://api.deepgram.com/v2/listen
DEEPGRAM_MODEL_DEFAULT=nova-3
DEEPGRAM_ENCODING_DEFAULT=linear16
DEEPGRAM_SAMPLE_RATE_DEFAULT=16000
DEEPGRAM_EOT_THRESHOLD_DEFAULT=0.7
DEEPGRAM_EOT_TIMEOUT_MS_DEFAULT=5000

# Deepgram TTS
DEEPGRAM_TTS_MODEL_DEFAULT=aura-2-thalia-en
DEEPGRAM_TTS_SAMPLE_RATE_DEFAULT=48000

# OpenAI
OPENAI_API_KEY=<key>
OPENAI_API_ENDPOINT=https://api.openai.com/v1/chat/completions
OPENAI_MODEL_DEFAULT=gpt-4o
OPENAI_MAX_HISTORY_DEFAULT=20
OPENAI_TEMPERATURE_DEFAULT=0.7
OPENAI_REALTIME_MODEL=gpt-4o-mini-realtime-preview
OPENAI_REALTIME_VOICE=alloy
```

</details>

### Build & Run

```bash
npm run build       # compile to deploy/
npm run dev         # dev server with hot reload
```

Open `http://localhost:8090`, log in with an [RP1 account](https://my.rp1.com/signup), and enter the world. Use the UI to start STT, enable AI mode, and select a persona.

### Tests

```bash
npm test            # vitest — run all tests
npm run test:watch  # watch mode
npm run typecheck   # tsc --noEmit
```

---

## Audio Pipeline

### Inbound: Nearby Avatar → STT

```
MVRP Decode (24 kHz mono Float32, peak ~0.05)
    → AudioFrameBuffer (lock-free ring buffer)
    → STTDrainLoop (100ms interval)
    → AGC (normalize to RMS 0.15, max gain 50x)
    → Downsample 24k → 16k
    → Float32 → Int16
    → Deepgram STT WebSocket
    → TranscriptEvent
```

### Outbound: TTS → Other Users

```
Deepgram TTS WebSocket
    → Binary PCM chunks (linear16 @ 48 kHz)
    → Int16 → Float32 → AudioBuffer → gapless playback (local)
    → Resample 48k → 24k → OutboundAudioEncoder ring buffer
    → Drain 375-sample slices @ 64 Hz (via pTime onTick)
    → MVRP UPDATE payload { wSamples: 375, wCodec: 0, abData }
    → pRPersona.Send('UPDATE', payload)
    → Server → other users' proximity audio
```

### Realtime Mode (Alternative)

```
MVRP Decode → resample to 24k mono → PCM16
    → OpenAI Realtime WebSocket (input_audio_buffer.append)
    → Server VAD → model response
    → audio.delta PCM16 → OutboundAudioEncoder → MVRP UPDATE
```

---

## Use Cases

| Type | Description |
|---|---|
| **Business Rep** | Greets visitors, demos products, handles sales |
| **Companion Pet** | Follows users, reacts to actions, builds emotional bonds |
| **Quest Giver** | Assigns tasks, tracks progress, distributes rewards |
| **World Guide** | Orients newcomers, explains features, leads tours |
| **Educator** | Teaches concepts, adapts to learner level, assesses understanding |
| **Roleplay NPC** | Story-driven characters with memory, emotion, and personality |

---

## Roadmap

| Version | Milestone |
|---|---|
| **v0.1** | Hackathon MVP — STT, TTS, LLM, Persona Engine, Realtime API |
| **v0.2** | Memory & State — episodic and semantic memory per character |
| **v0.3** | Multi-NPC Orchestration — multiple NPCs coordinating in a single world |
| **v1.0** | Marketplace SDK — community builders publish and share NPC templates |

---

## Tech Stack

| Layer | Technology |
|---|---|
| Language | TypeScript (strict mode) |
| Platform | RP1 SDK / Metaversal MV Fabric |
| Speech-to-Text | Deepgram v2 Flux (`nova-3`) |
| Text-to-Speech | Deepgram Aura-2 |
| LLM | OpenAI GPT-4o (streaming SSE) |
| Realtime | OpenAI Realtime API (`gpt-4o-mini-realtime-preview`) |
| Build | esbuild |
| Tests | vitest |

---

## Underlying Platform: PersonaLogin

Smart NPC builds on top of the [PersonaLogin Avatar Stub](https://github.com/MetaversalCorp/PersonaLogin), which handles:

- **Member login** with email/password and optional 2FA
- **Persona selection** from the user's RP1 account
- **Avatar model loading** via `PersonaPuppet.spawn()`
- **Avatar entry** into the world (`RPERSONA_ENTER`)
- **Avatar positioning** via `Send('UPDATE', ...)` messages with Cartesian coordinates

### Session Stack

```
LoginClient  (entry point — auth flow + UI wiring)
│
└─► UserSession  (authenticated user — persona enumeration)
    │
    └─► PersonaSession  (selected persona — RPERSONA_ENTER)
        │
        └─► InWorldSession  (world session — avatar, audio, AI pipelines)
            │
            ├─► PersonaPuppet  (avatar controller — moveTo / sendUpdate)
            ├─► ProximityAudioManager  (MVRP decode → playback)
            ├─► STTService + STTDrainLoop  (speech-to-text pipeline)
            ├─► TTSService  (text-to-speech pipeline)
            ├─► LLMService  (GPT-4o streaming completions)
            ├─► RealtimeService  (OpenAI Realtime API)
            ├─► OutboundAudioEncoder  (TTS → MVRP broadcast)
            └─► ScenarioCoachEngine  (persona state machine)
```

---

## `Send("UPDATE", ...)` Payload

The `UPDATE` message synchronises avatar position, rotation, and audio with the RP1 server. Smart NPC uses this for both teleportation and continuous audio broadcast.

<details>
<summary>Full payload interface</summary>

```typescript
interface UpdatePayload {
  tmStamp: number;
  pState: {
    bControl: boolean;
    bVolume: number;
    wFlag: number;
    bSerial_A: number;
    bSerial_B: number;
    wOrder: number;
    bCoordSys: number;            // 156 = Universal
    pPosition_Head: {
      pParent: {
        twObjectIx: number;       // Celestial object ID (e.g. 104 = Earth)
        wClass: number;           // 0 or 71 (MapModelType.Celestial)
      };
      pRelative: {
        vPosition: { dX: number; dY: number; dZ: number };
      };
    };
    pRotation_Head: { dwV: number };
    pRotation_Body: { dwV: number };
    pPosition_Hand_Left: { dwV: number };
    pRotation_Hand_Left: { dwV: number };
    pPosition_Hand_Right: { dwV: number };
    pRotation_Hand_Right: { dwV: number };
    bHand_Left: number[];         // 6-element finger grip array
    bHand_Right: number[];        // 6-element finger grip array
    bFace: number[];              // 4-element face blend [24, 23, 22, 21]
  };
  wSamples: number;               // 0 (muted) or 375 (audio)
  wCodec: number;                  // 0 = PCM16, 1 = delta
  wSize: number;                   // Audio data size in bytes
  abData: Uint8Array;              // Raw audio buffer
}
```

</details>

<details>
<summary>Minimal teleport example</summary>

```typescript
pRPersona.Send('UPDATE', {
  tmStamp: pRPersona.pTime ?? Date.now(),
  pState: {
    bControl: 0, bVolume: 0, wFlag: 0,
    bSerial_A: 0, bSerial_B: 0, wOrder: 0, bCoordSys: 156,
    pPosition_Head: {
      pParent: { twObjectIx: celestialId, wClass: 71 },
      pRelative: { vPosition: { dX: x, dY: y, dZ: z } },
    },
    pRotation_Head:       { dwV: pRPersona.Quat_Encode([0.7071068, 0, 0, 0.7071068]) },
    pRotation_Body:       { dwV: pRPersona.Quat_Encode([0.7071068, 0, 0, 0.7071068]) },
    pPosition_Hand_Left:  { dwV: pRPersona.Vect_Encode([-0.2, -0.6, -0.1]) },
    pRotation_Hand_Left:  { dwV: pRPersona.Quat_Encode([0, 0, 0, 1]) },
    pPosition_Hand_Right: { dwV: pRPersona.Vect_Encode([0.2, -0.6, -0.1]) },
    pRotation_Hand_Right: { dwV: pRPersona.Quat_Encode([0, 0, 0, 1]) },
    bHand_Left:  Array.from(new Uint8Array(6)),
    bHand_Right: Array.from(new Uint8Array(6)),
    bFace: [24, 23, 22, 21],
  },
  wSamples: 0, wCodec: 0, wSize: 0,
  abData: new Uint8Array(0),
});
```

</details>

---

## Contributing

Open source. Fork it. Extend it. Deploy it.

```
github.com/CodesLikeIcarus/smart-npc
```

---

*Smart NPC · RP1 Metaverse Hackathon · 2026*
