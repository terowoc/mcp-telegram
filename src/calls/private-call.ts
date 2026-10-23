// Private (1:1) Telegram voice calls placed by this account.
//
// MTProto signaling (requestCall, confirmCall, sendSignalingData, discardCall and the matching updates) runs here on
// the account's GramJS client. Media runs in a Python child process built on the ntgcalls library (engine.py), which
// does the Diffie-Hellman exchange and the encrypted RTP session and hands raw PCM to us. Audio is relayed to and from
// a caller-provided WebSocket ("media bridge", e.g. an AI voice agent): binary frames are s16le mono 48 kHz PCM,
// text frames are JSON control messages. The bridge host must be allow-listed (MCP_TELEGRAM_CALL_MEDIA_HOSTS).
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomBytes, randomInt } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import bigInt from "big-integer";
import { Api } from "telegram/tl/index.js";

export const CALL_SAMPLE_RATE = 48000;
const RING_TIMEOUT_MS = 45_000;
const DEFAULT_MAX_SECONDS = 600;
const MAX_MAX_SECONDS = 1800;
const ENGINE_STEP_TIMEOUT_MS = 15_000;

export type CallState = "starting" | "ringing" | "connecting" | "active" | "ended";

export interface CallStatus {
  callId: string;
  user: string;
  state: CallState;
  startedAt: string;
  answeredAt?: string;
  endedAt?: string;
  endReason?: string;
  durationSeconds?: number;
}

/** What the call needs from the account's Telegram client. */
export interface CallTelegramPort {
  invoke<R = unknown>(request: Api.AnyRequest): Promise<R>;
  getInputUser(user: string): Promise<Api.TypeInputUser>;
  onUpdate(handler: (update: unknown) => void): () => void;
}

export interface EngineHandle {
  send(command: Record<string, unknown>): void;
  onEvent(handler: (event: Record<string, unknown>) => void): void;
  onExit(handler: (code: number | null) => void): void;
  kill(): void;
}

export interface MediaSocket {
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  onOpen(handler: () => void): void;
  onMessage(handler: (data: string | Uint8Array) => void): void;
  onClose(handler: (reason: string) => void): void;
}

export interface CallDeps {
  telegram: CallTelegramPort;
  spawnEngine?: () => EngineHandle;
  openMedia?: (url: string) => MediaSocket;
  now?: () => number;
  allowedMediaHosts?: string[];
}

export function privateCallsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MCP_TELEGRAM_ENABLE_PRIVATE_CALLS === "1";
}

export function allowedMediaHostsFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.MCP_TELEGRAM_CALL_MEDIA_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
}

/** Only wss:// to an allow-listed host (exact match), no credentials in the URL. */
export function validateMediaUrl(raw: string, allowedHosts: string[]): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("media_url must be a valid wss:// URL");
  }
  if (url.protocol !== "wss:") throw new Error("media_url must use wss://");
  if (url.username || url.password) throw new Error("media_url must not contain credentials");
  if (!allowedHosts.includes(url.hostname.toLowerCase())) {
    throw new Error(`media_url host ${url.hostname} is not allowed (MCP_TELEGRAM_CALL_MEDIA_HOSTS)`);
  }
  return url;
}

const b64 = (data: Uint8Array | Buffer) => Buffer.from(data).toString("base64");
const unb64 = (text: unknown) => Buffer.from(String(text ?? ""), "base64");
/** ntgcalls reports the fingerprint as an unsigned 64-bit value; MTProto `long` is signed. */
export function toSignedLong(value: unknown): bigInt.BigInteger {
  return bigInt(BigInt.asIntN(64, BigInt(String(value))).toString());
}

export function serversFromConnections(connections: Api.TypePhoneConnection[]): Record<string, unknown>[] {
  return connections.map((c) =>
    c instanceof Api.PhoneConnectionWebrtc
      ? {
          id: c.id.toString(),
          ipv4: c.ip,
          ipv6: c.ipv6,
          port: c.port,
          username: c.username,
          password: c.password,
          turn: Boolean(c.turn),
          stun: Boolean(c.stun),
          tcp: false,
          peer_tag: null,
        }
      : {
          id: (c as Api.PhoneConnection).id.toString(),
          ipv4: (c as Api.PhoneConnection).ip,
          ipv6: (c as Api.PhoneConnection).ipv6,
          port: (c as Api.PhoneConnection).port,
          username: null,
          password: null,
          turn: true,
          stun: false,
          tcp: Boolean((c as Api.PhoneConnection).tcp),
          peer_tag: b64((c as Api.PhoneConnection).peerTag),
        },
  );
}

function engineScriptPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [join(here, "engine.py"), join(here, "..", "..", "src", "calls", "engine.py")]) {
    if (existsSync(candidate)) return candidate;
  }
  return join(here, "engine.py");
}

export function spawnPythonEngine(env: NodeJS.ProcessEnv = process.env): EngineHandle {
  const python = env.MCP_TELEGRAM_CALL_PYTHON || "python3";
  const child: ChildProcessWithoutNullStreams = spawn(python, [engineScriptPath()], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { PATH: env.PATH ?? "/usr/bin:/bin", LANG: "C.UTF-8", PYTHONUNBUFFERED: "1" },
  });
  const lines = createInterface({ input: child.stdout });
  const handlers: ((e: Record<string, unknown>) => void)[] = [];
  lines.on("line", (line) => {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    for (const h of handlers) h(event);
  });
  child.stderr.resume(); // never let a full stderr pipe stall the engine
  return {
    send: (command) => {
      if (!child.stdin.destroyed) child.stdin.write(`${JSON.stringify(command)}\n`);
    },
    onEvent: (h) => handlers.push(h),
    onExit: (h) => child.once("exit", (code) => h(code)),
    kill: () => {
      if (!child.killed) child.kill("SIGTERM");
    },
  };
}

export function openWebSocket(url: string): MediaSocket {
  const ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";
  return {
    send: (data) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(typeof data === "string" ? data : new Uint8Array(data));
    },
    close: (code, reason) => {
      try {
        ws.close(code ?? 1000, reason);
      } catch {
        /* already closing */
      }
    },
    onOpen: (h) => ws.addEventListener("open", () => h()),
    onMessage: (h) =>
      ws.addEventListener("message", (ev) =>
        h(typeof ev.data === "string" ? ev.data : new Uint8Array(ev.data as ArrayBuffer)),
      ),
    onClose: (h) => ws.addEventListener("close", (ev) => h(ev.reason || `closed ${ev.code}`)),
  };
}

interface ActiveCall {
  status: CallStatus;
  user: Api.TypeInputUser;
  engine: EngineHandle;
  media: MediaSocket;
  inputCall?: Api.InputPhoneCall;
  protocol?: Api.PhoneCallProtocol;
  unsubscribe: () => void;
  timers: NodeJS.Timeout[];
  waiters: Map<string, (event: Record<string, unknown>) => void>;
  answeredMs?: number;
  confirmed: boolean;
}

/** One manager per Telegram account (worker). At most one call at a time. */
export class PrivateCallManager {
  private active?: ActiveCall;
  private history: CallStatus[] = [];
  private readonly now: () => number;

  constructor(private readonly deps: CallDeps) {
    this.now = deps.now ?? Date.now;
  }

  status(callId?: string): CallStatus | undefined {
    if (this.active && (!callId || this.active.status.callId === callId)) return { ...this.active.status };
    const past = callId ? this.history.find((c) => c.callId === callId) : this.history[this.history.length - 1];
    return past ? { ...past } : undefined;
  }

