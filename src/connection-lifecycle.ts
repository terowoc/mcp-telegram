/** Coalesce concurrent connection attempts, while retaining their teardown boundary. */
export class SingleFlight<T> {
  private current: Promise<T> | undefined;
  run(start: () => Promise<T>): Promise<T> {
    if (this.current) return this.current;
    const promise = start();
    this.current = promise;
    void promise
      .finally(() => {
        if (this.current === promise) this.current = undefined;
      })
      .catch(() => {});
    return promise;
  }
  async wait(): Promise<void> {
    await this.current?.catch(() => {});
  }
  isActive(): boolean {
    return this.current !== undefined;
  }
}
