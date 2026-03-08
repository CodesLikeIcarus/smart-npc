/**
 * FlagQueue - manages ordered flag state with debounce support.
 * Flags are processed in FIFO order. Listeners are notified on each flag change.
 */
export class FlagQueue {
  private queue: string[] = [];
  private activeFlags: Set<string> = new Set();
  private listeners: Map<string, Array<(active: boolean) => void>> = new Map();

  enqueue(flag: string): void {
    if (!this.activeFlags.has(flag)) {
      this.activeFlags.add(flag);
      this.queue.push(flag);
      this.notify(flag, true);
    }
  }

  dequeue(flag: string): void {
    if (this.activeFlags.has(flag)) {
      this.activeFlags.delete(flag);
      this.queue = this.queue.filter((f) => f !== flag);
      this.notify(flag, false);
    }
  }

  isActive(flag: string): boolean {
    return this.activeFlags.has(flag);
  }

  getQueue(): readonly string[] {
    return this.queue;
  }

  on(flag: string, listener: (active: boolean) => void): () => void {
    if (!this.listeners.has(flag)) {
      this.listeners.set(flag, []);
    }
    this.listeners.get(flag)!.push(listener);
    return () => this.off(flag, listener);
  }

  off(flag: string, listener: (active: boolean) => void): void {
    const arr = this.listeners.get(flag);
    if (arr) {
      const idx = arr.indexOf(listener);
      if (idx !== -1) arr.splice(idx, 1);
    }
  }

  clear(): void {
    for (const flag of [...this.activeFlags]) {
      this.dequeue(flag);
    }
  }

  private notify(flag: string, active: boolean): void {
    const arr = this.listeners.get(flag);
    if (arr) {
      for (const listener of arr) {
        listener(active);
      }
    }
  }
}
