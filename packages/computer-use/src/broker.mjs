import { createServer } from "node:http";
import { mkdir, readFile, writeFile, rename, unlink, open } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID, timingSafeEqual } from "node:crypto";

const MAX_NATIVE_MESSAGE = 64 * 1024 * 1024;
const COMMAND_TIMEOUT = 30_000;
const pause = (ms) => new Promise((done) => setTimeout(done, ms));

export async function readConnection(homeDir) {
  return JSON.parse(await readFile(join(homeDir, "bridge.json"), "utf8"));
}

export async function bridgeFetch(connection, route, body, options = {}) {
  const response = await fetch(`${connection.url}${route}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { Authorization: `Bearer ${connection.token}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(options.timeout || 35_000)])
      : AbortSignal.timeout(options.timeout || 35_000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `Bridge request failed (${response.status}).`);
  return result;
}

async function bodyJson(request) {
  let bytes = 0;
  const chunks = [];
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > MAX_NATIVE_MESSAGE)
      throw new Error("Message exceeds Chrome native-messaging limit.");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function json(response, status, value) {
  if (response.destroyed) return;
  response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  response.end(JSON.stringify(value));
}

export async function saveSession(homeDir, snapshot) {
  if (
    snapshot?.version !== 1 ||
    !Array.isArray(snapshot.cookies) ||
    !Array.isArray(snapshot.domains)
  ) {
    throw new Error("Invalid Chrome session snapshot.");
  }
  if (!["current-domain", "all-sites"].includes(snapshot.scope))
    throw new Error("Missing explicit export scope.");
  if (snapshot.scope === "current-domain") {
    const selected = snapshot.selectedHostname;
    if (typeof selected !== "string" || !selected) throw new Error("Missing selected site.");
    for (const cookie of snapshot.cookies) {
      const domain = String(cookie.domain || "").replace(/^\./, "");
      if (
        !(domain === selected || selected.endsWith(`.${domain}`) || domain.endsWith(`.${selected}`))
      ) {
        throw new Error("Cookie outside the selected site refused.");
      }
    }
  }
  const file = join(homeDir, "chrome-session.json");
  const temporary = `${file}.${randomUUID()}.tmp`;
  await mkdir(homeDir, { recursive: true });
  await writeFile(temporary, JSON.stringify(snapshot), { mode: 0o600 });
  await rename(temporary, file);
  return {
    path: file,
    cookieCount: snapshot.cookies.length,
    domains: snapshot.domains,
    profileName: snapshot.profileName,
    capturedAt: snapshot.capturedAt,
    scope: snapshot.scope,
  };
}

/** One shared authenticated broker per fork home. Other MCP clients reuse it. */
export async function ensureBroker(
  homeDir,
  { commandTimeoutMs = COMMAND_TIMEOUT, pollTimeoutMs = 20_000 } = {},
) {
  await mkdir(homeDir, { recursive: true });
  const connectionFile = join(homeDir, "bridge.json");
  const lockFile = join(homeDir, "bridge.lock");
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      const connection = await readConnection(homeDir);
      await bridgeFetch(connection, "/status", undefined, { timeout: 500 });
      return { connection, close: async () => {} };
    } catch {
      /* A missing/stopped broker can be replaced under the exclusive lock. */
    }
    let lock;
    try {
      lock = await open(lockFile, "wx", 0o600);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      try {
        const owner = JSON.parse(await readFile(lockFile, "utf8"));
        try {
          process.kill(owner.pid, 0);
        } catch (cause) {
          if (cause.code === "ESRCH") await unlink(lockFile);
        }
      } catch {
        /* The other process may still be writing its lock. */
      }
      await pause(50);
      continue;
    }
    const instanceId = randomUUID();
    await lock.writeFile(JSON.stringify({ pid: process.pid, instanceId }));
    await lock.close();
    try {
      return await startBroker(homeDir, {
        connectionFile,
        lockFile,
        instanceId,
        commandTimeoutMs,
        pollTimeoutMs,
      });
    } catch (error) {
      await unlink(lockFile).catch(() => {});
      throw error;
    }
  }
  throw new Error(
    "Another computer-use broker is starting or holds this fork home. Retry once it is ready.",
  );
}

