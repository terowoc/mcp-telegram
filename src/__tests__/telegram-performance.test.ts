import assert from "node:assert/strict";
import { test } from "node:test";
import bigInt from "big-integer";
import { Api } from "telegram/tl/index.js";
import { TelegramService } from "../telegram-client.js";

const user = (id: number) => new Api.User({ id: bigInt(id), accessHash: bigInt(1), firstName: `User ${id}` });
const channel = (id: number) =>
  new Api.Channel({
    id: bigInt(id),
    accessHash: bigInt(1),
    title: `Channel ${id}`,
    photo: new Api.ChatPhotoEmpty(),
    date: 0,
  });
function service(client: Record<string, unknown>) {
  const telegram = new TelegramService(1, "fixture", { sessionPath: "/tmp/unused-telegram-performance-session" });
  Object.assign(telegram, { client, connected: true });
  return telegram;
}

test("message batch resolves each unique sender only once and preserves message order", async () => {
  let lookups = 0;
  const telegram = service({
    getMessages: async () =>
      Array.from({ length: 100 }, (_, i) => ({
        id: i + 1,
        senderId: bigInt((i % 2) + 1),
        message: `message ${i}`,
        date: 0,
      })),
    getEntity: async (id: bigInt.BigInteger) => {
      lookups++;
      await new Promise((resolve) => setImmediate(resolve));
      return user(id.toJSNumber());
    },
  });
  const messages = await telegram.getMessages("@fixture", 100);
  assert.equal(lookups, 2, "100 messages from two people need two sender lookups");
  assert.equal(messages.length, 100);
  assert.equal(messages[0].sender, "User 1");
  assert.equal(messages[99].sender, "User 2");
  assert.deepEqual(
    messages.map((message) => message.id),
    Array.from({ length: 100 }, (_, i) => i + 1),
  );
  await telegram.getMessages("@fixture", 100);
  assert.equal(lookups, 2, "recent sender metadata is reusable across tool calls");
});

test("sender entity already attached to a message needs no network lookup", async () => {
  let lookups = 0;
  const telegram = service({
    getMessages: async () => [{ id: 1, senderId: bigInt(1), sender: user(1), date: 0 }],
    getEntity: async () => {
      lookups++;
      throw new Error("unexpected lookup");
    },
  });
  const messages = await telegram.getMessages("@fixture");
  assert.equal(messages[0].sender, "User 1");
  assert.equal(lookups, 0);
});

test("listing dialogs primes marked peer resolution without another dialog scan", async () => {
  let scans = 0,
    lookups = 0;
  const entity = channel(123);
  let receivedPeer: unknown;
  const telegram = service({
    getDialogs: async () => {
      scans++;
      return [{ id: bigInt(-100123), entity, title: "Channel 123", isChannel: true, unreadCount: 0 }];
    },
    getEntity: async () => {
      lookups++;
      throw new Error("unknown input entity");
    },
    getMessages: async (peer: unknown) => {
      receivedPeer = peer;
      return [];
    },
  });
  await telegram.getDialogs();
  await telegram.getMessages("-100123");
  assert.strictEqual(receivedPeer, entity);
  assert.equal(scans, 1);
  assert.equal(lookups, 0);
});

test("search enrichment reuses response entities, bounds parallelism and preserves descriptions", async () => {
  let lookups = 0,
    active = 0,
    maxActive = 0;
  const entities = Array.from({ length: 8 }, (_, i) => channel(i + 1));
  const telegram = service({
    getEntity: async (id: string) => {
      lookups++;
      const found = entities.find((entity) => entity.id.toString() === id);
      assert.ok(found);
      return found;
    },
    invoke: async (request: unknown) => {
      if (request instanceof Api.contacts.Search) return { users: [], chats: entities };
      assert.ok(request instanceof Api.channels.GetFullChannel);
      active++;
      maxActive = Math.max(active, maxActive);
      await new Promise((resolve) => setImmediate(resolve));
      active--;
      const id = (request.channel as Api.Channel).id;
      return {
        fullChat: new Api.ChannelFull({
          id,
          about: `Description ${id}`,
          readInboxMaxId: 0,
          readOutboxMaxId: 0,
          unreadCount: 0,
          chatPhoto: new Api.PhotoEmpty({ id: bigInt(0) }),
          notifySettings: new Api.PeerNotifySettings(),
          botInfo: [],
          pts: 0,
        }),
      };
    },
  });
  const chats = await telegram.searchChats("fixture", 8);
  assert.equal(lookups, 0, "contacts.Search already supplies the entities");
  assert.ok(maxActive > 1 && maxActive <= 3, `bounded enrichment concurrency: ${maxActive}`);
  assert.deepEqual(
    chats.map((chat) => chat.description),
    entities.map((entity) => `Description ${entity.id}`),
  );
});

test("entity metadata expires and cannot grow memory without bound", async (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: 1000000 });
  let lookups = 0;
  const telegram = service({
    getEntity: async () => {
      lookups++;
      return user(1);
    },
  });
  await telegram.resolveChat("fixture");
  await telegram.resolveChat("fixture");
  assert.equal(lookups, 1);
  context.mock.timers.tick(300001);
  await telegram.resolveChat("fixture");
  assert.equal(lookups, 2, "stale names and access hashes are refreshed");
  for (let i = 0; i < 2100; i++) await telegram.resolveChat(`fixture-${i}`);
  const internals = telegram as unknown as { entityCache: { size: number } };
  assert.ok(internals.entityCache.size <= 2048);
});
