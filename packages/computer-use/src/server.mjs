#!/usr/bin/env node
import { createInterface } from "node:readline";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { homeDir } from "./config.mjs";
import { ensureBroker, bridgeFetch, bridgeCommand } from "./broker.mjs";
import { runWindowsAction } from "./windows.mjs";
import { decisionConfig, runChromeAct } from "./decision.mjs";

const string = { type: "string", minLength: 1 };
const number = { type: "number" };
const tab = { type: "integer", minimum: 0 };
const boolean = { type: "boolean" };
const keys = { type: "array", items: string, minItems: 1, maxItems: 8 };
const tools = [];
const chooser = decisionConfig();
function tool(name, description, action, properties = {}, required = [], readOnly = false) {
  if (process.env.T3_COMPUTER_USE_BROWSER_ONLY === "1" && name.startsWith("computer_")) return;
  tools.push({
    name,
    description,
    action,
    inputSchema: { type: "object", properties, required, additionalProperties: false },
    annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly, openWorldHint: true },
  });
}
tool(
  "chrome_status",
  "Check the local Chrome extension connection and user-approved tabs. If disconnected, ask the user to open the T3 Browser popup and Allow this tab.",
  "status",
  {},
  [],
  true,
);
tool(
  "chrome_tabs",
  "List only Chrome tabs currently approved in the T3 Browser popup. Unapproved tab titles and URLs are not returned.",
  "tabs",
  {},
  [],
  true,
);
tool(
  "chrome_snapshot",
  "Read an allowed tab's whole-document accessibility tree, independent of scroll position. For long pages, query searches current accessible names before maxNodes is applied and returns complete containing rows/forms/dialogs plus explicit match/ambiguity/omission metadata. Returns fresh snapshotId/element refs; refresh after actions. Frames appear only when Chrome exposes them.",
  "snapshot",
  {
    tabId: tab,
    maxNodes: { type: "integer", minimum: 1, maximum: 5000 },
    query: { type: "string", minLength: 1, maxLength: 200 },
  },
  ["tabId"],
  true,
);
tool(
  "chrome_navigate",
  "Navigate an allowed Chrome tab within its approved HTTP(S) origin. A different origin is refused; the user must open that site and approve it in the popup.",
  "navigate",
  { tabId: tab, url: string },
  ["tabId", "url"],
);
tool(
  "chrome_click",
  "Click one element using ref and snapshotId from the latest chrome_snapshot. A changed DOM or old snapshot is refused.",
  "click",
  {
    tabId: tab,
    ref: string,
    snapshotId: string,
    button: { type: "string", enum: ["left", "right", "middle"] },
    clickCount: { type: "integer", minimum: 1, maximum: 2 },
  },
  ["tabId", "ref", "snapshotId"],
);
tool(
  "chrome_type",
  "Focus an element from the latest snapshot and insert text with trusted browser input. Set clear=true to replace its current text. Password contents are never returned by snapshot.",
  "type",
  { tabId: tab, ref: string, snapshotId: string, text: { type: "string" }, clear: boolean },
  ["tabId", "ref", "snapshotId", "text"],
);
tool(
  "chrome_select",
  "Choose a native HTML select option by exact value or label from the latest snapshot. Supply exactly one of value or label. Uses a fixed select operation with input/change events; custom comboboxes use click/key instead.",
  "select",
  { tabId: tab, ref: string, snapshotId: string, value: { type: "string" }, label: string },
  ["tabId", "ref", "snapshotId"],
);
tool(
  "chrome_key",
  "Press a key or chord in an allowed Chrome tab. Examples [Enter], [Control,A], [Shift,Tab].",
  "key",
  { tabId: tab, keys },
  ["tabId", "keys"],
);
tool(
  "chrome_scroll",
  "Scroll an allowed tab by CSS pixels. Optional x/y chooses the scroll position; default is the viewport center.",
  "scroll",
  { tabId: tab, deltaX: number, deltaY: number, x: number, y: number },
  ["tabId", "deltaY"],
);
tool(
  "chrome_screenshot",
  "Save an allowed tab's current viewport screenshot locally and return its path. Images are omitted by default for text-only models; use includeImage=true only with an image-capable model.",
  "screenshot",
  { tabId: tab, includeImage: boolean },
  ["tabId"],
);
tool(
  "chrome_export_session",
  "Save the allowed tab's current-site Chrome cookies locally for T3's in-app browser import. Returns only path, count and domain scope, never cookie values. The user chooses the destination profile in T3. All-sites exports require the separate explicit popup button.",
  "exportSession",
  { tabId: tab, profileName: string },
  ["tabId"],
);
if (chooser.enabled)
  tool(
    "chrome_act",
    "Use an optional local chooser for routine actions in an approved Chrome tab. Supply a precise subtask intent and exact text slots. For a larger page, give scope={ref,snapshotId} from a fresh chrome_snapshot selecting one row, dialog, form, listitem, menu, group or region; all content inside that container is retained and outside content is explicitly excluded. It uses only current refs/options, returns when uncertain or its step budget ends, and generates no text. Use direct tools for missing facts or complex reasoning. Verify the final saved result yourself.",
    "act",
    {
      tabId: tab,
      intent: { type: "string", minLength: 1, maxLength: 2000 },
      scope: {
        type: "object",
        properties: { ref: string, snapshotId: string },
        required: ["ref", "snapshotId"],
        additionalProperties: false,
      },
      textSlots: {
        type: "array",
        maxItems: 8,
        items: {
          type: "object",
          properties: {
            id: { type: "string", minLength: 1, maxLength: 30 },
            field: { type: "string", minLength: 1, maxLength: 120 },
            text: { type: "string", maxLength: 4096 },
          },
          required: ["id", "field", "text"],
          additionalProperties: false,
        },
      },
      maxSteps: { type: "integer", minimum: 1, maximum: 8 },
      deadlineMs: { type: "integer", minimum: 1000, maximum: 60000 },
    },
    ["tabId", "intent"],
  );
