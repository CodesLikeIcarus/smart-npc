// MV is a global namespace populated by side-effect imports in LnG.ts.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const MV: any;
import { createLnGClient, ILnGClient, LnGUser, LnGPersona, GUEST_EMAIL } from "../mv/LnG.js";
import { UserSession } from "./UserSession.js";
import { ConnectionState } from "../types/index.js";
import { PERSONA_PRESETS } from "../persona/presets.js";

/** Credentials exported so callers can reference the same type. */
export interface LoginCredentials {
  email: string;
  password: string;
  remember?: boolean;
}

/** Time (ms) to wait for the RUser model's onReadyState + Child_Enum to complete. */
const PERSONA_ENUM_WAIT_MS = 500;

/**
 * LoginClient — drives the RP1 login UI in index.html.
 *
 * Uses MV LnG (Log-n-Go) for authentication instead of direct HTTP calls.
 * LnG manages all communication with RP1 servers and token exchange internally.
 *
 * Login flow:
 *   1. Member/guest credentials → pLnG.Login() → LnGUser (with persona list)
 *   2. Show persona picker → user picks or auto-pick first persona
 *   3. userSession.pickPersona(id) → PersonaSession → InWorld
 *
 * 2FA flow:
 *   pLnG.Login() invokes the finalizationHandler when a code is required.
 *   LoginClient shows the 2FA route and resolves the pending promise once
 *   the user submits the code.
 */
export class LoginClient {
  private _pLnG: ILnGClient;
  private userSession: UserSession | null = null;
  private pendingUser: LnGUser | null = null;
  private avatarUpdateActive = false;

  constructor(_container: HTMLElement) {
    this._pLnG = createLnGClient();
    this.bindUI();
  }

  // ─── Public getters ────────────────────────────────────────────────────────

  /**
   * Public accessor for pLnG instance.
   * Required by UserSession and PersonaSession constructors.
   */
  get pLnG(): ILnGClient {
    return this._pLnG;
  }

  /**
   * Returns the active UserSession once authenticated, or `null` before login.
   * Use `userSession.personaSession?.inWorld?.audio` to reach the audio manager.
   */
  get session(): UserSession | null {
    return this.userSession;
  }

  // ─── UI helpers ────────────────────────────────────────────────────────────

  private el<T extends HTMLElement>(id: string): T | null {
    return document.getElementById(id) as T | null;
  }

  private showRoute(id: string): void {
    const routes = [
      "not-logged-in-route",
      "guest-sign-in-route",
      "login-route",
      "persona-picker-route",
      "tfa-route",
    ];
    for (const r of routes) {
      const el = this.el(r);
      if (el) el.classList.toggle("d-none", r !== id);
    }
  }

  private showSection(section: "login" | "session"): void {
    const loginSection = this.el("login-section");
    const sessionSection = this.el("session-section");
    if (loginSection) loginSection.classList.toggle("d-none", section !== "login");
    if (sessionSection) sessionSection.classList.toggle("d-none", section !== "session");
  }

  updateStatusBadge(type: "pending" | "success" | "error" | "logged-in" | "refresh-required"): void {
    const badge = document.querySelector<HTMLElement>("#status-panel .status-badge");
    if (!badge) return;
    badge.className = `status-badge ${type}`;
    const labels: Record<string, string> = {
      pending: "Pending",
      success: "Connected",
      error: "Error",
      "logged-in": "Logged In",
      "refresh-required": "REFRESH REQUIRED",
    };
    badge.textContent = labels[type] ?? type;
  }

  appendStatus(message: string): void {
    const content = this.el("status-content");
    if (!content) return;
    const line = document.createElement("div");
    const now = new Date().toLocaleTimeString();
    line.textContent = `[${now}] ${message}`;
    content.appendChild(line);
    content.scrollTop = content.scrollHeight;
  }

  private updateSessionInfo(): void {
    const info = this.el("session-info");
    if (!info || !this.userSession) return;

    const session = this.userSession;
    info.innerHTML = `<pre>${JSON.stringify(
      {
        userId: session.userId,
        displayName: session.username,
        personas: session.ownPersonaList.map((p) => ({ id: p.id, name: p.displayName })),
        connectionState: session.state,
      },
      null,
      2
    )}</pre>`;
  }

  // ─── Persona picker ────────────────────────────────────────────────────────

