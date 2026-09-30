type Waiter = { grant: () => void; cancel: () => void };

/** Bounded FIFO mutex. Ownership stays reserved while a waiter resumes. */
export class GlobalLock {
  private locked = false;
  private waiters: Waiter[] = [];
  constructor(private maxWaiters = 64) {}

  private handoff(): void {
    const next = this.waiters.shift();
    if (next) next.grant();
    else this.locked = false;
  }

  async acquire(signal?: AbortSignal): Promise<() => void> {
    signal?.throwIfAborted();
    if (this.locked) {
      if (this.waiters.length >= this.maxWaiters) throw new Error("Tool queue is full; try again later");
      await new Promise<void>((resolve, reject) => {
        const waiter: Waiter = {
          grant: () => {
            signal?.removeEventListener("abort", waiter.cancel);
            resolve();
          },
          cancel: () => {
            const index = this.waiters.indexOf(waiter);
            if (index >= 0) this.waiters.splice(index, 1);
            signal?.removeEventListener("abort", waiter.cancel);
            reject(signal?.reason ?? new Error("Lock wait aborted"));
          },
        };
        this.waiters.push(waiter);
        signal?.addEventListener("abort", waiter.cancel, { once: true });
      });
      if (signal?.aborted) {
        this.handoff();
        signal.throwIfAborted();
      }
    } else this.locked = true;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.handoff();
    };
  }

  isLocked(): boolean {
    return this.locked;
  }
  waitingCount(): number {
    return this.waiters.length;
  }
}