tool(
  "computer_windows",
  "List visible Windows windows and identity-bound windowId tokens. Select the exact intended window before any other computer tool.",
  "windows",
  {},
  [],
  true,
);
tool(
  "computer_snapshot",
  "Read the selected Windows window's accessibility text and save a local screenshot. Pass windowId from computer_windows. Images are omitted by default for text-only models.",
  "snapshot",
  { windowId: string, includeImage: boolean },
  ["windowId"],
  true,
);
tool(
  "computer_click",
  "Click inside the selected Windows window. coordinateSpace defaults to desktop (absolute pixels); use window for pixels relative to the computer_snapshot screenshot's top-left. Refuses a stale window identity.",
  "click",
  {
    windowId: string,
    x: number,
    y: number,
    coordinateSpace: { type: "string", enum: ["desktop", "window"] },
    button: { type: "string", enum: ["left", "right", "middle"] },
    clickCount: { type: "integer", minimum: 1, maximum: 2 },
  },
  ["windowId", "x", "y"],
);
tool(
  "computer_type",
  "Type Unicode text into the selected Windows window using native input. Refuses a stale window identity.",
  "type",
  { windowId: string, text: { type: "string" } },
  ["windowId", "text"],
);
tool(
  "computer_key",
  "Press a key or chord in the selected Windows window. Examples [Control,L], [Enter], [Shift,Tab].",
  "key",
  { windowId: string, keys },
  ["windowId", "keys"],
);
tool(
  "computer_scroll",
  "Scroll in the selected Windows window. Wheel deltas use Windows units: 120 is one notch. Optional x/y default to absolute desktop pixels; set coordinateSpace=window for pixels relative to its screenshot. Without x/y, scroll at the window center.",
  "scroll",
  {
    windowId: string,
    deltaX: number,
    deltaY: number,
    x: number,
    y: number,
    coordinateSpace: { type: "string", enum: ["desktop", "window"] },
  },
  ["windowId", "deltaY"],
);

function validate(schema, value, path = "arguments") {
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error(`${path} must be an object.`);
    for (const key of schema.required || [])
      if (!(key in value)) throw new Error(`${path}.${key} is required.`);
    for (const [key, item] of Object.entries(value)) {
      if (!schema.properties[key]) throw new Error(`Unknown ${path}.${key}.`);
      validate(schema.properties[key], item, `${path}.${key}`);
    }
  } else if (schema.type === "array") {
    if (
      !Array.isArray(value) ||
      value.length < (schema.minItems || 0) ||
      value.length > (schema.maxItems || Infinity)
    )
      throw new Error(`${path} has invalid items.`);
    value.forEach((item) => validate(schema.items, item, path));
  } else {
    if (schema.type === "integer" ? !Number.isInteger(value) : typeof value !== schema.type)
      throw new Error(`${path} must be ${schema.type}.`);
    if (
      typeof value === "number" &&
      (!Number.isFinite(value) ||
        value < (schema.minimum ?? -Infinity) ||
        value > (schema.maximum ?? Infinity))
    )
      throw new Error(`${path} is outside its allowed range.`);
    if (
      typeof value === "string" &&
      (value.length < (schema.minLength || 0) || value.length > (schema.maxLength ?? Infinity))
    )
      throw new Error(`${path} has an invalid length.`);
    if (schema.enum && !schema.enum.includes(value))
      throw new Error(`${path} has an unsupported value.`);
  }
}

