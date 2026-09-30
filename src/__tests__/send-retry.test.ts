import assert from "node:assert/strict";
import { it } from "node:test";
import { RateLimiter } from "../rate-limiter.js";
import { TelegramService } from "../telegram-client.js";

const sends: Array<[string, (service: TelegramService) => Promise<unknown>]> = [
  ["quoted message", (service) => service.sendMessage("chat", "hi", 1, undefined, undefined, { quoteText: "quote" })],
  ["contact", (service) => service.sendContact("chat", "+15555555555", "Test")],
  ["dice", (service) => service.sendDice("chat", "🎲")],
  ["location", (service) => service.sendLocation("chat", 37, -122)],
  ["venue", (service) => service.sendVenue("chat", 37, -122, "Place", "Address")],
  ["paid reaction", (service) => service.sendPaidReaction("chat", 1, 1)],
];
for (const [name, send] of sends)
  it(`${name} preserves deduplication ID across a retry`, async () => {
    const ids: string[] = [];
    const service = new TelegramService(1, "test");
    Object.assign(service, {
      connected: true,
      resolvePeer: async () => ({}),
      rateLimiter: new RateLimiter({ maxRequestsPerSecond: 100000, initialRetryDelay: 1 }),
      client: {
        invoke: async (request: { randomId: { toString(): string } }) => {
          ids.push(request.randomId.toString());
          throw new Error(ids.length === 1 ? "TIMEOUT" : "stop after retry");
        },
      },
    });
    await assert.rejects(send(service), /stop after retry/);
    assert.equal(ids.length, 2);
    assert.equal(ids[0], ids[1]);
  });

it("does not replay an opaque high-level send after uncertain network failure", async () => {
  let calls = 0;
  const service = new TelegramService(1, "test");
  Object.assign(service, {
    connected: true,
    resolvePeer: async () => ({}),
    rateLimiter: new RateLimiter({ maxRequestsPerSecond: 100000, initialRetryDelay: 1, maxRetries: 1 }),
    client: {
      sendMessage: async () => {
        calls++;
        throw new Error("TIMEOUT");
      },
    },
  });
  await assert.rejects(service.sendMessage("chat", "hi"));
  assert.equal(calls, 1);
});