  async start(options: { user: string; mediaUrl: string; maxSeconds?: number }): Promise<CallStatus> {
    if (this.active) throw new Error(`A call is already in progress (${this.active.status.callId})`);
    const url = validateMediaUrl(options.mediaUrl, this.deps.allowedMediaHosts ?? allowedMediaHostsFromEnv());
    const maxSeconds = Math.min(Math.max(Math.floor(options.maxSeconds ?? DEFAULT_MAX_SECONDS), 10), MAX_MAX_SECONDS);
    const user = await this.deps.telegram.getInputUser(options.user);
    const dh = await this.deps.telegram.invoke<Api.messages.DhConfig>(
      new Api.messages.GetDhConfig({ version: 0, randomLength: 256 }),
    );
    if (!(dh instanceof Api.messages.DhConfig)) throw new Error("Telegram did not return a DH config");

    const callId = randomBytes(8).toString("hex");
    const engine = (this.deps.spawnEngine ?? spawnPythonEngine)();
    const media = (this.deps.openMedia ?? openWebSocket)(url.toString());
    const call: ActiveCall = {
      status: { callId, user: options.user, state: "starting", startedAt: new Date(this.now()).toISOString() },
      user,
      engine,
      media,
      unsubscribe: () => {},
      timers: [],
      waiters: new Map(),
      confirmed: false,
    };
    this.active = call;

    engine.onEvent((event) => this.onEngineEvent(call, event));
    engine.onExit(() => void this.finish(call, "media engine stopped"));
    media.onMessage((data) => {
      if (typeof data === "string") {
        let msg: { type?: string; reason?: string } = {};
        try {
          msg = JSON.parse(data);
        } catch {
          return;
        }
        if (msg.type === "hangup") void this.finish(call, msg.reason || "hung up by media bridge");
        return;
      }
      if (call.status.state === "active") engine.send({ op: "audio", pcm: b64(data) });
    });
    media.onClose((reason) => void this.finish(call, `media bridge closed: ${reason}`));
    media.onOpen(() =>
      media.send(JSON.stringify({ type: "start", call_id: callId, user: options.user, sample_rate: CALL_SAMPLE_RATE })),
    );
    call.unsubscribe = this.deps.telegram.onUpdate((update) => void this.onTelegramUpdate(call, update));
    call.timers.push(setTimeout(() => void this.finish(call, "max duration reached"), maxSeconds * 1000));

    try {
      engine.send({
        op: "start",
        user_id: Number(String((user as Api.InputUser).userId ?? 0)),
        dh: { g: dh.g, p: b64(dh.p), random: b64(dh.random) },
      });
      const requested = await this.waitEngine(call, "requested");
      const p = requested.protocol as Record<string, unknown>;
      call.protocol = new Api.PhoneCallProtocol({
        minLayer: Number(p.min_layer),
        maxLayer: Number(p.max_layer),
        udpP2p: Boolean(p.udp_p2p),
        udpReflector: Boolean(p.udp_reflector),
        libraryVersions: (p.library_versions as string[]) ?? [],
      });
      const result = await this.deps.telegram.invoke<Api.phone.PhoneCall>(
        new Api.phone.RequestCall({
          userId: user,
          randomId: randomInt(1, 2 ** 31 - 1),
          gAHash: unb64(requested.g_a_hash),
          protocol: call.protocol,
          video: false,
        }),
      );
      const pc = result.phoneCall as Api.PhoneCallWaiting;
      call.inputCall = new Api.InputPhoneCall({ id: pc.id, accessHash: pc.accessHash });
      call.status.state = "ringing";
      call.timers.push(
        setTimeout(() => {
          if (call.status.state === "ringing") void this.finish(call, "no answer", "missed");
        }, RING_TIMEOUT_MS),
      );
      return { ...call.status };
    } catch (error) {
      await this.finish(call, `start failed: ${(error as Error).message}`);
      throw error;
    }
  }

  async end(callId?: string, reason = "ended by request"): Promise<CallStatus | undefined> {
    const call = this.active;
    if (!call || (callId && call.status.callId !== callId)) return this.status(callId);
    await this.finish(call, reason);
    return this.status(call.status.callId);
  }

