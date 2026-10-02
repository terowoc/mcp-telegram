import { createInterface } from "node:readline";

let generation,
  username = "alice";
const state = {
  uuids: { uuid: "fixture" },
  authorization_data: { ds_user_id: "123", sessionid: "private" },
  cookies: { sessionid: "private" },
};
function emit(v) {
  process.stdout.write(JSON.stringify({ ...v, generation }) + "\n");
}
function connected(attemptId) {
  emit({ kind: "session", attemptId, account: { id: "123", username }, session: state });
  emit({ kind: "event", attemptId, state: "connected" });
}
for await (const line of createInterface({ input: process.stdin })) {
  const f = JSON.parse(line);
  if (f.kind === "init") {
    generation = f.generation;
    emit({
      kind: "ready",
      ...(f.session?.authorization_data?.sessionid === "rate-restore" ? { error: "rate-limited" } : {}),
    });
  }
  if (f.kind === "shutdown") process.exit(0);
  if (f.kind === "login") {
    username = f.credentials.username;
    if (username === "rate") emit({ kind: "event", attemptId: f.attemptId, state: "failed", error: "rate-limited" });
    else if (username === "code") emit({ kind: "event", attemptId: f.attemptId, state: "needs-code" });
    else connected(f.attemptId);
  }
  if (f.kind === "code") connected(f.attemptId);
  if (f.kind === "tool") {
    if (f.args.threadId === "905") {
      emit({ kind: "result", id: f.id, error: "needs-verification" });
      continue;
    }
    if (f.args.threadId === "900") {
      process.stdout.write("not-json\n");
      continue;
    }
    if (f.args.threadId === "901") {
      process.stdout.write("x".repeat(262145));
      continue;
    }
    if (f.args.threadId === "902") {
      process.stdout.write(
        JSON.stringify({
          kind: "result",
          id: f.id,
          generation: "00000000-0000-4000-8000-000000000000",
          result: { messages: [] },
        }) + "\n",
      );
      continue;
    }
    if (f.args.threadId === "904") {
      await new Promise((r) => setTimeout(r, 40));
    }
    if (f.args.text === "timeout") continue;
    emit({
      kind: "result",
      id: f.id,
      result:
        f.name === "instagram-send-message"
          ? { id: "90000000000000000000", timestamp: "now" }
          : { messages: [{ id: "1", text: "fixture" }] },
    });
  }
}