let ownedBroker;
const inFlight = new Map();
async function connection() {
  const broker = await ensureBroker(homeDir);
  if (broker.connection.pid === process.pid) ownedBroker = broker;
  return broker.connection;
}

async function callTool(name, args, operation) {
  const definition = tools.find((item) => item.name === name);
  if (!definition) throw new Error(`Unknown tool: ${name}`);
  validate(definition.inputSchema, args);
  if (
    definition.action === "select" &&
    (typeof args.value === "string") === (typeof args.label === "string")
  )
    throw new Error("Supply exactly one option value or label.");
  let result;
  operation.controller.signal.throwIfAborted();
  if (definition.action === "act") {
    const current = await connection();
    const routine = await runChromeAct({
      input: args,
      config: chooser,
      signal: operation.controller.signal,
      call: async (action, actionArgs, signal) => {
        return bridgeCommand(current, action, actionArgs, {
          signal,
          onCancel: (cancel) => {
            operation.cancel = cancel;
          },
        });
      },
    });
    return { content: [{ type: "text", text: JSON.stringify(routine) }] };
  } else if (name.startsWith("computer_"))
    result = await runWindowsAction(definition.action, args, homeDir, {
      signal: operation.controller.signal,
    });
  else {
    const current = await connection();
    operation.controller.signal.throwIfAborted();
    const id = randomUUID();
    operation.cancel = () =>
      bridgeFetch(current, "/cancel", { id }, { timeout: 2000 }).catch(() => {});
    result = await bridgeFetch(
      current,
      definition.action === "status" ? "/status" : "/call",
      definition.action === "status" ? undefined : { id, action: definition.action, args },
      { signal: operation.controller.signal },
    );
    operation.controller.signal.throwIfAborted();
    if (definition.action === "screenshot") {
      await mkdir(join(homeDir, "screenshots"), { recursive: true });
      const path = join(homeDir, "screenshots", `chrome-${args.tabId}-${randomUUID()}.png`);
      await writeFile(path, Buffer.from(result.imageBase64, "base64"), { mode: 0o600 });
      result.screenshotPath = path;
    }
  }
  const imageBase64 = result?.imageBase64;
  if (result && typeof result === "object") delete result.imageBase64;
  const content = [{ type: "text", text: JSON.stringify(result) }];
  if (args.includeImage && imageBase64)
    content.push({ type: "image", data: imageBase64, mimeType: "image/png" });
  return { content };
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}
async function handle(request) {
  if (request.method === "notifications/cancelled") {
    const operation = inFlight.get(request.params?.requestId);
    if (operation) {
      operation.controller.abort();
      await operation.cancel?.();
    }
    return;
  }
  if (request.id === undefined) return;
  try {
    let result;
    switch (request.method) {
      case "initialize":
        await connection();
        result = {
          protocolVersion: request.params?.protocolVersion || "2025-11-25",
          capabilities: { tools: {} },
          serverInfo: { name: "t3-computer-use", version: "0.2.0" },
          instructions:
            "Chrome control is limited to tabs explicitly allowed in the extension popup. Read fresh snapshots before actions. Select an identity-bound Windows window before native actions. Session exports remain local; never read or print their cookie values. Text snapshots and saved image paths work with text-only models. T3's existing preview_* tools operate the in-app browser.",
        };
        break;
      case "ping":
        result = {};
        break;
      case "tools/list":
        result = { tools: tools.map(({ action, ...definition }) => definition) };
        break;
      case "tools/call":
        const operation = { controller: new AbortController(), cancel: null };
        inFlight.set(request.id, operation);
        try {
          result = await callTool(request.params?.name, request.params?.arguments || {}, operation);
        } catch (error) {
          result = {
            isError: true,
            content: [{ type: "text", text: error.message || "Computer-use action failed." }],
          };
        } finally {
          inFlight.delete(request.id);
        }
        break;
      default:
        send({
          jsonrpc: "2.0",
          id: request.id,
          error: { code: -32601, message: "Method not found." },
        });
        return;
    }
    send({ jsonrpc: "2.0", id: request.id, result });
  } catch (error) {
    send({
      jsonrpc: "2.0",
      id: request.id,
      error: { code: -32603, message: error.message || "Computer-use server failed." },
    });
  }
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  try {
    void handle(JSON.parse(line));
  } catch {
    send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Invalid JSON." } });
  }
});
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await Promise.allSettled(
    [...inFlight.values()].map(async (operation) => {
      operation.controller.abort();
      await operation.cancel?.();
    }),
  );
  await ownedBroker?.close();
  process.exit(0);
}
input.on("close", () => void close());
process.on("SIGINT", () => void close());
process.on("SIGTERM", () => void close());
