import assert from "node:assert";
import { describe, it } from "node:test";
import bigInt from "big-integer";
import { Api } from "telegram/tl/index.js";
import {
  type EngineHandle,
  type MediaSocket,
  PrivateCallManager,
  privateCallsEnabled,
  serversFromConnections,
  toSignedLong,
  validateMediaUrl,
} from "../calls/private-call.js";
import { workerFeatureEnv } from "../saas/supervisor.js";

const tick = () => new Promise((r) => setImmediate(r));

function fakeEngine() {
  const sent: Record<string, unknown>[] = [];
  let onEvent: (e: Record<string, unknown>) => void = () => {};
  const engine: EngineHandle = {
    send: (c) => sent.push(c),
    onEvent: (h) => {
      onEvent = h;
    },
    onExit: () => {},
    kill: () => {},
  };
  return { engine, sent, emit: (e: Record<string, unknown>) => onEvent(e) };
}

function fakeMedia() {
  const sent: (string | Uint8Array)[] = [];
  let closed = false;
  let onMessage: (d: string | Uint8Array) => void = () => {};
  let onOpen: () => void = () => {};
  const media: MediaSocket = {
    send: (d) => sent.push(d),
    close: () => {
      closed = true;
    },
    onOpen: (h) => {
      onOpen = h;
    },
    onMessage: (h) => {
      onMessage = h;
    },
    onClose: () => {},
  };
  return {
    media,
    sent,
    open: () => onOpen(),
    receive: (d: string | Uint8Array) => onMessage(d),
    isClosed: () => closed,
  };
}

const protocol = new Api.PhoneCallProtocol({
  minLayer: 92,
  maxLayer: 92,
  libraryVersions: ["13.0.0"],
  udpP2p: true,
  udpReflector: true,
});

function setup() {
  const invoked: Api.AnyRequest[] = [];
  let updateHandler: (u: unknown) => void = () => {};
  const eng = fakeEngine();
  const med = fakeMedia();
  const callId = bigInt(777);
  const accessHash = bigInt(888);
  const manager = new PrivateCallManager({
    allowedMediaHosts: ["voice.example.com"],
    spawnEngine: () => eng.engine,
    openMedia: () => med.media,
    telegram: {
      getInputUser: async () => new Api.InputUser({ userId: bigInt(42), accessHash: bigInt(1) }),
      onUpdate: (h) => {
        updateHandler = h;
        return () => {
          updateHandler = () => {};
        };
      },
      invoke: async <R>(req: Api.AnyRequest) => {
        invoked.push(req);
        if (req instanceof Api.messages.GetDhConfig) {
          return new Api.messages.DhConfig({
            g: 3,
            p: Buffer.alloc(256, 7),
            version: 1,
            random: Buffer.alloc(256, 9),
          }) as R;
        }
        if (req instanceof Api.phone.RequestCall) {
          return {
            phoneCall: new Api.PhoneCallWaiting({
              id: callId,
              accessHash,
              date: 1,
              adminId: bigInt(1),
              participantId: bigInt(42),
              protocol,
            }),
          } as R;
        }
        if (req instanceof Api.phone.ConfirmCall) {
          const connections = [
            new Api.PhoneConnectionWebrtc({
              id: bigInt(5),
              ip: "1.2.3.4",
              ipv6: "",
              port: 3478,
              username: "u",
              password: "p",
              turn: true,
              stun: true,
            }),
            new Api.PhoneConnection({
              id: bigInt(6),
              ip: "5.6.7.8",
              ipv6: "",
              port: 443,
              peerTag: Buffer.from([1, 2]),
              tcp: true,
            }),
          ];
          return {
            phoneCall: {
              id: callId,
              connections,
              protocol,
              p2pAllowed: true,
              customParameters: new Api.DataJSON({ data: "{}" }),
            },
          } as R;
        }
        return {} as R;
      },
    },
  });
  return { manager, invoked, eng, med, update: (u: unknown) => updateHandler(u), callId, accessHash };
}

