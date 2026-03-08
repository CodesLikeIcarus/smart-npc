# Persona Login (Avatar Stub)

Minimal but fully functional Persona authentication and session management client for RP1.

## Features

- Real MV library integration
- TypeScript with strict type safety
- Minimal dependencies (esbuild, TypeScript)
- Development server with hot reload

## Quickstart
### 1. Starting up
```
git clone https://github.com/MetaversalCorp/PersonaLogin.git
cd PersonaLogin
npm install
npm run build
npm run dev
```
### 2. Register
Register for free account at [`rp1.com`](https://my.rp1.com/signup)

*NOTE*: Confirmation code email might go to Spam folder
### 3. Run the app
Open (`http://localhost:8090`) in web browser.

Log in with registered account

### 4. Live demo
[Live demo](https://cdn.rp1.com/res/apps/personalogin/)

---

## 1. Installation Instructions

### Prerequisites

- **Node.js** v18 or later
- **npm** v9 or later (bundled with Node.js)
- **git**

### Clone the Repository

```bash
git clone https://github.com/MetaversalCorp/PersonaLogin.git
cd PersonaLogin
```

### Install Dependencies

```bash
npm install
```

> **Note:** The Metaversal MV library packages are locally stored in the vendor/mv subfolder. NOTE: They are not automatically updated.
> This is to remove dependency on the private @metaversalcorp npm packages


### Build

```bash
npm run build
```

Compiled output is written to the `deploy/` directory.

### Run / Development Server

```bash
npm run dev
```

Starts a local development server with hot reload (powered by `chokidar`). Open the URL printed to the console in your browser.


### Environment Setup

No `.env` file is required for local development. Server endpoints and session parameters are configured via the MV library's internal fabric (`@metaversalcorp/mvrp_fabric`). If your organisation requires custom endpoints, configure the MSF fabric before calling `createLnGClient()` in `LoginClient`.

---

## 2. Client App Overview

### How to run

1. `npm run dev` starts the local webserver on port 8090
2. In a web browser, go to URL `http://localhost:8090`

### The UI controls
<img width="1467" height="933" alt="image" src="https://github.com/user-attachments/assets/0768f60c-c881-4dbf-b7d6-291727c6ceeb" />

1. **Logout** Remember to logout from the page before refreshing or there might be a stale session delay

2. **Geo Pos** Enter Celestial ID 104 for EARTH, then desired Latitude and Longitude and Radius (6371000) + Height

3. Increments of approximately 10m on the [ - ] and [ + ] buttons for lat and lon

4. **Teleport** Executes a single Avatar Update message to the server

5. **Start Avatar Update** Sents Avatar Update continuously

6. **Direct Teleports** Takes you to *RP1 Start* and *Plaza* which is occupied by roaming bots constantly speaking

7. **Current Location** Cartesian co-ordinates relative to Earth Center

8. **Audio graph** Showing the stereo levels at the current location

The audio at the location will also be audibly playing back
   
### What PersonaLogin Does

PersonaLogin is the member-facing login and avatar entry client for the **Metaversal RP1** platform. It authenticates users via the MV LnG service, lets them pick a persona, loads their avatar model, and places the avatar into the virtual world. Once in-world, users can reposition their avatar (teleport) to any location on any celestial body.

### Key Workflows

| Workflow | Description |
|---|---|
| **User authentication** | Member credentials are encoded with `MV.MVMF.Encode` and passed to `pLnG.Login()`. LnG handles all HTTP communication with RP1 servers and token exchange internally. Optional 2FA is handled via a callback/promise flow. |
| **Persona selection** | After login, the user's personas are enumerated via `pRUser.Child_Enum('RPersona', …)`. The first persona is auto-selected, or the user can choose one from the picker UI. |
| **Avatar model loading** | `PersonaPuppet.spawn()` loads the avatar model via `@metaversalcorp/mvrp` at runtime. |
| **Avatar entry into world** | `pRUser.Send('RPERSONA_ENTER', …)` places the avatar at the starting location. The `pRPersona` model is opened with `pLnG.Model_Open('RPersona', personaId)`. |
| **Avatar repositioning (teleport)** | Lat/lon/radius coordinates are converted to Cartesian (Y-up) and sent as an `UPDATE` message via `pRPersona.Send('UPDATE', …)`. |

### Architecture Overview

```
LoginClient  (entry point — UI wiring + auth flow)
│
└─► UserSession  (manages pRUser; enumerates personas)
    │
    └─► PersonaSession  (manages pRPersona; RPERSONA_ENTER)
        │
        └─► InWorldSession  (manages PersonaPuppet; UPDATE messages)
            │
            └─► PersonaPuppet  (avatar controller — moveTo / sendUpdate)
```

| Class | Responsibility |
|---|---|
| `LoginClient` | Entry point. Binds all UI events, drives the auth and persona-pick flow, and delegates to `UserSession`. |
| `UserSession` | Wraps the authenticated user. Opens the `RUser` model, enumerates personas, and creates a `PersonaSession` when a persona is selected. |
| `PersonaSession` | Wraps a single persona. Opens the `RPersona` model, issues `RPERSONA_ENTER`, and manages the `InWorldSession`. |
| `InWorldSession` | World-level session. Owns the `PersonaPuppet` and sends `UPDATE` messages for avatar repositioning. |
| `PersonaLogin UI` | Bootstrap 5 HTML/CSS front-end served from `src/html/`. Shows login, 2FA, persona picker, session info, and teleport controls. |

### Key Features and Capabilities

- **Member login** with email/password and optional "remember me"
- **2FA support** via a callback that pauses the login flow
- **Persona auto-selection** (first persona) with fallback to manual picker
- **Persona creation** flow for new members with no personas
- **Lat/lon → Cartesian teleport** with named location presets
- **Live status log** of all client-side events
- **Full TypeScript** with strict mode and esbuild bundling
- **Reference implementation:** RP1Demo patterns are followed throughout

---

## 3. `Send("UPDATE", …)` Payload Structure

The `UPDATE` message is sent via `pRPersona.Send('UPDATE', payload)` to synchronise the avatar's position, rotation, and audio state with the RP1 server. It is used both during active "Avatar Send" phases and during teleportation (one-shot repositioning) from `InWorldSession.teleportTo()`).

> **Reference implementation:** See `RP1Demo` — `InWorldSession.teleportTo()`.

### Full Payload TypeScript Interface

```typescript
interface UpdatePayload {
  tmStamp: number;        // Server/client timestamp (ms). Use pRPersona.pTime if available, else Date.now().
  pState: {
    bControl: boolean;    // Control flag. Typically false / 0.
    bVolume: number;      // Volume level. 0 when muted.
    wFlag: number;        // State flags bitfield. E.g., Muted flag.
    bSerial_A: number;    // Serial counter A (increment per update, or 0).
    bSerial_B: number;    // Serial counter B (increment per update, or 0).
    wOrder: number;       // Update order index (or 0).
    bCoordSys: number;    // Coordinate system. Use 156 (Universal, matches RP1Demo PersonaPuppet).
    pPosition_Head: {
      pParent: {
        twObjectIx: number;  // Celestial object ID (e.g., 104 = default starting celestial).
        wClass: number;      // Object class. 0 for Celestial in sendUpdate(); 71 (MapModelType.Celestial) in teleportTo().
      };
      pRelative: {
        vPosition: {
          dX: number;        // X coordinate (Cartesian, Y-up).
          dY: number;        // Y coordinate (Cartesian, Y-up).
          dZ: number;        // Z coordinate (Cartesian, Y-up).
        };
      };
    };
    pRotation_Head: {
      dwV: number;           // Encoded head rotation quaternion. Call pRPersona.Quat_Encode([x, y, z, w]).
    };
    pRotation_Body: {
      dwV: number;           // Encoded body rotation quaternion. Call pRPersona.Quat_Encode([x, y, z, w]).
    };
    pPosition_Hand_Left: {
      dwV: number;           // Encoded left hand position. Call pRPersona.Vect_Encode([x, y, z]).
    };
    pRotation_Hand_Left: {
      dwV: number;           // Encoded left hand rotation quaternion. Call pRPersona.Quat_Encode([x, y, z, w]).
    };
    pPosition_Hand_Right: {
      dwV: number;           // Encoded right hand position. Call pRPersona.Vect_Encode([x, y, z]).
    };
    pRotation_Hand_Right: {
      dwV: number;           // Encoded right hand rotation quaternion. Call pRPersona.Quat_Encode([x, y, z, w]).
    };
    bHand_Left: number[];    // Left hand finger-grip array. Indices [6, 5, 4, 3, 2, 1]. Default: new Uint8Array(6) (all zeros).
    bHand_Right: number[];   // Right hand finger-grip array. Indices [16, 15, 14, 13, 12, 11]. Default: new Uint8Array(6) (all zeros).
    bFace: number[];         // Face expression blend array. Indices [24, 23, 22, 21]. Default neutral: [24, 23, 22, 21].
  };
  wSamples: number;          // Number of audio samples. 375 when audio is present; 0 when muted.
  wCodec: number;            // Audio codec. 0 = uncompressed PCM; 1 = compressed.
  wSize: number;             // Size of audio data in bytes.
  abData: Uint8Array;        // Raw audio buffer. Empty (new Uint8Array(0)) when muted.
}
```

### Field Reference

| Field | Type | Typical Value | Description |
|---|---|---|---|
| `tmStamp` | `number` | `pRPersona.pTime \|\| Date.now()` | Server-sync timestamp in milliseconds |
| `pState.bControl` | `boolean\|number` | `0` | Control flag |
| `pState.bVolume` | `number` | `0` (muted) | Volume level |
| `pState.wFlag` | `number` | `0` | State bitfield (e.g., Muted) |
| `pState.bSerial_A` | `number` | `0` | Serial counter A |
| `pState.bSerial_B` | `number` | `0` | Serial counter B |
| `pState.wOrder` | `number` | `0` | Update order index |
| `pState.bCoordSys` | `number` | `156` | Coordinate system (Universal) |
| `pState.pPosition_Head.pParent.twObjectIx` | `number` | `104` | Celestial object ID |
| `pState.pPosition_Head.pParent.wClass` | `number` | `0` or `71` | Object class (0=Celestial in basic update, 71=MapModelType.Celestial in teleport) |
| `pState.pPosition_Head.pRelative.vPosition` | `{dX,dY,dZ}` | target coords | Cartesian position (Y-up) |
| `pState.pRotation_Head.dwV` | `number` | `Quat_Encode(…)` | Encoded head quaternion |
| `pState.pRotation_Body.dwV` | `number` | `Quat_Encode(…)` | Encoded body quaternion |
| `pState.pPosition_Hand_Left.dwV` | `number` | `Vect_Encode([-0.2,-0.6,-0.1])` | Encoded left hand position |
| `pState.pRotation_Hand_Left.dwV` | `number` | `Quat_Encode([0,0,0,1])` | Encoded left hand rotation |
| `pState.pPosition_Hand_Right.dwV` | `number` | `Vect_Encode([0.2,-0.6,-0.1])` | Encoded right hand position |
| `pState.pRotation_Hand_Right.dwV` | `number` | `Quat_Encode([0,0,0,1])` | Encoded right hand rotation |
| `pState.bHand_Left` | `number[]` | `[0,0,0,0,0,0]` | Left hand finger grip values (6 elements) |
| `pState.bHand_Right` | `number[]` | `[0,0,0,0,0,0]` | Right hand finger grip values (6 elements) |
| `pState.bFace` | `number[]` | `[24,23,22,21]` | Face expression blend values (4 elements) |
| `wSamples` | `number` | `0` (muted) / `375` (audio) | Audio sample count |
| `wCodec` | `number` | `0` | Audio codec (0=uncompressed, 1=compressed) |
| `wSize` | `number` | `0` | Audio data size in bytes |
| `abData` | `Uint8Array` | `new Uint8Array(0)` | Audio buffer |

### Encoding Methods

- **`pRPersona.Quat_Encode([x, y, z, w])`** — Packs a unit quaternion `[x, y, z, w]` into a single `number` (`dwV`). Used for all rotation fields.
  - Default identity: `Quat_Encode([0, 0, 0, 1])` → no rotation
  - Upright avatar (teleport default): `Quat_Encode([0.7071068, 0, 0, 0.7071068])` → 90° rotation around X

- **`pRPersona.Vect_Encode([x, y, z])`** — Packs a 3D vector into a single `number` (`dwV`). Used for hand position fields.
  - Default left hand offset: `Vect_Encode([-0.2, -0.6, -0.1])`
  - Default right hand offset: `Vect_Encode([0.2, -0.6, -0.1])`

### Minimal Teleport Example

```typescript
const tmStamp = pRPersona.pTime ?? Date.now();

pRPersona.Send('UPDATE', {
  tmStamp,
  pState: {
    bControl: 0,
    bVolume: 0,
    wFlag: 0,
    bSerial_A: 0,
    bSerial_B: 0,
    wOrder: 0,
    bCoordSys: 156,
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
  wSamples: 0,
  wCodec: 0,
  wSize: 0,
  abData: new Uint8Array(0),
});
```

### When This Is Sent

| Trigger | Sender | Notes |
|---|---|---|
| User teleports via UI | `InWorldSession.teleportTo()` | One-shot reposition to a new celestial/coordinates |
| Avatar moves in-world | `PersonaPuppet.sendUpdate()` | Continuous position updates during normal movement |
