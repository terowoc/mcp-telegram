export class CapacityError extends Error {
  readonly retryAfter = 30;
  constructor() {
    super("Telegram worker capacity reached");
  }
}
/** One reservation spans a process's entire lifetime, including teardown. */
export class WorkerBudget {
  private keys = new Set<string>();
  constructor(
    private maxWorkers: number,
    private reclaim?: () => Promise<void>,
  ) {
    if (!Number.isSafeInteger(maxWorkers) || maxWorkers < 1 || maxWorkers > 32)
      throw new Error("Invalid worker capacity");
  }
  isFull(): boolean {
    return this.keys.size >= this.maxWorkers;
  }
  async reserveWithReclaim(key: string): Promise<{ release(): void }> {
    try {
      return this.reserve(key);
    } catch (error) {
      if (!(error instanceof CapacityError) || this.keys.has(key) || !this.reclaim) throw error;
      await this.reclaim();
      return this.reserve(key);
    }
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