describe("validateMediaUrl", () => {
  it("accepts wss on an allowed host only", () => {
    assert.equal(
      validateMediaUrl("wss://voice.example.com/tg/abc", ["voice.example.com"]).hostname,
      "voice.example.com",
    );
    assert.throws(() => validateMediaUrl("ws://voice.example.com/x", ["voice.example.com"]), /wss/);
    assert.throws(() => validateMediaUrl("wss://evil.example.com/x", ["voice.example.com"]), /not allowed/);
    assert.throws(() => validateMediaUrl("wss://a:b@voice.example.com/x", ["voice.example.com"]), /credentials/);
    assert.throws(() => validateMediaUrl("not a url", ["voice.example.com"]), /valid/);
  });
});

describe("helpers", () => {
  it("converts an unsigned fingerprint to a signed long", () => {
    assert.equal(toSignedLong("18446744073709551615").toString(), "-1");
    assert.equal(toSignedLong("3007118375548879794").toString(), "3007118375548879794");
  });
  it("maps reflector and webrtc connections", () => {
    const s = serversFromConnections([
      new Api.PhoneConnectionWebrtc({
        id: bigInt(5),
        ip: "1.2.3.4",
        ipv6: "",
        port: 3478,
        username: "u",
        password: "p",
        turn: true,
        stun: false,
      }),
      new Api.PhoneConnection({
        id: bigInt(6),
        ip: "5.6.7.8",
        ipv6: "",
        port: 443,
        peerTag: Buffer.from([1, 2]),
        tcp: true,
      }),
    ]);
    assert.deepEqual(s[0], {
      id: "5",
      ipv4: "1.2.3.4",
      ipv6: "",
      port: 3478,
      username: "u",
      password: "p",
      turn: true,
      stun: false,
      tcp: false,
      peer_tag: null,
    });
    assert.equal(s[1].peer_tag, Buffer.from([1, 2]).toString("base64"));
    assert.equal(s[1].turn, true);
    assert.equal(s[1].tcp, true);
  });
  it("flags and worker env", () => {
    assert.equal(privateCallsEnabled({}), false);
    assert.equal(privateCallsEnabled({ MCP_TELEGRAM_ENABLE_PRIVATE_CALLS: "1" }), true);
    assert.deepEqual(
      workerFeatureEnv({
        MCP_TELEGRAM_ENABLE_PRIVATE_CALLS: "1",
        MCP_TELEGRAM_CALL_MEDIA_HOSTS: "a.b",
        PATH: "/x",
        SECRET: "s",
      }),
      {
        MCP_TELEGRAM_ENABLE_PRIVATE_CALLS: "1",
        MCP_TELEGRAM_CALL_MEDIA_HOSTS: "a.b",
        PATH: "/x",
      },
    );
    assert.deepEqual(workerFeatureEnv({ SECRET: "s", PATH: "/x" }), {});
  });
});

