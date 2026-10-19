// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientResponse } from "effect/http";
import type * as AcpSchema from "effect-acp/schema";

import type { PromptInput } from "../agent.ts";
import { makeSessionStore } from "../state.ts";
import { makeClaudeCloudBackend } from "./backend.ts";
import fixture from "./fixtures/proof-session.events.json" with { type: "json" };

const SESSION = "session_01E8BrGrSh9tboAbzz1K5sC2";

interface RecordedEvent {
  readonly sequence_num: number;
  readonly payload: Record<string, unknown>;
}

/**
 * Stands in for api.anthropic.com: serves the recorded transcript, accepts
 * posted events, and answers a posted user message the way the cloud worker
 * does (echo, streamed text, durable message, then a result naming it).
 */
function makeCloudSession(options: { readonly answer: boolean }) {
  const events: Array<RecordedEvent> = fixture.events.map((event) => ({ ...event }));
  const posted: Array<Record<string, unknown>> = [];
  let markUserPosted: () => void = () => {};
  const userPosted = new Promise<void>((resolve) => (markUserPosted = resolve));
  const listeners = new Set<(frame: string) => void>();
  const push = (frame: string) => listeners.forEach((listener) => listener(frame));
  const appendDurable = (payload: Record<string, unknown>) => {
    const event = { sequence_num: events.length + 1, payload };
    events.push(event);
    push(`event: client_event\nid: ${event.sequence_num}\ndata: ${JSON.stringify(event)}\n\n`);
  };
  const finishTurn = (uuid: string | undefined) =>
    appendDurable({
      type: "result",
      uuid: `result-${events.length}`,
      subtype: "success",
      is_error: false,
      result: "done",
      ...(uuid === undefined ? {} : { user_message_uuids: [uuid] }),
    });

  const respond = (
    request: {
      readonly method: string;
      readonly url: string;
      readonly headers: Record<string, string>;
    },
    body: unknown,
  ) => {
    const url = new URL(request.url);
    const json = (value: unknown, status = 200) =>
      new Response(JSON.stringify(value), {
        status,
        headers: { "content-type": "application/json" },
      });
    if (url.pathname === `/v1/code/sessions/${SESSION}` && request.method === "GET") {
      return json({ session: { id: SESSION, title: "proof", worker_status: "idle" } });
    }
    if (url.pathname === `/v1/code/sessions/${SESSION}/events` && request.method === "GET") {
      const after = Number(url.searchParams.get("cursor") ?? 0);
      return json({
        data: events.filter((event) => event.sequence_num > after),
        next_cursor: null,
      });
    }
    if (url.pathname === `/v1/code/sessions/${SESSION}/events/stream`) {
      const after = Number(request.headers["last-event-id"] ?? 0);
      const encoder = new TextEncoder();
      let listener: (frame: string) => void = () => {};
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const event of events.filter((candidate) => candidate.sequence_num > after)) {
            controller.enqueue(
              encoder.encode(
                `event: client_event\nid: ${event.sequence_num}\ndata: ${JSON.stringify(event)}\n\n`,
              ),
            );
          }
          listener = (frame) => controller.enqueue(encoder.encode(frame));
          listeners.add(listener);
        },
        cancel() {
          listeners.delete(listener);
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }
    if (url.pathname === `/v1/code/sessions/${SESSION}/events` && request.method === "POST") {
      const sent = (body as { events: Array<Record<string, unknown>> }).events[0]!;
      posted.push(sent);
      if (sent.type === "user") {
        appendDurable(sent);
        markUserPosted();
        if (options.answer) {
          const uuid = String(sent.uuid);
          const message = { id: "msg_answer", role: "assistant" };
          push(
            `event: ephemeral_event\ndata: ${JSON.stringify({ payload: { type: "stream_event", parent_tool_use_id: null, event: { type: "message_start", message } } })}\n\n`,
          );
          push(
            `event: ephemeral_event\ndata: ${JSON.stringify({ payload: { type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Follow-up " } } } })}\n\n`,
          );
          appendDurable({
            type: "assistant",
            uuid: "answer-1",
            parent_tool_use_id: null,
            message: {
              ...message,
              content: [{ type: "text", text: "Follow-up reached the session." }],
            },
          });
          finishTurn(uuid);
        }
      } else if (sent.type === "control_request") {
        const open = posted.findLast((event) => event.type === "user");
        finishTurn(open === undefined ? undefined : String(open.uuid));
      }
      return json({ results: [{ sequence_num: events.length, duplicate: false }] });
    }
    return json({ error: { message: `unexpected ${request.method} ${url.pathname}` } }, 500);
  };

  const http = HttpClient.make((request) =>
    Effect.sync(() => {
      const body =
        request.body._tag === "Uint8Array"
          ? JSON.parse(new TextDecoder().decode(request.body.body))
          : undefined;
      return HttpClientResponse.fromWeb(
        request,
        respond({ method: request.method, url: request.url, headers: request.headers }, body),
      );
    }),
  );
  return { http, posted, events, userPosted, finishTurn };
}

