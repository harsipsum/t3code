import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { ensureBroker, bridgeFetch, bridgeCommand } from "../src/broker.mjs";
import { projectSnapshot } from "../../../apps/chrome-extension/snapshot.js";

async function temporary(t) {
  const dir = await mkdtemp(join(tmpdir(), "t3-computer-use-test-"));
  t.after(async () => {
    const target = resolve(dir);
    assert.ok(
      target.startsWith(resolve(tmpdir()) + sep) && target.includes("t3-computer-use-test-"),
    );
    await rm(target, { recursive: true, force: true });
  });
  return dir;
}

function nativeStream(child) {
  let buffer = Buffer.alloc(0);
  const messages = [];
  const waiters = [];
  child.stdout.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32LE(0)) {
      const length = buffer.readUInt32LE(0);
      const message = JSON.parse(buffer.subarray(4, 4 + length).toString("utf8"));
      buffer = buffer.subarray(4 + length);
      const waiter = waiters.shift();
      if (waiter) waiter(message);
      else messages.push(message);
    }
  });
  return {
    send(message, fragmented = false) {
      const body = Buffer.from(JSON.stringify(message));
      const header = Buffer.alloc(4);
      header.writeUInt32LE(body.length);
      const frame = Buffer.concat([header, body]);
      if (fragmented) {
        child.stdin.write(frame.subarray(0, 2));
        child.stdin.write(frame.subarray(2));
      } else child.stdin.write(frame);
    },
    next() {
      return messages.length
        ? Promise.resolve(messages.shift())
        : new Promise((done) => waiters.push(done));
    },
  };
}

test(
  "real framed native host round-trip and private cookie export",
  { timeout: 10_000 },
  async (t) => {
    const dir = await temporary(t);
    const broker = await ensureBroker(dir);
    t.after(() => broker.close());
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL("../src/native-host.mjs", import.meta.url)), "--home", dir],
      { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
    );
    t.after(() => child.kill());
    const stream = nativeStream(child);
    stream.send({ type: "hello", extensionId: "a".repeat(32), tabs: [{ tabId: 9 }] }, true);
    assert.equal((await stream.next()).type, "connected");
    const call = bridgeFetch(broker.connection, "/call", {
      action: "snapshot",
      args: { tabId: 9 },
    });
    const command = await stream.next();
    assert.equal(command.action, "snapshot");
    assert.ok(command.expiresAt > Date.now());
    stream.send({ type: "reply", id: command.id, result: { text: "button Continue" } });
    assert.equal((await call).text, "button Continue");
    const snapshot = {
      version: 1,
      capturedAt: new Date().toISOString(),
      browser: "chrome",
      profileName: "Local proof",
      scope: "current-domain",
      selectedHostname: "localhost",
      domains: ["localhost"],
      cookies: [
        {
          name: "demo",
          value: "controlled-cookie-proof",
          domain: "localhost",
          path: "/",
          secure: false,
          httpOnly: true,
          sameSite: "lax",
          hostOnly: true,
          session: true,
        },
      ],
    };
    stream.send({ type: "session-export", requestId: "proof", snapshot });
    const exported = await stream.next();
    assert.equal(exported.type, "exported");
    assert.equal(exported.result.cookieCount, 1);
    assert.equal(JSON.stringify(exported).includes("controlled-cookie-proof"), false);
    assert.deepEqual(JSON.parse(await readFile(exported.result.path, "utf8")), snapshot);
    child.stdin.end();
    await once(child, "exit");
  },
);

test(
  "native host started before its MCP broker recovers when the broker appears",
  { timeout: 5000 },
  async (t) => {
    const dir = await temporary(t);
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL("../src/native-host.mjs", import.meta.url)), "--home", dir],
      { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
    );
    t.after(() => child.kill());
    const stream = nativeStream(child);
    stream.send({ type: "hello", extensionId: "startup-proof", tabs: [] });
    assert.equal((await stream.next()).type, "error");
    const broker = await ensureBroker(dir);
    t.after(() => broker.close());
    assert.equal((await stream.next()).type, "connected");
    assert.equal((await bridgeFetch(broker.connection, "/status")).extensionId, "startup-proof");
    child.stdin.end();
    await once(child, "exit");
  },
);

