import { Config, Endpoints } from "../config.js";

/** Shape of the auth token returned by the RP1 login server. */
export interface AuthToken {
  /** Short-lived bearer token for API calls */
  accessToken: string;
  /** Long-lived token used to obtain a new accessToken */
  refreshToken: string;
  /** Unix timestamp (ms) at which the access token expires */
  expiresAt: number;
  /** Server-assigned user identifier */
  userId: string;
  /** List of persona IDs associated with this account */
  personaIds: string[];
}

/** Full response envelope returned by the login endpoint. */
export interface AuthResponse {
  token: AuthToken;
  /** Unique identifier for this login session */
  sessionId: string;
  /** Display name for the authenticated user */
  displayName: string;
}

/** Credentials used for member (email + password) login. */
export interface MemberCredentials {
  email: string;
  password: string;
  remember?: boolean;
}

/** Credentials used for guest login. */
export interface GuestCredentials {
  firstName: string;
  lastName?: string;
}

/**
 * AuthService — handles all authentication against the RP1 persona server at
 * https://prod-persona.rp1.com/login.
 *
 * Tokens are stored in localStorage so sessions survive page reloads when the
 * user has chosen "remember me".  Session-only tokens are kept in
 * sessionStorage.
 */
export class AuthService {
  /** Login with email and password. */
  static async loginMember(credentials: MemberCredentials): Promise<AuthResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Config.TIMEOUT_MS);

    try {
      const res = await fetch(Endpoints.login, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: credentials.email,
          password: credentials.password,
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const errorText = await res.text().catch(() => res.statusText);
        throw new Error(`Login failed (${res.status}): ${errorText}`);
      }

      const data: AuthResponse = await res.json();
      AuthService.storeToken(data.token, credentials.remember ?? false);
      return data;
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        throw new Error("Login request timed out");
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Login as a guest with an optional display name. */
  static async loginGuest(credentials: GuestCredentials): Promise<AuthResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Config.TIMEOUT_MS);

    try {
      const displayName = [credentials.firstName, credentials.lastName]
        .filter(Boolean)
        .join(" ");

      const res = await fetch(Endpoints.guestLogin, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const errorText = await res.text().catch(() => res.statusText);
        throw new Error(`Guest login failed (${res.status}): ${errorText}`);
      }

      const data: AuthResponse = await res.json();
      // Guest tokens are never persisted across browser sessions
      AuthService.storeToken(data.token, false);
      return data;
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        throw new Error("Guest login request timed out");
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Use a refreshToken to obtain a new accessToken. */
  static async refreshToken(refreshToken: string): Promise<AuthToken> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Config.TIMEOUT_MS);

    try {
      const res = await fetch(Endpoints.tokenRefresh, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const errorText = await res.text().catch(() => res.statusText);
        throw new Error(`Token refresh failed (${res.status}): ${errorText}`);
      }

      const token: AuthToken = await res.json();
      // Preserve the persist preference that was in effect before the refresh
      const persist = localStorage.getItem(Config.TOKEN_STORAGE_KEY) !== null;
      AuthService.storeToken(token, persist);
      return token;
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        throw new Error("Token refresh request timed out");
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Persist an auth token.
   * @param persist  When true the token is written to localStorage so it
   *                 survives page reloads.  Otherwise it is stored in
   *                 sessionStorage only.
   */
  static storeToken(token: AuthToken, persist: boolean): void {
    const serialised = JSON.stringify(token);
    if (persist) {
      localStorage.setItem(Config.TOKEN_STORAGE_KEY, serialised);
    } else {
      // Always keep a copy in sessionStorage for the current tab
      sessionStorage.setItem(Config.TOKEN_STORAGE_KEY, serialised);
    }
  }

  /** Retrieve the stored token from localStorage or sessionStorage. */
  static getStoredToken(): AuthToken | null {
    const raw =
      localStorage.getItem(Config.TOKEN_STORAGE_KEY) ??
      sessionStorage.getItem(Config.TOKEN_STORAGE_KEY);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as AuthToken;
    } catch {
      return null;
    }
  }

  /** Remove any persisted token. */
  static clearToken(): void {
    localStorage.removeItem(Config.TOKEN_STORAGE_KEY);
    sessionStorage.removeItem(Config.TOKEN_STORAGE_KEY);
  }

  /** Return true if the token has not yet expired. */
  static isTokenValid(token: AuthToken): boolean {
    return Date.now() < token.expiresAt;
  }

  /**
   * Return a valid access token, refreshing it automatically if it has expired.
   * Throws when no stored token exists or when refresh fails.
   */
  static async getValidToken(): Promise<AuthToken> {
    const stored = AuthService.getStoredToken();
    if (!stored) {
      throw new Error("No stored auth token – user must log in");
    }
    if (AuthService.isTokenValid(stored)) {
      return stored;
    }
    // Token expired; attempt silent refresh
    return AuthService.refreshToken(stored.refreshToken);
  }
}
