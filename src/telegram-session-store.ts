/** Persistence belongs to the caller; hosted sessions must never fall back to disk. */
export interface TelegramSessionStore {
  load(): Promise<string | undefined>;
  save(session: string): Promise<void>;
  clear(): Promise<void>;
  hasSession(): boolean;
}
