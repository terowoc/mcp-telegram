/** Account-local metadata only: fixed retention and LRU capacity, never message content. */
export class MetadataCache<K, V> {
  private entries = new Map<K, { value: V; expiresAt: number }>();
  constructor(
    private capacity: number,
    private ttlMs: number,
  ) {}
  get size() {
    return this.entries.size;
  }
  get(key: K): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }
  set(key: K, value: V): void {
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: Date.now() + this.ttlMs });
    while (this.entries.size > this.capacity) this.entries.delete(this.entries.keys().next().value as K);
  }
  clear(): void {
    this.entries.clear();
  }
}
