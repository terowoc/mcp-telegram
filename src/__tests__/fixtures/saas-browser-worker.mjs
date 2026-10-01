// Synthetic IPC worker for the browser acceptance test; never connects to Telegram.
let generation, login;
process.on("message", (message) => {
  if (message.kind === "init") {
    generation = message.generation;
    process.send({ kind: "ready", generation });
  } else if (message.kind === "login-start") {
    login = message;
    process.send({
      kind: "event",
      generation,
      id: login.id,
      attemptId: login.attemptId,
      event: {
        type: "qr",
        dataUrl:
          "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
        expiresAt: Date.now() + 300000,
      },
    });
    setTimeout(() => {
      if (login)
        process.send({
          kind: "event",
          generation,
          id: login.id,
          attemptId: login.attemptId,
          event: { type: "needs-password" },
        });
    }, 2200);
  } else if (message.kind === "login-password") {
    process.send({ kind: "session-save", generation, id: "fixture-save", session: "synthetic-session" });
  } else if (message.kind === "ack" && message.id === "fixture-save" && message.ok && login) {
    process.send({
      kind: "event",
      generation,
      id: login.id,
      attemptId: login.attemptId,
      event: { type: "success", account: { id: "222", username: "fixture_server" } },
    });
    process.send({ kind: "result", generation, id: login.id, result: true });
  } else if (message.kind === "shutdown") process.exit(0);
});
