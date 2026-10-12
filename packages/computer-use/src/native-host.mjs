import { homeDir as defaultHomeDir } from "./config.mjs";
import { readConnection, bridgeFetch } from "./broker.mjs";

const homeDir = process.argv.includes("--home")
  ? process.argv[process.argv.indexOf("--home") + 1]
  : defaultHomeDir;
const MAX_FROM_CHROME = 64 * 1024 * 1024;
const MAX_TO_CHROME = 1024 * 1024;
let buffer = Buffer.alloc(0);
let connection;
let sessionId;
let hello;
let stopped = false;
let inbound = Promise.resolve();
let polling = false;

function send(message) {
  const json = Buffer.from(JSON.stringify(message));
  if (json.length > MAX_TO_CHROME)
    throw new Error("Native host message exceeds Chrome's 1 MiB limit.");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(json.length);
  process.stdout.write(Buffer.concat([header, json]));
}

async function connect() {
  if (stopped) return;
  connection = await readConnection(homeDir);
  const result = await bridgeFetch(connection, "/connect", hello);
  sessionId = result.sessionId;
  send({ type: "connected", sessionId });
}

async function receive(message) {
  if (stopped) return;
  if (message.type === "hello") {
    hello = message;
    try {
      await connect();
    } catch {
      send({
        type: "error",
        message: "Native bridge is unavailable. Start the T3 computer-use MCP server.",
      });
    }
    if (!polling) {
      polling = true;
      void poll().finally(() => {
        polling = false;
      });
    }
  } else if (message.type === "reply") {
    await bridgeFetch(connection, "/reply", { ...message, sessionId });
  } else if (message.type === "state") {
    await bridgeFetch(connection, "/state", { ...message, sessionId });
  } else if (message.type === "session-export") {
    const result = await bridgeFetch(connection, "/export", {
      snapshot: message.snapshot,
      sessionId,
    });
    send({ type: "exported", requestId: message.requestId, result });
  }
}

async function poll() {
  while (!stopped) {
    try {
      const result = await bridgeFetch(
        connection,
        `/poll?sessionId=${encodeURIComponent(sessionId)}`,
      );
      if (stopped) break;
      if (result.reconnect) await connect();
      else if (result.command) send({ type: "command", ...result.command });
    } catch {
      // A provider restart can replace the broker. Re-read only this fork's connection.
      await new Promise((done) => setTimeout(done, 750));
      if (stopped) break;
      try {
        await connect();
      } catch {
        /* Wait for the configured T3 provider to return. */
      }
    }
  }
}

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (buffer.length >= 4) {
    const length = buffer.readUInt32LE(0);
    if (length > MAX_FROM_CHROME) {
      process.stderr.write("Invalid native message size.\n");
      process.exit(1);
    }
    if (buffer.length < length + 4) break;
    const frame = buffer.subarray(4, length + 4);
    buffer = buffer.subarray(length + 4);
    try {
      const message = JSON.parse(frame.toString("utf8"));
      inbound = inbound
        .then(() => receive(message))
        .catch(() =>
          send({
            type: "error",
            message: "Native bridge is unavailable. Start the T3 computer-use MCP server.",
          }),
        );
    } catch {
      send({ type: "error", message: "Invalid native message JSON." });
    }
  }
});
process.stdin.on("end", async () => {
  stopped = true;
  if (connection) await bridgeFetch(connection, "/disconnect", { sessionId }).catch(() => {});
  process.exit(0);
});
