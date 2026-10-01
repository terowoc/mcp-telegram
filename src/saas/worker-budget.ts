export class CapacityError extends Error {
  readonly retryAfter = 30;
  constructor() {
    super("Telegram worker capacity reached");
  }
}
/** One reservation spans a process's entire lifetime, including teardown. */
export class WorkerBudget {
  private keys = new Set<string>();
  constructor(private maxWorkers: number) {
    if (!Number.isSafeInteger(maxWorkers) || maxWorkers < 1 || maxWorkers > 32)
      throw new Error("Invalid worker capacity");
  }
  reserve(key: string): { release(): void } {
    if (this.keys.has(key) || this.keys.size >= this.maxWorkers) throw new CapacityError();
    this.keys.add(key);
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.keys.delete(key);
      },
    };
  }
}