test("expired queued mutation is removed before native polling", { timeout: 5000 }, async (t) => {
  const dir = await temporary(t);
  const broker = await ensureBroker(dir, { commandTimeoutMs: 25, pollTimeoutMs: 10 });
  t.after(() => broker.close());
  const session = await bridgeFetch(broker.connection, "/connect", { extensionId: "proof" });
  await assert.rejects(
    bridgeFetch(broker.connection, "/call", { action: "click", args: { tabId: 9 } }),
    /timed out/,
  );
  const polled = await bridgeFetch(broker.connection, `/poll?sessionId=${session.sessionId}`);
  assert.equal(polled.command, undefined);
  assert.equal(polled.idle, true);
});

test("stale native host cannot disconnect its replacement", async (t) => {
  const dir = await temporary(t);
  const broker = await ensureBroker(dir);
  t.after(() => broker.close());
  const first = await bridgeFetch(broker.connection, "/connect", { extensionId: "first" });
  await bridgeFetch(broker.connection, "/connect", { extensionId: "replacement" });
  await bridgeFetch(broker.connection, "/disconnect", { sessionId: first.sessionId });
  assert.equal((await bridgeFetch(broker.connection, "/status")).extensionId, "replacement");
});

test("cancelled queued action never reaches native host", async (t) => {
  const dir = await temporary(t);
  const broker = await ensureBroker(dir, { pollTimeoutMs: 10 });
  t.after(() => broker.close());
  const session = await bridgeFetch(broker.connection, "/connect", { extensionId: "proof" });
  const call = bridgeFetch(broker.connection, "/call", {
    id: "cancel-proof",
    action: "click",
    args: { tabId: 9 },
  });
  const rejected = assert.rejects(call, /cancelled/);
  const cancellation = await bridgeFetch(broker.connection, "/cancel", { id: "cancel-proof" });
  assert.equal(cancellation.cancelled, true);
  await rejected;
  const polled = await bridgeFetch(broker.connection, `/poll?sessionId=${session.sessionId}`);
  assert.equal(polled.command, undefined);
});

test("an internal routine abort awaits cancellation of its queued broker command", async (t) => {
  const queued = new Map();
  let markQueued;
  const received = new Promise((resolve) => {
    markQueued = resolve;
  });
  const server = createServer(async (request, response) => {
    let text = "";
    for await (const chunk of request) text += chunk;
    const body = JSON.parse(text);
    if (request.url === "/call") {
      queued.set(body.id, body);
      markQueued();
      return;
    }
    if (request.url === "/cancel") {
      queued.delete(body.id);
      response.end(JSON.stringify({ cancelled: true }));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const controller = new AbortController();
  const action = bridgeCommand(
    { url: `http://127.0.0.1:${server.address().port}`, token: "synthetic" },
    "click",
    { tabId: 9 },
    { signal: controller.signal },
  );
  const refused = assert.rejects(action);
  await received;
  assert.equal(queued.size, 1);
  controller.abort();
  await refused;
  assert.equal(queued.size, 0, "no queued mutation survives the internal deadline/abort");
});

test("snapshot can verify ordinary input while password/unknown values stay private", () => {
  const nodes = [
    {
      role: { value: "textbox" },
      name: { value: "Email" },
      backendDOMNodeId: 1,
      safeValue: "demo@example.test",
    },
    {
      role: { value: "textbox" },
      name: { value: "Password" },
      backendDOMNodeId: 2,
      isPassword: true,
      value: { value: "secret-proof" },
    },
    {
      role: { value: "textbox" },
      name: { value: "Unknown" },
      backendDOMNodeId: 3,
      value: { value: "unknown-secret" },
    },
  ];
  const snapshot = projectSnapshot(nodes);
  assert.match(snapshot.text, /demo@example.test/);
  assert.match(snapshot.text, /redacted/);
  assert.doesNotMatch(snapshot.text, /secret-proof|unknown-secret/);
});