  /**
   * Auto-pick the first persona without showing the picker UI.
   */
  private showPersonaPicker(user: LnGUser): void {
    this.pendingUser = user;

    if (user.personas.length > 0) {
      this.appendStatus(`Auto-picking persona "${user.personas[0].displayName}".`);
      void this.onPersonaPicked(user.personas[0].id).catch((err) => {
        this.updateStatusBadge("error");
        this.appendStatus(`Persona error: ${(err as Error).message}`);
      });
    } else {
      this.appendStatus("No personas found. Create a new persona to continue.");
      this.showRoute("persona-picker-route");
    }
  }

  private async onPersonaPicked(personaId: string): Promise<void> {
    if (!this.pendingUser) return;
    const user = this.pendingUser;
    this.pendingUser = null;

    this.userSession = new UserSession(user, this);
    await this.userSession.connect();

    this.appendStatus(`Entering world with persona ${personaId}…`);
    try {
      await this.userSession.pickPersona(personaId);
      this.onSessionStarted();
    } catch (err) {
      this.updateStatusBadge("error");
      this.appendStatus(`Persona error: ${(err as Error).message}`);
    }
  }

  private onSessionStarted(): void {
    if (!this.userSession) return;

    const displayNameEl = this.el("user-display-name");
    if (displayNameEl) displayNameEl.textContent = this.userSession.username;

    this.showSection("session");
    this.updateStatusBadge("logged-in");
    this.updateSessionInfo();
    this.appendStatus(
      `Session started as "${this.userSession.username}" (${this.userSession.userId})`
    );

    this.bindSTTControls();
    this.bindTTSControls();
  }

  // ─── Event binding ─────────────────────────────────────────────────────────

  private bindUI(): void {
    // Navigation between login views
    this.el("login-guest-button")?.addEventListener("click", () => {
      this.showRoute("guest-sign-in-route");
    });
    this.el("login-or-create-button")?.addEventListener("click", () => {
      this.showRoute("login-route");
    });
    this.el("guest-cancel-button")?.addEventListener("click", () => {
      this.showRoute("not-logged-in-route");
    });
    this.el("login-back-button")?.addEventListener("click", () => {
      this.showRoute("not-logged-in-route");
    });

    // Guest login form
    this.el("guest-form")?.addEventListener("submit", (e) => {
      e.preventDefault();
      void this.handleGuestLogin();
    });

    // Member login form
    this.el("login-form")?.addEventListener("submit", (e) => {
      e.preventDefault();
      const email =
        (this.el<HTMLInputElement>("login-email")?.value ?? "").trim();
      const password = this.el<HTMLInputElement>("login-password")?.value ?? "";
      const remember =
        this.el<HTMLInputElement>("login-remember")?.checked ?? false;
      if (!email || !password) return;
      void this.handleMemberLogin({ email, password, remember });
    });

    // Password visibility toggle
    this.el("vis-login-password")?.addEventListener("click", () => {
      const pw = this.el<HTMLInputElement>("login-password");
      if (!pw) return;
      pw.type = pw.type === "password" ? "text" : "password";
    });

    // Persona picker — create new persona button
    this.el("create-persona-button")?.addEventListener("click", () => {
      void this.handleCreatePersona();
    });

    // 2FA form
    this.el("tfa-form")?.addEventListener("submit", (e) => {
      e.preventDefault();
      const code = (this.el<HTMLInputElement>("tfa-code")?.value ?? "").trim();
      if (!code) return;
      this.submitTfaCode(code);
    });

    // Logout
    this.el("logout-button-main")?.addEventListener("click", () => {
      void this.handleLogout();
    });

    // Single teleport button
    this.el("teleport-now-button")?.addEventListener("click", () => {
      this.handleTeleport();
    });

    // Avatar update toggle button
    this.el("teleport-button")?.addEventListener("click", () => {
      this.handleAvatarUpdateToggle();
    });

    // Lat/lon fine-tuning increment/decrement buttons
    this.el("lat-decr")?.addEventListener("click", () => {
      this.adjustLatLon("teleport-latitude", -0.0001);
    });
    this.el("lat-incr")?.addEventListener("click", () => {
      this.adjustLatLon("teleport-latitude", 0.0001);
    });
    this.el("lon-decr")?.addEventListener("click", () => {
      this.adjustLatLon("teleport-longitude", -0.0001);
    });
    this.el("lon-incr")?.addEventListener("click", () => {
      this.adjustLatLon("teleport-longitude", 0.0001);
    });

    // Radius fine-tuning increment/decrement buttons (±1.0 m)
    this.el("radius-decr")?.addEventListener("click", () => {
      this.adjustLatLon("teleport-radius", -1.0);
    });
    this.el("radius-incr")?.addEventListener("click", () => {
      this.adjustLatLon("teleport-radius", 1.0);
    });

    // Location presets
    document.querySelectorAll<HTMLElement>(".location-preset").forEach((btn) => {
      btn.addEventListener("click", () => {
        const celestial = btn.dataset["celestial"] ?? "";
        const lat = btn.dataset["lat"] ?? "0";
        const lon = btn.dataset["lon"] ?? "0";
        const radius = btn.dataset["radius"] ?? "6371000";
        this.setTeleportInputs(celestial, lat, lon, radius);
        this.handleTeleport();
      });
    });

    // Clear status log
    this.el("clear-status-btn")?.addEventListener("click", () => {
      const content = this.el("status-content");
      if (content) content.innerHTML = "";
    });
  }

