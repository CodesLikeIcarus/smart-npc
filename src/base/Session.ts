import { ConnectionState } from "../types/index.js";

type StateObserver = (state: ConnectionState, prev: ConnectionState) => void;

/**
 * Session - base class providing connection state management with observer pattern.
 * Subclasses extend this to add domain-specific session behavior.
 */
export abstract class Session {
  private _state: ConnectionState = ConnectionState.Disconnected;
  private _observers: StateObserver[] = [];

  get state(): ConnectionState {
    return this._state;
  }

  protected setState(next: ConnectionState): void {
    if (next === this._state) return;
    const prev = this._state;
    this._state = next;
    for (const obs of this._observers) {
      obs(next, prev);
    }
  }

  onStateChange(observer: StateObserver): () => void {
    this._observers.push(observer);
    return () => {
      const idx = this._observers.indexOf(observer);
      if (idx !== -1) this._observers.splice(idx, 1);
    };
  }

  abstract connect(): Promise<void>;
  abstract disconnect(): Promise<void>;
}
