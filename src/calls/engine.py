#!/usr/bin/env python3
"""Media engine for private (1:1) Telegram voice calls.

The Node worker owns MTProto signaling (phone.requestCall / confirmCall / sendSignalingData / discardCall and the
matching updates). This process owns only the media side through the ntgcalls native library: Diffie-Hellman key
exchange, the encrypted RTP session and raw PCM audio in both directions.

Protocol: one JSON object per line on stdin (commands) and stdout (events). Binary fields are base64.
Audio is signed 16-bit little-endian mono PCM at SAMPLE_RATE, in 10 ms frames (FRAME_BYTES bytes).

Commands:
  {"op":"start","user_id":int,"dh":{"g":int,"p":b64,"random":b64}}
      -> {"ev":"requested","g_a_hash":b64,"protocol":{...}}
  {"op":"accepted","g_b":b64}                      -> {"ev":"confirm","g_a":b64,"key_fingerprint":int}
  {"op":"connect","servers":[...],"library_versions":[str],"p2p_allowed":bool,"custom_parameters":str|null}
      -> {"ev":"state","state":...}
  {"op":"signaling","data":b64}
  {"op":"audio","pcm":b64}                         (any length; split into 10 ms frames)
  {"op":"stop"}
Events also emitted: {"ev":"signaling","data":b64}, {"ev":"audio","pcm":b64}, {"ev":"state","state":str},
{"ev":"error","message":str}, {"ev":"stopped"}.
"""
import asyncio
import base64
import json
import sys
import threading

import ntgcalls

SAMPLE_RATE = 48000
CHANNELS = 1
FRAME_BYTES = SAMPLE_RATE // 100 * 2 * CHANNELS  # 10 ms of s16le mono = 960 bytes


def b64(data: bytes) -> str:
    return base64.b64encode(bytes(data)).decode("ascii")


def unb64(text: str) -> bytes:
    return base64.b64decode(text or "")


class Engine:
    def __init__(self, loop: asyncio.AbstractEventLoop):
        self.loop = loop
        self.ntg = ntgcalls.NTgCalls()
        self.user_id: int | None = None
        self.pending = bytearray()
        self.out_lock = threading.Lock()
        self.ntg.on_signaling_data(lambda chat_id, data: self.emit({"ev": "signaling", "data": b64(data)}))
        self.ntg.on_frames(self._on_frames)
        self.ntg.on_connection_change(lambda chat_id, info: self.emit({"ev": "state", "state": str(getattr(info, "state", info))}))
        self.ntg.on_stream_end(lambda chat_id, kind, device: self.emit({"ev": "stream_end", "device": str(device)}))

    def emit(self, obj: dict) -> None:
        line = json.dumps(obj, separators=(",", ":"))
        with self.out_lock:
            sys.stdout.write(line + "\n")
            sys.stdout.flush()

    def _on_frames(self, chat_id, mode, device, frames) -> None:
        if mode != ntgcalls.StreamMode.PLAYBACK:
            return
        pcm = b"".join(bytes(f.data) for f in frames)
        if pcm:
            self.emit({"ev": "audio", "pcm": b64(pcm)})

    @staticmethod
    def _external_audio() -> "ntgcalls.AudioDescription":
        return ntgcalls.AudioDescription(ntgcalls.MediaSource.EXTERNAL, SAMPLE_RATE, CHANNELS, "", True)

    async def start(self, cmd: dict) -> None:
        self.user_id = int(cmd["user_id"])
        dh = cmd["dh"]
        await self.ntg.create_p2p_call(self.user_id)
        # what we send (capture) and what we receive (playback) are both raw PCM handled by this process
        await self.ntg.set_stream_sources(self.user_id, ntgcalls.StreamMode.CAPTURE,
                                          ntgcalls.MediaDescription(self._external_audio(), None, None, None))
        await self.ntg.set_stream_sources(self.user_id, ntgcalls.StreamMode.PLAYBACK,
                                          ntgcalls.MediaDescription(None, self._external_audio(), None, None))
        g_a_hash = await self.ntg.init_exchange(self.user_id, ntgcalls.DhConfig(int(dh["g"]), unb64(dh["p"]), unb64(dh["random"])), None)
        p = ntgcalls.NTgCalls.get_protocol()
        self.emit({"ev": "requested", "g_a_hash": b64(g_a_hash), "protocol": {
            "min_layer": p.min_layer, "max_layer": p.max_layer, "udp_p2p": p.udp_p2p,
            "udp_reflector": p.udp_reflector, "library_versions": list(p.library_versions)}})

    async def accepted(self, cmd: dict) -> None:
        auth = await self.ntg.exchange_keys(self.user_id, unb64(cmd["g_b"]), 0)
        self.emit({"ev": "confirm", "g_a": b64(auth.g_a_or_b), "key_fingerprint": int(auth.key_fingerprint)})

    async def connect(self, cmd: dict) -> None:
        servers = [ntgcalls.RTCServer(int(s["id"]), s.get("ipv4") or "", s.get("ipv6") or "", int(s["port"]),
                                      s.get("username"), s.get("password"), bool(s.get("turn")), bool(s.get("stun")),
                                      bool(s.get("tcp")), unb64(s["peer_tag"]) if s.get("peer_tag") else None)
                   for s in cmd["servers"]]
        await self.ntg.connect_p2p(self.user_id, servers, list(cmd["library_versions"]), bool(cmd["p2p_allowed"]),
                                   cmd.get("custom_parameters") or "")
        self.emit({"ev": "state", "state": "connecting"})

    async def signaling(self, cmd: dict) -> None:
        await self.ntg.send_signaling_data(self.user_id, unb64(cmd["data"]))

    async def audio(self, cmd: dict) -> None:
        self.pending += unb64(cmd["pcm"])
        while len(self.pending) >= FRAME_BYTES:
            frame = bytes(self.pending[:FRAME_BYTES])
            del self.pending[:FRAME_BYTES]
            await self.ntg.send_external_frame(self.user_id, ntgcalls.StreamDevice.MICROPHONE, frame, ntgcalls.FrameData())

    async def stop(self) -> None:
        if self.user_id is not None:
            try:
                await self.ntg.stop(self.user_id)
            except Exception:  # already gone
                pass
        self.emit({"ev": "stopped"})


async def main() -> None:
    loop = asyncio.get_running_loop()
    engine = Engine(loop)
    queue: asyncio.Queue = asyncio.Queue()

    def reader() -> None:
        for line in sys.stdin:
            line = line.strip()
            if line:
                loop.call_soon_threadsafe(queue.put_nowait, line)
        loop.call_soon_threadsafe(queue.put_nowait, None)

    threading.Thread(target=reader, daemon=True).start()
    handlers = {"start": engine.start, "accepted": engine.accepted, "connect": engine.connect,
                "signaling": engine.signaling, "audio": engine.audio}
    while True:
        line = await queue.get()
        if line is None:
            await engine.stop()
            return
        try:
            cmd = json.loads(line)
            op = cmd.get("op")
            if op == "stop":
                await engine.stop()
                return
            handler = handlers.get(op)
            if handler is None:
                engine.emit({"ev": "error", "message": f"unknown op {op!r}"})
                continue
            await handler(cmd)
        except Exception as exc:  # report and keep serving; the worker decides whether to hang up
            engine.emit({"ev": "error", "op": cmd.get("op") if isinstance(cmd, dict) else None, "message": f"{type(exc).__name__}: {exc}"[:500]})


if __name__ == "__main__":
    asyncio.run(main())
