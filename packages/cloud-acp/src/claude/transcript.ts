import type * as AcpSchema from "effect-acp/schema";

type SessionUpdate = AcpSchema.SessionUpdate;
type Json = { readonly [key: string]: unknown };

/** Keeps synced tool output small: a cloud transcript can carry megabytes of logs. */
const MAX_TOOL_OUTPUT = 4_000;

const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

export interface TurnOutcome {
  readonly userMessageUuids: ReadonlyArray<string>;
  readonly isError: boolean;
  readonly resultText: string | undefined;
}

function toolKind(name: string): AcpSchema.ToolKind {
  switch (name) {
    case "Bash":
    case "PowerShell":
      return "execute";
    case "Read":
    case "NotebookRead":
      return "read";
    case "Edit":
    case "MultiEdit":
    case "Write":
    case "NotebookEdit":
      return "edit";
    case "Grep":
    case "Glob":
      return "search";
    case "WebFetch":
    case "WebSearch":
      return "fetch";
    default:
      return "other";
  }
}

function toolTitle(name: string, input: unknown): string {
  const field = (key: string) => (isRecord(input) ? str(input[key]) : undefined);
  const detail =
    field("description") ??
    field("command") ??
    field("file_path") ??
    field("path") ??
    field("pattern") ??
    field("url") ??
    field("query");
  const oneLine = detail?.replace(/\s+/g, " ").trim();
  if (!oneLine) return name;
  return `${name}: ${oneLine.length > 120 ? `${oneLine.slice(0, 117)}...` : oneLine}`;
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (isRecord(part) && part.type === "text" ? (str(part.text) ?? "") : ""))
    .join("\n");
}

function truncate(text: string): string {
  return text.length > MAX_TOOL_OUTPUT
    ? `${text.slice(0, MAX_TOOL_OUTPUT)}\n... (${text.length - MAX_TOOL_OUTPUT} more characters in the cloud session)`
    : text;
}

function userText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const texts = content.flatMap((part) =>
    isRecord(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : [],
  );
  return texts.length === 0 ? undefined : texts.join("\n");
}

const text = (value: string): AcpSchema.ContentBlock => ({ type: "text", text: value });

/**
 * Maps Claude Code cloud session events (Agent SDK messages wrapped in CCR
 * events) to ACP updates. Ephemeral `stream_event` deltas stream text early;
 * the durable assistant message then only contributes the part not yet shown.
 * Subagent traffic (`parent_tool_use_id` set) stays inside its Agent tool row.
 */