  // ─── Auth handlers ─────────────────────────────────────────────────────────

  /**
   * Member login — calls pLnG.Login(MV.MVMF.Encode({ contact, password, remember }), finalizationHandler).
   * MV LnG handles all HTTP communication with RP1 servers internally.
   */
  private async handleMemberLogin(credentials: LoginCredentials): Promise<void> {
    const btn = this.el<HTMLButtonElement>("login-button");
    if (btn) btn.disabled = true;

    this.updateStatusBadge("pending");
    this.appendStatus("Connecting to RP1 via MV LnG…");

    try {
      const encoded = MV.MVMF.Encode({ contact: credentials.email, password: credentials.password, remember: credentials.remember });
      const user = await this._pLnG.Login(
        encoded,
        (resolve2FA) => {
          this.appendStatus("2FA required — enter confirmation code.");
          this.showTfaRoute(resolve2FA);
        }
      );
      ///this.appendStatus(`Authenticated as "${user.displayName}".`);
      this.updateStatusBadge("success");

      this.pendingUser = user;
      this.userSession = new UserSession(user, this);
      await this.userSession.connect();

      // Wait for personas to be enumerated by onReadyState/Child_Enum
      await new Promise<void>((resolve) => setTimeout(resolve, PERSONA_ENUM_WAIT_MS));

      const personas = this.userSession.ownPersonaList;
      if (personas.length > 0) {
        this.appendStatus(`Auto-picking persona "${personas[0].displayName}".`);
        try {
          await this.userSession.pickPersona(personas[0].id);
          this.onSessionStarted();
        } catch (err) {
          this.updateStatusBadge("error");
          this.appendStatus(`Persona error: ${(err as Error).message}`);
        }
      } else {
        this.appendStatus("No personas found. Create a new persona to continue.");
        this.showRoute("persona-picker-route");
      }
    } catch (err) {
      this.updateStatusBadge("error");
      this.appendStatus(`Login error: ${(err as Error).message}`);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  /**
   * Guest login — calls pLnG.Login(MV.MVMF.Encode({ contact: GUEST_EMAIL, password: GUEST_EMAIL })).
   * MV LnG requires both contact and password fields to initiate an anonymous session.
   * Guests skip RPERSONA_OPEN and go directly to RPERSONA_ENTER via pickPersona().
   */
  private async handleGuestLogin(): Promise<void> {
    const btn = this.el<HTMLButtonElement>("guest-join-button");
    if (btn) btn.disabled = true;

    this.updateStatusBadge("pending");
    this.appendStatus("Connecting to RP1 as guest via MV LnG…");

    try {
      const user = await this._pLnG.Login(MV.MVMF.Encode({ contact: GUEST_EMAIL, password: GUEST_EMAIL }));
      this.appendStatus(`Guest session started.`);
      this.updateStatusBadge("success");

      this.userSession = new UserSession(user);
      await this.userSession.connect();

      // Wait for personas to be enumerated by onReadyState/Child_Enum
      await new Promise<void>((resolve) => setTimeout(resolve, PERSONA_ENUM_WAIT_MS));

      const personaId = this.userSession.ownPersonaList[0]?.id ?? "0";
      this.appendStatus(`Opening persona ${personaId}…`);
      await this.userSession.pickPersona(personaId);
      this.onSessionStarted();
    } catch (err) {
      this.updateStatusBadge("error");
      this.appendStatus(`Guest login error: ${(err as Error).message}`);
      if (this.userSession) {
        await this.userSession.disconnect();
        this.userSession = null;
      }
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  private async handleCreatePersona(): Promise<void> {
    if (!this.pendingUser) return;

    const user = this.pendingUser;
    this.userSession = new UserSession(user);
    await this.userSession.connect();

    this.appendStatus(`Opening persona…`);
    try {
      await this.userSession.pickPersona("0");
      this.onSessionStarted();
    } catch (err) {
      this.updateStatusBadge("error");
      this.appendStatus(`Open persona error: ${(err as Error).message}`);
    }
  }

  private async handleLogout(): Promise<void> {
    this.avatarUpdateActive = false;
    const btn = this.el<HTMLButtonElement>("teleport-button");
    if (btn) {
      btn.innerHTML = '<i class="fa-solid fa-satellite-dish"></i> Start Avatar Updates';
      btn.classList.remove("active");
    }

    await this._pLnG.Logout();
    if (this.userSession) {
      await this.userSession.disconnect();
      this.userSession = null;
    }
    this.pendingUser = null;

    this.showSection("login");
    this.showRoute("not-logged-in-route");
    this.updateStatusBadge("pending");
    this.appendStatus("Logged out.");
  }

  // ─── 2FA ───────────────────────────────────────────────────────────────────

  private pendingTfaResolve: ((code: string) => void) | null = null;

  private showTfaRoute(resolve2FA: (code: string) => void): void {
    this.pendingTfaResolve = resolve2FA;
    const codeInput = this.el<HTMLInputElement>("tfa-code");
    if (codeInput) codeInput.value = "";
    this.showRoute("tfa-route");
  }

  private submitTfaCode(code: string): void {
    if (!this.pendingTfaResolve) return;
    const resolve = this.pendingTfaResolve;
    this.pendingTfaResolve = null;
    this.appendStatus("Submitting 2FA code…");
    resolve(code);
  }

  // ─── Teleport ──────────────────────────────────────────────────────────────

  private adjustLatLon(inputId: string, delta: number): void {
    const input = this.el<HTMLInputElement>(inputId);
    if (!input) return;
    const current = parseFloat(input.value) || 0;
    input.value = (current + delta).toFixed(4);
  }

  private handleAvatarUpdateToggle(): void {
    this.avatarUpdateActive = !this.avatarUpdateActive;
    const btn = this.el<HTMLButtonElement>("teleport-button");

    if (this.avatarUpdateActive) {
      if (btn) {
        btn.innerHTML = '<i class="fa-solid fa-satellite-dish"></i> Avatar Updates Sending Active';
        btn.classList.add("active");
      }
      console.log('[LoginClient] Registering avatar update callback (pTime-driven)');
      this.userSession?.personaSession?.setAvatarUpdateCallback(() => {
        try {
          this.sendAvatarUpdate();
        } catch (err) {
          console.error('[LoginClient] sendAvatarUpdate error:', err);
        }
      });
    } else {
      if (btn) {
        btn.innerHTML = '<i class="fa-solid fa-satellite-dish"></i> Start Avatar Updates';
        btn.classList.remove("active");
      }
      console.log('[LoginClient] Clearing avatar update callback');
      this.userSession?.personaSession?.setAvatarUpdateCallback(null);
    }
  }

  private sendAvatarUpdate(): void {
    const celestial =
      (this.el<HTMLInputElement>("celestial-id")?.value ?? "").trim();
    const lat = parseFloat(
      this.el<HTMLInputElement>("teleport-latitude")?.value ?? "0"
    );
    const lon = parseFloat(
      this.el<HTMLInputElement>("teleport-longitude")?.value ?? "0"
    );
    const radius = parseFloat(
      this.el<HTMLInputElement>("teleport-radius")?.value ?? "0"
    );

    if (!celestial || isNaN(lat) || isNaN(lon) || isNaN(radius)) return;

    const [dx, dy, dz] = latLonToCartesianYUp(lat, lon, radius);
    this.userSession?.teleportTo(celestial, { x: dx, y: dy, z: dz });
  }

  private setTeleportInputs(
    celestial: string,
    lat: string,
    lon: string,
    radius: string
  ): void {
    const set = (id: string, val: string): void => {
      const el = this.el<HTMLInputElement>(id);
      if (el) el.value = val;
    };
    set("celestial-id", celestial);
    set("teleport-latitude", lat);
    set("teleport-longitude", lon);
    set("teleport-radius", radius);
  }

  // ─── STT controls ──────────────────────────────────────────────────────

  private sttBound = false;
  private interimLineEl: HTMLElement | null = null;

  private bindSTTControls(): void {
    if (this.sttBound) return;
    this.sttBound = true;

    this.el("stt-start-btn")?.addEventListener("click", () => {
      void this.handleSTTStart();
    });

    this.el("stt-stop-btn")?.addEventListener("click", () => {
      this.handleSTTStop();
    });

    this.el("stt-clear-log-btn")?.addEventListener("click", () => {
      const log = this.el("stt-transcript-log");
      if (log) log.innerHTML = "";
      this.interimLineEl = null;
    });
  }

  private async handleSTTStart(): Promise<void> {
    const inWorld = this.userSession?.personaSession?.inWorld;
    if (!inWorld) {
      this.appendStatus("STT: Not in-world yet.");
      return;
    }

    const startBtn = this.el<HTMLButtonElement>("stt-start-btn");
    const stopBtn = this.el<HTMLButtonElement>("stt-stop-btn");
    const badge = this.el("stt-status-badge");

    if (startBtn) startBtn.disabled = true;

    try {
      inWorld.onTranscript = (event) => {
        this.appendTranscript(event.text, event.isFinal, event.confidence);
      };

      await inWorld.startSTT();

      if (stopBtn) stopBtn.disabled = false;
      if (badge) {
        badge.textContent = "Listening";
        badge.className = "stt-connection-status on";
      }
      this.appendStatus("STT: Listening to nearby avatars...");
    } catch (err) {
      if (startBtn) startBtn.disabled = false;
      this.appendStatus(`STT error: ${(err as Error).message}`);
    }
  }

  private handleSTTStop(): void {
    const inWorld = this.userSession?.personaSession?.inWorld;
    inWorld?.stopSTT();

    const startBtn = this.el<HTMLButtonElement>("stt-start-btn");
    const stopBtn = this.el<HTMLButtonElement>("stt-stop-btn");
    const badge = this.el("stt-status-badge");

    if (startBtn) startBtn.disabled = false;
    if (stopBtn) stopBtn.disabled = true;
    if (badge) {
      badge.textContent = "Disconnected";
      badge.className = "stt-connection-status off";
    }
    this.interimLineEl = null;
    this.appendStatus("STT: Stopped.");
  }

  // ─── TTS controls ──────────────────────────────────────────────────────

  private ttsBound = false;

  private bindTTSControls(): void {
    if (this.ttsBound) return;
    this.ttsBound = true;

    this.el("tts-connect-btn")?.addEventListener("click", () => {
      void this.handleTTSConnect();
    });

    this.el("tts-disconnect-btn")?.addEventListener("click", () => {
      this.handleTTSDisconnect();
    });

    this.el("tts-speak-btn")?.addEventListener("click", () => {
      this.handleTTSSpeak();
    });

    this.el<HTMLInputElement>("tts-text-input")?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") this.handleTTSSpeak();
    });

    this.el("echo-toggle-btn")?.addEventListener("click", () => {
      this.handleEchoToggle();
    });

    this.el("ai-toggle-btn")?.addEventListener("click", () => {
      this.handleAIToggle();
    });

    this.el<HTMLSelectElement>("persona-select")?.addEventListener("change", (e) => {
      this.handlePersonaSelect((e.target as HTMLSelectElement).value);
    });

    this.el("persona-reset-btn")?.addEventListener("click", () => {
      this.handlePersonaReset();
    });
  }

  private async handleTTSConnect(): Promise<void> {
    const inWorld = this.userSession?.personaSession?.inWorld;
    if (!inWorld) {
      this.appendStatus("TTS: Not in-world yet.");
      return;
    }

    const connectBtn = this.el<HTMLButtonElement>("tts-connect-btn");
    const disconnectBtn = this.el<HTMLButtonElement>("tts-disconnect-btn");
    const speakBtn = this.el<HTMLButtonElement>("tts-speak-btn");
    const badge = this.el("tts-status-badge");
    const voiceSelect = this.el<HTMLSelectElement>("tts-voice-select");

    if (connectBtn) connectBtn.disabled = true;

    try {
      const selectedVoice = voiceSelect?.value;
      await inWorld.startTTS({ voice: selectedVoice });

      if (disconnectBtn) disconnectBtn.disabled = false;
      if (speakBtn) speakBtn.disabled = false;
      if (badge) {
        badge.textContent = "Connected";
        badge.className = "stt-connection-status on";
      }
      const echoBtn = this.el<HTMLButtonElement>("echo-toggle-btn");
      if (echoBtn) echoBtn.disabled = false;
      const aiBtn = this.el<HTMLButtonElement>("ai-toggle-btn");
      if (aiBtn) aiBtn.disabled = false;
      this.appendStatus(`TTS: Connected (voice: ${selectedVoice ?? 'default'})`);
    } catch (err) {
      if (connectBtn) connectBtn.disabled = false;
      this.appendStatus(`TTS error: ${(err as Error).message}`);
    }
  }

  private handleTTSDisconnect(): void {
    const inWorld = this.userSession?.personaSession?.inWorld;
    if (inWorld?.isAIMode) {
      inWorld.setAIMode(false);
      this.updateAIBadge(false);
    }
    if (inWorld?.isEchoMode) {
      inWorld.setEchoMode(false);
      this.updateEchoBadge(false);
    }
    inWorld?.stopTTS();

    const connectBtn = this.el<HTMLButtonElement>("tts-connect-btn");
    const disconnectBtn = this.el<HTMLButtonElement>("tts-disconnect-btn");
    const speakBtn = this.el<HTMLButtonElement>("tts-speak-btn");
    const badge = this.el("tts-status-badge");

    if (connectBtn) connectBtn.disabled = false;
    if (disconnectBtn) disconnectBtn.disabled = true;
    if (speakBtn) speakBtn.disabled = true;
    if (badge) {
      badge.textContent = "Disconnected";
      badge.className = "stt-connection-status off";
    }
    const echoBtn = this.el<HTMLButtonElement>("echo-toggle-btn");
    if (echoBtn) echoBtn.disabled = true;
    const aiBtn = this.el<HTMLButtonElement>("ai-toggle-btn");
    if (aiBtn) aiBtn.disabled = true;
    this.appendStatus("TTS: Disconnected.");
  }

  private handleTTSSpeak(): void {
    const inWorld = this.userSession?.personaSession?.inWorld;
    const input = this.el<HTMLInputElement>("tts-text-input");
    const text = input?.value?.trim();

    if (!text) return;
    if (!inWorld?.isTTSActive) {
      this.appendStatus("TTS: Not connected — click Connect first.");
      return;
    }

    inWorld.speak(text);
    this.appendStatus(`TTS: Speaking "${text.slice(0, 60)}${text.length > 60 ? '...' : ''}"`);
    if (input) input.value = "";
  }

  private handleEchoToggle(): void {
    const inWorld = this.userSession?.personaSession?.inWorld;
    if (!inWorld) {
      this.appendStatus("Echo: Not in-world yet.");
      return;
    }

    if (!inWorld.isTTSActive) {
      this.appendStatus("Echo: Connect TTS first.");
      return;
    }

    if (!inWorld.isSTTActive) {
      this.appendStatus("Echo: Start STT first.");
      return;
    }

    const newState = !inWorld.isEchoMode;
    inWorld.setEchoMode(newState);
    this.updateEchoBadge(newState);
    this.appendStatus(`Echo mode: ${newState ? "ON" : "OFF"}`);
  }

  private updateEchoBadge(on: boolean): void {
    const btn = this.el<HTMLButtonElement>("echo-toggle-btn");
    const badge = this.el("echo-status-badge");
    if (btn) {
      btn.innerHTML = on
        ? '<i class="fa-solid fa-arrows-rotate"></i> Disable Echo Mode'
        : '<i class="fa-solid fa-arrows-rotate"></i> Enable Echo Mode';
      btn.classList.toggle("btn-outline-warning", !on);
      btn.classList.toggle("btn-warning", on);
    }
    if (badge) {
      badge.textContent = on ? "Active" : "Off";
      badge.className = on ? "stt-connection-status on" : "stt-connection-status off";
    }
  }

  private handleAIToggle(): void {
    const inWorld = this.userSession?.personaSession?.inWorld;
    if (!inWorld) {
      this.appendStatus("AI: Not in-world yet.");
      return;
    }

    if (!inWorld.isTTSActive) {
      this.appendStatus("AI: Connect TTS first.");
      return;
    }

    if (!inWorld.isSTTActive) {
      this.appendStatus("AI: Start STT first.");
      return;
    }

    const newState = !inWorld.isAIMode;

    if (newState) {
      const select = this.el<HTMLSelectElement>("persona-select");
      const selectedId = select?.value ?? 'scenario-coach';
      const preset = PERSONA_PRESETS.find(p => p.id === selectedId);
      if (preset) {
        inWorld.loadPersona(preset);
      }

      inWorld.persona.onStateChanged = (state, turnCount) => {
        this.updatePersonaStatus(state, turnCount);
      };
      inWorld.persona.onExitDetected = (phrase) => {
        this.appendStatus(`Persona: Exit detected ("${phrase}") — switching to feedback`);
      };
      inWorld.persona.onTurnLimitReached = (count) => {
        this.appendStatus(`Persona: Turn limit reached (${count}) — switching to feedback`);
      };

      inWorld.onAIResponse = (sentence) => {
        this.appendAITranscript(sentence);
      };
    }

    inWorld.setAIMode(newState);
    this.updateAIBadge(newState);
    if (newState) {
      this.updateEchoBadge(false);
      this.updatePersonaStatus('gathering', 0);
    } else {
      inWorld.onAIResponse = null;
      this.updatePersonaStatus('idle', 0);
    }
    this.appendStatus(`AI mode: ${newState ? "ON" : "OFF"}`);
  }

  private updateAIBadge(on: boolean): void {
    const btn = this.el<HTMLButtonElement>("ai-toggle-btn");
    const badge = this.el("ai-status-badge");
    if (btn) {
      btn.innerHTML = on
        ? '<i class="fa-solid fa-brain"></i> Disable AI Mode'
        : '<i class="fa-solid fa-brain"></i> Enable AI Mode';
      btn.classList.toggle("btn-outline-info", !on);
      btn.classList.toggle("btn-info", on);
    }
    if (badge) {
      badge.textContent = on ? "Active" : "Off";
      badge.className = on ? "stt-connection-status on" : "stt-connection-status off";
    }
  }

  private handlePersonaSelect(personaId: string): void {
    const inWorld = this.userSession?.personaSession?.inWorld;
    if (!inWorld) return;

    const preset = PERSONA_PRESETS.find(p => p.id === personaId);
    if (!preset) return;

    if (inWorld.isAIMode) {
      inWorld.loadPersona(preset);
      inWorld.llm?.clearHistory();
      this.updatePersonaStatus('gathering', 0);
      this.appendStatus(`Persona: Switched to "${preset.name}"`);
    }
  }

  private handlePersonaReset(): void {
    const inWorld = this.userSession?.personaSession?.inWorld;
    if (!inWorld) return;

    inWorld.persona.reset();
    inWorld.llm?.clearHistory();
    const prompt = inWorld.persona.buildTurnAwarePrompt();
    inWorld.llm?.setSystemPrompt(prompt);
    this.updatePersonaStatus(inWorld.persona.state, 0);
    this.appendStatus('Persona: Session reset — starting fresh');
  }

  private updatePersonaStatus(state: string, turnCount: number): void {
    const stateEl = this.el("persona-state");
    const turnEl = this.el("persona-turns");
    const inWorld = this.userSession?.personaSession?.inWorld;
    const maxTurns = inWorld?.persona.maxTurns ?? 0;

    if (stateEl) {
      const labels: Record<string, string> = {
        idle: 'Idle',
        gathering: 'Setup',
        roleplay: 'Roleplay',
        feedback: 'Feedback',
        complete: 'Complete',
      };
      stateEl.textContent = labels[state] ?? state;
      stateEl.className = state === 'roleplay' ? 'stt-connection-status on'
        : state === 'feedback' ? 'stt-connection-status on'
        : 'stt-connection-status off';
    }

    if (turnEl) {
      turnEl.textContent = maxTurns
        ? `${turnCount}/${maxTurns}`
        : `${turnCount}`;
    }
  }

  private appendTranscript(text: string, isFinal: boolean, confidence: number): void {
    const log = this.el("stt-transcript-log");
    if (!log) return;

    const ts = new Date().toLocaleTimeString();

    if (isFinal) {
      if (this.interimLineEl) {
        this.interimLineEl.remove();
        this.interimLineEl = null;
      }

      const line = document.createElement("div");
      line.className = "transcript-line final";

      const tsSpan = document.createElement("span");
      tsSpan.className = "ts";
      tsSpan.textContent = ts;
      line.appendChild(tsSpan);

      line.appendChild(document.createTextNode(text));

      const confSpan = document.createElement("span");
      confSpan.className = "confidence";
      confSpan.textContent = `${(confidence * 100).toFixed(0)}%`;
      line.appendChild(confSpan);

      log.appendChild(line);
    } else {
      if (!this.interimLineEl) {
        this.interimLineEl = document.createElement("div");
        this.interimLineEl.className = "transcript-line interim";
        log.appendChild(this.interimLineEl);
      }
      this.interimLineEl.textContent = `${ts}  ${text}...`;
    }

    log.scrollTop = log.scrollHeight;
  }

  private appendAITranscript(text: string): void {
    const log = this.el("stt-transcript-log");
    if (!log) return;

    const ts = new Date().toLocaleTimeString();
    const line = document.createElement("div");
    line.className = "transcript-line ai-response";

    const tsSpan = document.createElement("span");
    tsSpan.className = "ts";
    tsSpan.textContent = ts;
    line.appendChild(tsSpan);

    const label = document.createElement("span");
    label.className = "ai-label";
    label.textContent = "AI: ";
    line.appendChild(label);

    line.appendChild(document.createTextNode(text));
    log.appendChild(line);
    log.scrollTop = log.scrollHeight;
  }

  // ─── Teleport ──────────────────────────────────────────────────────────

  private handleTeleport(): void {
    const celestial =
      (this.el<HTMLInputElement>("celestial-id")?.value ?? "").trim();
    const lat = parseFloat(
      this.el<HTMLInputElement>("teleport-latitude")?.value ?? "0"
    );
    const lon = parseFloat(
      this.el<HTMLInputElement>("teleport-longitude")?.value ?? "0"
    );
    const radius = parseFloat(
      this.el<HTMLInputElement>("teleport-radius")?.value ?? "0"
    );

    if (!celestial || isNaN(lat) || isNaN(lon) || isNaN(radius)) {
      this.appendStatus("Teleport: invalid coordinates.");
      return;
    }

    const [dx, dy, dz] = latLonToCartesianYUp(lat, lon, radius);

    const fmt = (n: number): string => n.toFixed(2);
    const elDx = this.el("coord-dx");
    const elDy = this.el("coord-dy");
    const elDz = this.el("coord-dz");
    if (elDx) elDx.textContent = fmt(dx);
    if (elDy) elDy.textContent = fmt(dy);
    if (elDz) elDz.textContent = fmt(dz);

    const elCelestial = this.el("current-celestial");
    const elPosition = this.el("current-position");
    if (elCelestial) elCelestial.textContent = celestial;
    if (elPosition) {
      elPosition.textContent = `${Math.abs(lat).toFixed(4)}°${lat >= 0 ? "N" : "S"}, ${Math.abs(lon).toFixed(4)}°${lon >= 0 ? "E" : "W"}, ${radius}m`;
    }

    // Send teleport via persona puppet if in-world session is active
    this.userSession?.teleportTo(celestial, { x: dx, y: dy, z: dz });

    this.appendStatus(
      `Teleport → ${celestial} lat=${lat} lon=${lon} radius=${radius}m`
    );
    this.updateSessionInfo();
  }
}

export function latLonToCartesianYUp(
  latDeg: number,
  lonDeg: number,
  radius: number
): [number, number, number] {
  const lat = latDeg * Math.PI / 180;
  const lon = lonDeg * Math.PI / 180;

  const cosLat = Math.cos(lat);

  const x = radius * cosLat * Math.sin(lon);
  const y = radius * Math.sin(lat);
  const z = radius * cosLat * Math.cos(lon);

  return [x, y, z];
}