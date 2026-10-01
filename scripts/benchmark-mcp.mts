// Offline comparison only: synthetic Telegram latency, no sessions or network access.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import bigInt from 'big-integer';
import { Api } from 'telegram/tl/index.js';

const source = resolve(process.env.MCP_BENCH_SOURCE ?? '.');
const load = (path: string) => import(pathToFileURL(resolve(source, path)).href);
const { TelegramService } = await load('src/telegram-client.ts');
const { registerTools } = await load('src/tools/index.ts');
const { ToolPolicy, applyToolProfile } = await load('src/tool-policy.ts');
const { ToolExecutor } = await load('src/tool-executor.ts');
const hosted = existsSync(resolve(source, 'src/http/tool-catalog.ts')) ? await load('src/http/tool-catalog.ts') : undefined;
const delay = () => new Promise(resolve => setTimeout(resolve, 20));
const entity = (id: number) => new Api.Channel({ id: bigInt(id), accessHash: bigInt(1), title: `C ${id}`, photo: new Api.ChatPhotoEmpty(), date: 0 });
const entities = Array.from({ length: 8 }, (_, i) => entity(i + 1));
const makeService = (client: Record<string, unknown>) => {
  const service = new TelegramService(1, 'fixture', { sessionPath: '/tmp/unused-mcp-benchmark-session' });
  Object.assign(service, { client, connected: true });
  return service;
};
let lookups = 0;
const search = makeService({
  getEntity: async (id: string) => { lookups++; await delay(); return entities.find(entity => entity.id.toString() === id); },
  invoke: async (request: unknown) => {
    await delay();
    if (request instanceof Api.contacts.Search) return { users: [], chats: entities };
    if (request instanceof Api.channels.GetFullChannel) return { fullChat: new Api.ChannelFull({ id: (request.channel as Api.Channel).id, about: 'fixture', readInboxMaxId: 0, readOutboxMaxId: 0, unreadCount: 0, chatPhoto: new Api.PhotoEmpty({ id: bigInt(0) }), notifySettings: new Api.PeerNotifySettings(), botInfo: [], pts: 0 }) };
    throw new Error('Unexpected benchmark request');
  },
});
let start = performance.now();
await search.searchChats('fixture', 8);
const searchMs = performance.now() - start;
let senderLookups = 0;
const sender = new Api.User({ id: bigInt(1), accessHash: bigInt(1), firstName: 'Fixture' });
const messages = makeService({
  getMessages: async () => Array.from({ length: 100 }, (_, i) => ({ id: i + 1, senderId: bigInt(1), sender, date: 0 })),
  getEntity: async () => { senderLookups++; await delay(); return sender; },
});
start = performance.now();
await messages.getMessages('@fixture', 100);
const messagesMs = performance.now() - start;
const server = new McpServer({ name: 'inbox-benchmark', version: 'test' });
registerTools(server, {
  ensureConnected: async () => true,
  getUnreadDialogs: async () => entities.map((entity, i) => ({ id: String(i + 1), name: entity.title, unreadCount: 1 })),
  getMessages: async () => { await delay(); return [{ id: 1, text: 'fixture' }]; },
});
const executor = new ToolExecutor({ tools: (server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools });
start = performance.now();
await executor.call('telegram-inbox', { limit: 8, messagesPerChat: 1 });
const inboxMs = performance.now() - start;
await server.close();
const samples: number[] = [];
for (let i = 0; i < 50; i++) {
  const server = new McpServer({ name: 'catalog-benchmark', version: 'test' });
  start = performance.now();
  if (hosted) hosted.registerHostedTools(server, new ToolPolicy({ profile: 'read' }));
  else { registerTools(server, {}); applyToolProfile(server, new ToolPolicy({ profile: 'read' })); }
  samples.push(performance.now() - start);
  await server.close();
}
samples.sort((a, b) => a - b);
console.log(JSON.stringify({ source, syntheticRpcLatencyMs: 20, searchMs: +searchMs.toFixed(2), searchExtraEntityLookups: lookups, messagesMs: +messagesMs.toFixed(2), senderLookups, inboxMs: +inboxMs.toFixed(2), catalogMedianMs: +samples[25].toFixed(3) }));
