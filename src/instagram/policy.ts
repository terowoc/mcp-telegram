import { externalId, type InstagramAccess, InstagramError, policySchema, TOOL_NAMES } from "./types.js";

export class InstagramPolicy {
  readonly access: InstagramAccess;
  constructor(value: InstagramAccess) {
    this.access = policySchema.parse(value);
  }
  visible(name: string): boolean {
    return (
      (TOOL_NAMES as readonly string[]).includes(name) &&
      (name !== "instagram-send-message" || this.access.profile === "full")
    );
  }
  allows(id: string): boolean {
    return !this.access.threadIds.length || this.access.threadIds.includes(id);
  }
  authorize(name: string, args: Record<string, unknown>): void {
    if (!this.visible(name)) throw new InstagramError("permission-denied");
    if (name === "instagram-read-messages" || name === "instagram-send-message") {
      if (!externalId.safeParse(args.threadId).success || !this.allows(args.threadId as string))
        throw new InstagramError("permission-denied");
    }
  }
}