describe("PrivateCallManager", () => {
  it("runs request → accept → confirm → connect → audio → hang up", async () => {
    const t = setup();
    const starting = t.manager.start({ user: "@billy", mediaUrl: "wss://voice.example.com/tg/1" });
    await tick();
    assert.equal(t.eng.sent[0].op, "start");
    assert.equal((t.eng.sent[0].dh as { g: number }).g, 3);
    t.eng.emit({
      ev: "requested",
      g_a_hash: Buffer.alloc(32, 1).toString("base64"),
      protocol: { min_layer: 92, max_layer: 92, udp_p2p: true, udp_reflector: true, library_versions: ["13.0.0"] },
    });
    const started = await starting;
    assert.equal(started.state, "ringing");
    const req = t.invoked.find((r) => r instanceof Api.phone.RequestCall) as Api.phone.RequestCall;
    assert.equal(Buffer.from(req.gAHash).length, 32);
    assert.equal(req.video, false);

    t.med.open();
    assert.equal(JSON.parse(String(t.med.sent[0])).type, "start");

    t.update(
      new Api.UpdatePhoneCall({
        phoneCall: new Api.PhoneCallAccepted({
          id: t.callId,
          accessHash: t.accessHash,
          date: 2,
          adminId: bigInt(1),
          participantId: bigInt(42),
          gB: Buffer.alloc(256, 2),
          protocol,
        }),
      }),
    );
    await tick();
    assert.equal(t.eng.sent.at(-1)?.op, "accepted");
    t.eng.emit({
      ev: "confirm",
      g_a: Buffer.alloc(256, 3).toString("base64"),
      key_fingerprint: "18446744073709551615",
    });
    await tick();
    await tick();
    const confirm = t.invoked.find((r) => r instanceof Api.phone.ConfirmCall) as Api.phone.ConfirmCall;
    assert.equal(confirm.keyFingerprint.toString(), "-1");
    const connect = t.eng.sent.find((c) => c.op === "connect") as {
      servers: unknown[];
      p2p_allowed: boolean;
      custom_parameters: string;
    };
    assert.equal(connect.servers.length, 2);
    assert.equal(connect.p2p_allowed, true);
    assert.equal(connect.custom_parameters, "{}");
    assert.equal(t.manager.status()?.state, "connecting");

    t.eng.emit({ ev: "state", state: "ConnectionState.CONNECTED" });
    assert.equal(t.manager.status()?.state, "active");
    t.eng.emit({ ev: "audio", pcm: Buffer.from([1, 2, 3, 4]).toString("base64") });
    assert.deepEqual(Array.from(t.med.sent.at(-1) as Uint8Array), [1, 2, 3, 4]);
    t.med.receive(new Uint8Array([9, 8]));
    assert.deepEqual(t.eng.sent.at(-1), { op: "audio", pcm: Buffer.from([9, 8]).toString("base64") });

    t.eng.emit({ ev: "signaling", data: Buffer.from("x").toString("base64") });
    await tick();
    assert.ok(t.invoked.some((r) => r instanceof Api.phone.SendSignalingData));
    t.update(new Api.UpdatePhoneCallSignalingData({ phoneCallId: t.callId, data: Buffer.from("y") }));
    assert.deepEqual(t.eng.sent.at(-1), { op: "signaling", data: Buffer.from("y").toString("base64") });

    t.med.receive(JSON.stringify({ type: "hangup", reason: "goal reached" }));
    await tick();
    const status = t.manager.status(started.callId);
    assert.equal(status?.state, "ended");
    assert.equal(status?.endReason, "goal reached");
    assert.ok(t.invoked.some((r) => r instanceof Api.phone.DiscardCall));
    assert.ok(t.eng.sent.some((c) => c.op === "stop"));
    assert.ok(t.med.isClosed());
  });

  it("records a declined call without discarding again", async () => {
    const t = setup();
    const starting = t.manager.start({ user: "@billy", mediaUrl: "wss://voice.example.com/tg/1" });
    await tick();
    t.eng.emit({
      ev: "requested",
      g_a_hash: Buffer.alloc(32).toString("base64"),
      protocol: { min_layer: 92, max_layer: 92, udp_p2p: true, udp_reflector: true, library_versions: [] },
    });
    await starting;
    t.update(
      new Api.UpdatePhoneCall({
        phoneCall: new Api.PhoneCallDiscarded({ id: t.callId, reason: new Api.PhoneCallDiscardReasonBusy() }),
      }),
    );
    await tick();
    assert.equal(t.manager.status()?.endReason, "busy");
    assert.equal(t.invoked.filter((r) => r instanceof Api.phone.DiscardCall).length, 0);
  });

  it("refuses a second call and a non-allowed bridge", async () => {
    const t = setup();
    await assert.rejects(t.manager.start({ user: "@billy", mediaUrl: "wss://evil.example.com/x" }), /not allowed/);
    const starting = t.manager.start({ user: "@billy", mediaUrl: "wss://voice.example.com/tg/1" });
    await tick();
    await assert.rejects(
      t.manager.start({ user: "@billy", mediaUrl: "wss://voice.example.com/tg/2" }),
      /already in progress/,
    );
    t.eng.emit({
      ev: "requested",
      g_a_hash: Buffer.alloc(32).toString("base64"),
      protocol: { min_layer: 92, max_layer: 92, udp_p2p: true, udp_reflector: true, library_versions: [] },
    });
    await starting;
    const ended = await t.manager.end();
    assert.equal(ended?.state, "ended");
  });
});