export function makeClaudeTranscriptMapper(options: {
  /** User messages this client sent; their durable echoes are not rendered again. */
  readonly ownUserMessageUuids: ReadonlySet<string>;
  /** Render user turns from other devices (and history) as quoted agent text. */
  readonly quoteForeignUserMessages: boolean;
  readonly sessionUrl: string;
  /** Live turns show pending approvals; replayed history would show stale ones. */
  readonly live: boolean;
}) {
  const streamedText = new Map<string, string>();
  let streamingMessageId: string | undefined;

  // Streamed deltas stay; the durable text adds only what streaming missed.
  // When deltas were lost across a reconnect the two diverge, and the complete
  // durable text follows rather than a remainder cut at the wrong place.
  const emitAssistantText = (messageId: string, full: string): ReadonlyArray<SessionUpdate> => {
    const shown = streamedText.get(messageId) ?? "";
    if (shown.startsWith(full)) return [];
    streamedText.set(messageId, full);
    const added = full.startsWith(shown) ? full.slice(shown.length) : `\n\n${full}`;
    return [{ sessionUpdate: "agent_message_chunk", messageId, content: text(added) }];
  };

  /** Deltas are not replayed after a reconnect; wait for the next message to start. */
  const resetStream = () => {
    streamingMessageId = undefined;
  };

  const durable = (
    payload: unknown,
  ): { readonly updates: ReadonlyArray<SessionUpdate>; readonly outcome?: TurnOutcome } => {
    if (!isRecord(payload)) return { updates: [] };
    if (payload.parent_tool_use_id != null) return { updates: [] };
    switch (payload.type) {
      case "assistant": {
        const message = isRecord(payload.message) ? payload.message : undefined;
        const messageId = str(message?.id) ?? str(payload.uuid);
        const content = Array.isArray(message?.content) ? message.content : [];
        if (messageId === undefined) return { updates: [] };
        const updates: Array<SessionUpdate> = [];
        // One API message arrives as several durable events, one per content block.
        const blockTexts: Array<string> = [];
        for (const block of content) {
          if (!isRecord(block)) continue;
          if (block.type === "text" && typeof block.text === "string") {
            blockTexts.push(block.text);
          } else if (block.type === "thinking" && str(block.thinking)) {
            updates.push({
              sessionUpdate: "agent_thought_chunk",
              messageId: `${messageId}:thinking`,
              content: text(str(block.thinking) ?? ""),
            });
          } else if (block.type === "tool_use" && typeof block.id === "string") {
            const name = str(block.name) ?? "Tool";
            updates.push({
              sessionUpdate: "tool_call_update",
              toolCallId: block.id,
              name,
              title: toolTitle(name, block.input),
              kind: toolKind(name),
              status: "in_progress",
              ...(block.input === undefined ? {} : { rawInput: block.input as never }),
            });
          }
        }
        if (blockTexts.length > 0) {
          const previous = streamedText.get(`${messageId}:durable`) ?? "";
          const full = previous + blockTexts.join("");
          streamedText.set(`${messageId}:durable`, full);
          updates.unshift(...emitAssistantText(messageId, full));
        }
        return { updates };
      }
      case "user": {
        const message = isRecord(payload.message) ? payload.message : undefined;
        const content = message?.content;
        if (
          Array.isArray(content) &&
          content.some((p) => isRecord(p) && p.type === "tool_result")
        ) {
          return {
            updates: content.flatMap((part): Array<SessionUpdate> => {
              if (!isRecord(part) || part.type !== "tool_result") return [];
              const id = str(part.tool_use_id);
              if (id === undefined) return [];
              const output = truncate(toolResultText(part.content));
              return [
                {
                  sessionUpdate: "tool_call_update",
                  toolCallId: id,
                  status: part.is_error === true ? "failed" : "completed",
                  ...(output === ""
                    ? {}
                    : { content: [{ type: "content", content: text(output) }] }),
                },
              ];
            }),
          };
        }
        const uuid = str(payload.uuid);
        if (uuid !== undefined && options.ownUserMessageUuids.has(uuid)) return { updates: [] };
        if (!options.quoteForeignUserMessages || payload.isSynthetic === true) {
          return { updates: [] };
        }
        const body = userText(content);
        if (body === undefined || uuid === undefined) return { updates: [] };
        const quoted = body
          .split("\n")
          .map((line) => `> ${line}`)
          .join("\n");
        return {
          updates: [
            {
              sessionUpdate: "agent_message_chunk",
              messageId: `user:${uuid}`,
              content: text(`**User (cloud session):**\n${quoted}\n\n`),
            },
          ],
        };
      }
      // T3 cannot answer the cloud session's approval prompts; say where to.
      case "control_request": {
        const request = isRecord(payload.request) ? payload.request : undefined;
        if (!options.live || request?.subtype !== "can_use_tool") return { updates: [] };
        const tool = str(request.tool_name) ?? "a tool";
        return {
          updates: [
            {
              sessionUpdate: "agent_message_chunk",
              messageId: `approval:${str(payload.request_id) ?? tool}`,
              content: text(
                `\n\nThe cloud session is waiting for approval to use ${tool}. Approve it in the [cloud session](${options.sessionUrl}); T3 shows the result here.\n\n`,
              ),
            },
          ],
        };
      }
      case "result": {
        const uuids = Array.isArray(payload.user_message_uuids)
          ? payload.user_message_uuids.filter((v): v is string => typeof v === "string")
          : typeof payload.user_message_uuid === "string"
            ? [payload.user_message_uuid]
            : [];
        return {
          updates: [],
          outcome: {
            userMessageUuids: uuids,
            isError: payload.is_error === true,
            resultText: str(payload.result),
          },
        };
      }
      default:
        return { updates: [] };
    }
  };

  const ephemeral = (payload: unknown): ReadonlyArray<SessionUpdate> => {
    if (!isRecord(payload) || payload.type !== "stream_event") return [];
    if (payload.parent_tool_use_id != null) return [];
    const event = isRecord(payload.event) ? payload.event : undefined;
    if (event?.type === "message_start") {
      streamingMessageId = isRecord(event.message) ? str(event.message.id) : undefined;
      return [];
    }
    if (event?.type !== "content_block_delta" || streamingMessageId === undefined) return [];
    const delta = isRecord(event.delta) ? event.delta : undefined;
    if (delta?.type !== "text_delta" || typeof delta.text !== "string") return [];
    const messageId = streamingMessageId;
    streamedText.set(messageId, (streamedText.get(messageId) ?? "") + delta.text);
    return [{ sessionUpdate: "agent_message_chunk", messageId, content: text(delta.text) }];
  };

  return { durable, ephemeral, resetStream };
}