const setup = (options: { readonly answer: boolean }) =>
  Effect.gen(function* () {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "cloud-acp-claude-"));
    const configDir = NodePath.join(root, "claude");
    NodeFS.mkdirSync(configDir);
    NodeFS.writeFileSync(
      NodePath.join(configDir, ".credentials.json"),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "test-token",
          expiresAt: 4_102_444_800_000,
          scopes: ["user:inference", "user:sessions:claude_code"],
        },
      }),
    );
    process.env.CLAUDE_CONFIG_DIR = configDir;
    const cloud = makeCloudSession(options);
    const layer = Layer.mergeAll(
      NodeServices.layer,
      Layer.succeed(HttpClient.HttpClient, cloud.http),
    );
    const store = yield* makeSessionStore(NodePath.join(root, "state")).pipe(Effect.provide(layer));
    const backend = yield* makeClaudeCloudBackend(store, "test").pipe(Effect.provide(layer));
    const run = (text: string, sync = false) =>
      Effect.gen(function* () {
        const updates: Array<AcpSchema.SessionUpdate> = [];
        const cancelled = yield* Deferred.make<void>();
        const input: PromptInput = {
          sessionId: SESSION,
          cwd: root,
          text,
          cancelled,
          emit: (update) => Effect.sync(() => void updates.push(update)),
        };
        const fiber = yield* Effect.forkChild(sync ? backend.sync(input) : backend.prompt(input));
        return { fiber, updates, cancelled };
      });
    return { run, cloud, store };
  });

const shownText = (updates: ReadonlyArray<AcpSchema.SessionUpdate>) =>
  updates
    .flatMap((update) => {
      const content = (update as { content?: { type?: string; text?: string } }).content;
      return update.sessionUpdate === "agent_message_chunk" && content?.type === "text"
        ? [content.text ?? ""]
        : [];
    })
    .join("");

describe("Claude Code cloud backend", () => {
  it.effect("shows an imported session once, then follows the sent message to its own result", () =>
    Effect.gen(function* () {
      const { run, cloud, store } = yield* setup({ answer: true });
      const first = yield* run("Please summarize what you pushed.");
      assert.equal(yield* Fiber.join(first.fiber), "end_turn");

      const sent = cloud.posted.filter((event) => event.type === "user");
      assert.equal(sent.length, 1);
      assert.equal(
        (sent[0]!.message as { content: string }).content,
        "Please summarize what you pushed.",
      );

      const text = shownText(first.updates);
      assert.include(text, "as commit `1a21831726c77bfce5473f0fc81168f058ef74db`");
      assert.include(text, "> Bounded proof task for a T3 Code integration test.");
      assert.equal(text.split("as commit `1a21831726c77bfce5473f0fc81168f058ef74db`").length, 2);
      // Streamed delta plus the durable remainder, never the sentence twice.
      assert.include(text, "Follow-up reached the session.");
      assert.notInclude(text, "Follow-up Follow-up");
      assert.notInclude(text, "Please summarize what you pushed.");

      const pushTool = first.updates.filter(
        (update) =>
          update.sessionUpdate === "tool_call_update" &&
          update.toolCallId === "toolu_01298xUFn48T89J194ovbGpJ",
      );
      assert.deepEqual(
        pushTool.map((update) =>
          update.sessionUpdate === "tool_call_update" ? update.status : null,
        ),
        ["in_progress", "completed"],
      );
      assert.equal((yield* store.read(SESSION)).deliveredSequence, cloud.events.length);

      const again = yield* run("/sync", true);
      assert.equal(yield* Fiber.join(again.fiber), "end_turn");
      assert.notInclude(shownText(again.updates), "1a21831726c77bfce5473f0fc81168f058ef74db");
      assert.include(shownText(again.updates), "nothing new since T3 last showed it");
    }),
  );

  it.effect("after T3 dies mid-turn, sync shows only the rest of the turn", () =>
    Effect.gen(function* () {
      const { run, cloud } = yield* setup({ answer: false });
      const turn = yield* run("Long task that outlives T3");
      yield* Effect.promise(() => cloud.userPosted);
      // T3 restarting kills this agent process mid-turn; the cloud keeps working.
      yield* Fiber.interrupt(turn.fiber);
      const sent = cloud.posted.find((event) => event.type === "user")!;
      cloud.finishTurn(String(sent.uuid));

      const synced = yield* run("Continue where you left off.", true);
      assert.equal(yield* Fiber.join(synced.fiber), "end_turn");
      const text = shownText(synced.updates);
      assert.notInclude(text, "Long task that outlives T3");
      assert.notInclude(text, "1a21831726c77bfce5473f0fc81168f058ef74db");
      assert.equal(cloud.posted.filter((event) => event.type === "user").length, 1);
    }),
  );

  it.effect("Stop sends the cloud session's interrupt and settles on its result", () =>
    Effect.gen(function* () {
      const { run, cloud } = yield* setup({ answer: false });
      const turn = yield* run("Long task");
      yield* Effect.promise(() => cloud.userPosted);
      yield* Deferred.succeed(turn.cancelled, undefined);
      assert.equal(yield* Fiber.join(turn.fiber), "cancelled");
      const interrupt = cloud.posted.find((event) => event.type === "control_request");
      assert.deepEqual(interrupt?.request, { subtype: "interrupt" });
    }),
  );
});
