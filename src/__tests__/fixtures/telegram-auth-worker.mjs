let init;
process.on("message", (message) => {
  if (message.kind === "init") {
    init = message;
    process.send({ generation: init.generation, attemptId: init.attemptId, event: { type: "token", token: "AQID", expiresAt: Date.now()+30000 } });
    if (init.apiId === 4) { setTimeout(() => process.exit(1), 20); return; }
    if (init.apiId === 1) process.send({ generation: "old-generation", attemptId: init.attemptId, event: { type: "verified", proof: { attemptId: init.attemptId, account: { id:"666" }, session: "stale-session", authenticatedAt:Date.now() } } });
    else if (init.apiId === 2) process.send({ generation:init.generation, attemptId:init.attemptId, event: { type:"needs-password" } });
    else process.send({ generation:init.generation, attemptId:init.attemptId, event: { type:"verified", proof: { attemptId:init.attemptId, account:{id:"12345"},session:"synthetic-server-session",authenticatedAt:Date.now() } } });
  }
  if (message.kind === "password") process.send({ generation:init.generation, attemptId:init.attemptId, event: { type:"verified",proof:{attemptId:init.attemptId,account:{id:"12345"},session:"synthetic-server-session",authenticatedAt:Date.now()} } });
  if (message.kind === "shutdown") setTimeout(() => process.exit(0), 100);
});
