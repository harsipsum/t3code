import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";

const argument = (name) => process.argv[process.argv.indexOf(name) + 1];
const historyFile = process.argv.includes("--history-file")
  ? argument("--history-file")
  : undefined;
const triggerFile = process.argv.includes("--trigger-file")
  ? argument("--trigger-file")
  : undefined;
const sessionId = "conversation-sync-session";
const reportSyncStatus = process.argv.includes("--sync-status");
const statusMeta = (state, fields) =>
  reportSyncStatus ? { "t3/syncStatus": { state, ...fields } } : {};
const computer = {
  url: "http://localhost:9222/computer",
  title: "Connector computer",
  state: "live",
};
const origin = { label: "Typed in connector app", url: "https://example.com/conversation" };
let history =
  historyFile && NodeFS.existsSync(historyFile)
    ? JSON.parse(NodeFS.readFileSync(historyFile, "utf8"))
    : [];
let lastTrigger = "";
let lastEcho;
const write = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const notify = (update, meta) =>
  write({
    jsonrpc: "2.0",
    method: "session/update",
    params: { sessionId, update, ...(meta === undefined ? {} : { _meta: meta }) },
  });
const message = (role, text, id, messageOrigin) => ({
  sessionUpdate: role === "user" ? "user_message_chunk" : "agent_message_chunk",
  content: { type: "text", text },
  _meta: { "t3/messageId": id, ...(messageOrigin ? { "t3/origin": messageOrigin } : {}) },
});
const save = () => {
  if (historyFile) NodeFS.writeFileSync(historyFile, JSON.stringify(history));
};
const exchange = (key) => {
  const textKey = key.startsWith("repeat-") ? "one" : key;
  const updates = [
    message("user", "External ", `external-user-${key}`, origin),
    message("user", `question ${textKey}`, `external-user-${key}`, origin),
    message("assistant", `External answer ${textKey}`, `external-agent-${key}`),
  ];
  history.push(...updates);
  save();
  updates.forEach((update) => notify(update));
};
const watcher = triggerFile
  ? NodeFS.watch(NodePath.dirname(triggerFile), (_, filename) => {
      if (String(filename) !== NodePath.basename(triggerFile) || !NodeFS.existsSync(triggerFile))
        return;
      const key = NodeFS.readFileSync(triggerFile, "utf8");
      if (!key || key === lastTrigger) return;
      lastTrigger = key;
      if (key.startsWith("status:")) {
        const state = key.slice(7);
        const meta = statusMeta(state, {
          readOnly: true,
          partial: true,
          message: "Conversation " + state,
        });
        notify(
          {
            sessionUpdate: "session_info_update",
            title: key,
            ...(state === "disconnected" ? {} : { _meta: meta }),
          },
          state === "disconnected" ? meta : undefined,
        );
      } else if (key === "echo" || key.startsWith("echo-no-id:")) {
        if (lastEcho)
          notify(
            key === "echo"
              ? lastEcho
              : { ...lastEcho, content: { type: "text", text: key.slice(11) }, _meta: {} },
          );
        notify({
          sessionUpdate: "session_info_update",
          title: key,
          _meta: { "t3/computer": { ...computer, title: key } },
        });
      } else exchange(key);
    })
  : undefined;

for await (const line of NodeReadline.createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (request.id === undefined) continue;
  let result;
  switch (request.method) {
    case "initialize":
      result = {
        protocolVersion: 1,
        agentInfo: { name: "conversation-sync", version: "1" },
        _meta: { "t3/nativeConversation": true },
        agentCapabilities: { loadSession: true, sessionCapabilities: { list: {} } },
      };
      break;
    case "session/new":
      result = {
        sessionId,
        _meta: {
          "t3/computer": computer,
          ...statusMeta("connecting", { readOnly: true, message: "Opening conversation" }),
        },
      };
      break;
    case "session/list":
      result = { sessions: [{ sessionId, cwd: process.cwd(), title: "Connector conversation" }] };
      break;
    case "session/load":
      if (historyFile && NodeFS.existsSync(historyFile))
        history = JSON.parse(NodeFS.readFileSync(historyFile, "utf8"));
      history.forEach((update) => notify(update));
      result = {
        _meta: {
          "t3/computer": computer,
          ...statusMeta("live", { readOnly: false, partial: false }),
        },
      };
      break;
    case "session/prompt": {
      const text = request.params.prompt.find((part) => part.type === "text")?.text ?? "";
      const id = request.params._meta?.["t3/messageId"] ?? `echo-${history.length}`;
      const echo = message("user", text, id);
      lastEcho = echo;
      const answer = message("assistant", "Reply to T3", `reply-${id}`);
      history.push(echo, answer);
      save();
      notify(echo);
      notify(answer);
      result = { stopReason: "end_turn" };
      // A late echo arrives only after the foreground RPC has settled.
      write({ jsonrpc: "2.0", id: request.id, result });
      setImmediate(() => {
        notify(echo);
        notify({
          sessionUpdate: "session_info_update",
          title: "Echo delivered",
          _meta: { "t3/computer": { ...computer, title: "Echo delivered" } },
        });
      });
      continue;
    }
    default:
      write({
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32601, message: "Method not found" },
      });
      continue;
  }
  write({ jsonrpc: "2.0", id: request.id, result });
}
watcher?.close();