  private waitEngine(call: ActiveCall, ev: string): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        call.waiters.delete(ev);
        reject(new Error(`media engine did not answer (${ev})`));
      }, ENGINE_STEP_TIMEOUT_MS);
      call.waiters.set(ev, (event) => {
        clearTimeout(timer);
        resolve(event);
      });
    });
  }

  private onEngineEvent(call: ActiveCall, event: Record<string, unknown>): void {
    const ev = String(event.ev);
    const waiter = call.waiters.get(ev);
    if (waiter) {
      call.waiters.delete(ev);
      waiter(event);
      return;
    }
    if (ev === "audio") call.media.send(unb64(event.pcm));
    else if (ev === "signaling" && call.inputCall) {
      this.deps.telegram
        .invoke(new Api.phone.SendSignalingData({ peer: call.inputCall, data: unb64(event.data) }))
        .catch(() => {});
    } else if (ev === "state") {
      const s = String(event.state).toLowerCase();
      if (s.includes("connected") && call.status.state === "connecting") {
        call.status.state = "active";
        call.media.send(JSON.stringify({ type: "active", call_id: call.status.callId }));
      } else if (/failed|closed|timeout/.test(s) && call.status.state !== "ended") {
        void this.finish(call, `connection ${s}`);
      }
    } else if (ev === "error") {
      call.media.send(JSON.stringify({ type: "engine_error", message: String(event.message ?? "") }));
    }
  }

  private async onTelegramUpdate(call: ActiveCall, update: unknown): Promise<void> {
    if (!call.inputCall || call.status.state === "ended") return;
    const sameCall = (id: bigInt.BigInteger | undefined) => id !== undefined && id.equals(call.inputCall!.id);
    if (update instanceof Api.UpdatePhoneCallSignalingData) {
      if (sameCall(update.phoneCallId)) call.engine.send({ op: "signaling", data: b64(update.data) });
      return;
    }
    if (!(update instanceof Api.UpdatePhoneCall)) return;
    const pc = update.phoneCall;
    if (!sameCall((pc as { id?: bigInt.BigInteger }).id)) return;
    try {
      if (pc instanceof Api.PhoneCallAccepted && !call.confirmed) {
        call.confirmed = true;
        call.status.state = "connecting";
        call.answeredMs = this.now();
        call.status.answeredAt = new Date(call.answeredMs).toISOString();
        call.engine.send({ op: "accepted", g_b: b64(pc.gB) });
        const confirm = await this.waitEngine(call, "confirm");
        const result = await this.deps.telegram.invoke<Api.phone.PhoneCall>(
          new Api.phone.ConfirmCall({
            peer: call.inputCall,
            gA: unb64(confirm.g_a),
            keyFingerprint: toSignedLong(confirm.key_fingerprint),
            protocol: call.protocol!,
          }),
        );
        const confirmed = result.phoneCall as Api.PhoneCall;
        call.engine.send({
          op: "connect",
          servers: serversFromConnections(confirmed.connections ?? []),
          library_versions: confirmed.protocol?.libraryVersions ?? [],
          p2p_allowed: Boolean(confirmed.p2pAllowed),
          custom_parameters: confirmed.customParameters?.data ?? null,
        });
      } else if (pc instanceof Api.PhoneCallDiscarded) {
        const reason = pc.reason;
        const why =
          reason instanceof Api.PhoneCallDiscardReasonBusy
            ? "busy"
            : reason instanceof Api.PhoneCallDiscardReasonMissed
              ? "missed"
              : call.answeredMs
                ? "hung up by the other side"
                : "declined";
        await this.finish(call, why, undefined, false);
      }
    } catch (error) {
      await this.finish(call, `call setup failed: ${(error as Error).message}`);
    }
  }

  private async finish(
    call: ActiveCall,
    reason: string,
    discard: "hangup" | "missed" = "hangup",
    notifyTelegram = true,
  ): Promise<void> {
    if (call.status.state === "ended") return;
    const wasAnswered = call.answeredMs !== undefined;
    call.status.state = "ended";
    call.status.endReason = reason;
    call.status.endedAt = new Date(this.now()).toISOString();
    if (wasAnswered) call.status.durationSeconds = Math.max(0, Math.round((this.now() - call.answeredMs!) / 1000));
    for (const t of call.timers) clearTimeout(t);
    call.unsubscribe();
    if (notifyTelegram && call.inputCall) {
      await this.deps.telegram
        .invoke(
          new Api.phone.DiscardCall({
            peer: call.inputCall,
            duration: call.status.durationSeconds ?? 0,
            reason:
              discard === "missed" ? new Api.PhoneCallDiscardReasonMissed() : new Api.PhoneCallDiscardReasonHangup(),
            connectionId: bigInt(0),
          }),
        )
        .catch(() => {});
    }
    call.engine.send({ op: "stop" });
    setTimeout(() => call.engine.kill(), 2000).unref?.();
    call.media.send(JSON.stringify({ type: "end", call_id: call.status.callId, reason }));
    call.media.close(1000, "call ended");
    this.history.push({ ...call.status });
    if (this.history.length > 20) this.history.shift();
    if (this.active === call) this.active = undefined;
  }
}