async function startBroker(homeDir, files) {
  const token = randomUUID() + randomUUID();
  const pending = new Map();
  let extension = null;
  let pollingResponse = null;
  const queue = [];

  function disconnect(message) {
    extension = null;
    queue.length = 0;
    if (pollingResponse) {
      json(pollingResponse, 200, { reconnect: true });
      pollingResponse = null;
    }
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(new Error(message));
    }
    pending.clear();
  }

  function enqueue(command) {
    if (pollingResponse) {
      if (pending.has(command.id)) pending.get(command.id).delivered = true;
      json(pollingResponse, 200, { command });
      pollingResponse = null;
    } else queue.push(command);
  }

  const server = createServer(async (request, response) => {
    try {
      const auth = request.headers.authorization || "";
      const expected = `Bearer ${token}`;
      if (
        request.headers.origin ||
        auth.length !== expected.length ||
        !timingSafeEqual(Buffer.from(auth), Buffer.from(expected))
      ) {
        json(response, 401, { error: "Local bridge authentication required." });
        return;
      }
      const route = new URL(request.url, "http://localhost").pathname;
      if (route === "/status") {
        json(response, 200, {
          connected: !!extension,
          extensionId: extension?.extensionId,
          controlledTabs: extension?.tabs || [],
        });
        return;
      }
      if (route === "/connect") {
        const hello = await bodyJson(request);
        disconnect("Chrome extension reconnected; request was cancelled.");
        extension = {
          sessionId: randomUUID(),
          extensionId: hello.extensionId,
          tabs: hello.tabs || [],
        };
        json(response, 200, { sessionId: extension.sessionId });
        return;
      }
      if (route === "/disconnect") {
        const body = await bodyJson(request);
        if (extension && body.sessionId === extension.sessionId)
          disconnect("Chrome extension disconnected.");
        json(response, 200, { ok: true });
        return;
      }
      if (route === "/poll") {
        const sessionId = new URL(request.url, "http://localhost").searchParams.get("sessionId");
        if (!extension || sessionId !== extension.sessionId) {
          json(response, 200, { reconnect: true });
          return;
        }
        if (pollingResponse) json(pollingResponse, 409, { error: "Duplicate native host poll." });
        const command = queue.shift();
        if (command) {
          if (pending.has(command.id)) pending.get(command.id).delivered = true;
          json(response, 200, { command });
          return;
        }
        pollingResponse = response;
        const timer = setTimeout(() => {
          if (pollingResponse === response) {
            pollingResponse = null;
            json(response, 200, { idle: true });
          }
        }, files.pollTimeoutMs);
        response.on("close", () => {
          clearTimeout(timer);
          if (pollingResponse === response) pollingResponse = null;
        });
        return;
      }
      if (route === "/state") {
        const state = await bodyJson(request);
        if (extension && state.sessionId === extension.sessionId) extension.tabs = state.tabs || [];
        json(response, 200, { ok: true });
        return;
      }
      if (route === "/export") {
        const body = await bodyJson(request);
        if (!extension || body.sessionId !== extension.sessionId)
          throw new Error("Stale extension session.");
        const result = await saveSession(homeDir, body.snapshot);
        json(response, 200, result);
        return;
      }
      if (route === "/reply") {
        const body = await bodyJson(request);
        if (!extension || body.sessionId !== extension.sessionId)
          throw new Error("Stale extension session.");
        const item = pending.get(body.id);
        if (item) {
          pending.delete(body.id);
          clearTimeout(item.timer);
          if (body.error) item.reject(new Error(String(body.error)));
          else {
            try {
              item.resolve(
                body.result?.sessionSnapshot
                  ? await saveSession(homeDir, body.result.sessionSnapshot)
                  : body.result,
              );
            } catch (error) {
              item.reject(error);
            }
          }
        }
        json(response, 200, { ok: true });
        return;
      }
      if (route === "/cancel") {
        const body = await bodyJson(request);
        const item = pending.get(body.id);
        if (item) {
          pending.delete(body.id);
          clearTimeout(item.timer);
          const queued = queue.findIndex((entry) => entry.id === body.id);
          if (queued !== -1) queue.splice(queued, 1);
          else if (item.delivered) enqueue({ type: "cancel", id: body.id });
          item.reject(
            new Error(
              "Chrome action cancelled. Already-applied input cannot be undone; take a fresh snapshot before retrying.",
            ),
          );
        }
        json(response, 200, { cancelled: !!item, delivered: !!item?.delivered });
        return;
      }
      if (route === "/call") {
        if (!extension) {
          json(response, 409, {
            error: "Chrome extension is disconnected. Open its popup and allow a tab.",
          });
          return;
        }
        const command = await bodyJson(request);
        const id = typeof command.id === "string" ? command.id : randomUUID();
        if (pending.has(id)) throw new Error("Duplicate Chrome action identifier.");
        const expiresAt = Date.now() + files.commandTimeoutMs;
        const result = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            pending.delete(id);
            const queued = queue.findIndex((entry) => entry.id === id);
            if (queued !== -1) queue.splice(queued, 1);
            reject(new Error("Chrome action timed out; take a new snapshot before retrying."));
          }, files.commandTimeoutMs);
          pending.set(id, { resolve, reject, timer, delivered: false });
          enqueue({ id, expiresAt, action: command.action, args: command.args || {} });
        });
        json(response, 200, result);
        return;
      }
      json(response, 404, { error: "Unknown bridge route." });
    } catch (error) {
      json(response, 400, { error: error.message || "Bridge request failed." });
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const connection = {
    version: 1,
    url: `http://127.0.0.1:${server.address().port}`,
    token,
    pid: process.pid,
    instanceId: files.instanceId,
  };
  await writeFile(files.connectionFile, JSON.stringify(connection), { mode: 0o600 });
  return {
    connection,
    async close() {
      disconnect("Computer-use MCP server stopped.");
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      const current = await readConnection(homeDir).catch(() => null);
      if (current?.instanceId === files.instanceId) {
        await unlink(files.connectionFile).catch(() => {});
        await unlink(files.lockFile).catch(() => {});
      }
    },
  };
}
