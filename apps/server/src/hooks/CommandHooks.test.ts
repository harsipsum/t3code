import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ServerSettings from "../serverSettings.ts";
import * as CommandHooks from "./CommandHooks.ts";

// Records each payload it reads on stdin, then behaves as `mode` says.
const HOOK_SCRIPT = `
const fs = require("node:fs");
const [, , log, mode, message] = process.argv;
fs.appendFileSync(log, fs.readFileSync(0, "utf8") + "\\n");
if (mode === "block") { process.stderr.write(message); process.exit(2); }
if (mode === "block-stdout") { process.stdout.write(message); process.exit(2); }
if (mode === "warn") process.stderr.write(message);
if (mode === "crash") { process.stderr.write("boom"); process.exit(3); }
if (mode === "hang") setTimeout(() => {}, 60_000);
`;

const sender: CommandHooks.HookThread = {
  threadId: ThreadId.make("thread:hooks:lead"),
  projectId: ProjectId.make("project:hooks"),
  title: "Lead",
  providerInstanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5-codex",
};

const dispatchInput = (text: string): CommandHooks.AgentDispatchHookInput => ({
  action: "thread_send",
  text,
  sender,
  recipients: [{ kind: "thread", ...sender, threadId: ThreadId.make("thread:hooks:worker") }],
  command: {
    type: "message.dispatch",
    commandId: CommandId.make("command:hooks:send"),
    threadId: ThreadId.make("thread:hooks:worker"),
    senderThreadId: sender.threadId,
    messageId: MessageId.make("message:hooks:send"),
    text,
    attachments: [],
    dispatchMode: { type: "queue_after_active" },
    createdBy: "agent",
    creationSource: "mcp",
  },
});

/** A real hook process per test, configured the way settings.json would. */
const withHook = <A, E>(
  name: "agentDispatch" | "assistantReply",
  mode: string,
  run: (context: {
    readonly hooks: CommandHooks.CommandHooksShape;
    readonly payloads: Effect.Effect<ReadonlyArray<Record<string, unknown>>>;
  }) => Effect.Effect<A, E>,
  options: {
    readonly message?: string;
    readonly timeoutMs?: number;
    readonly command?: string;
  } = {},
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-hooks-" });
    const script = path.join(dir, "hook.cjs");
    const log = path.join(dir, "payloads.log");
    yield* fs.writeFileString(script, HOOK_SCRIPT);
    yield* fs.writeFileString(log, "");
    const payloads = fs.readFileString(log).pipe(
      Effect.map((text) =>
        text
          .split("\n")
          .filter((line) => line.trim() !== "")
          .map((line) => JSON.parse(line) as Record<string, unknown>),
      ),
      Effect.orDie,
    );
    const hook = {
      command: options.command ?? process.execPath,
      args: [script, log, mode, options.message ?? ""],
      timeoutMs: options.timeoutMs ?? 10_000,
    };
    return yield* Effect.gen(function* () {
      const hooks = yield* CommandHooks.CommandHooks;
      return yield* run({ hooks, payloads });
    }).pipe(
      Effect.provide(
        CommandHooks.layer.pipe(
          Layer.provide(ServerSettings.layerTest({ hooks: { [name]: hook } })),
        ),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

describe("verdictForHookResult", () => {
  const result = (code: number | null, stderr = "", stdout = "", timedOut = false) =>
    CommandHooks.verdictForHookResult({ code: code as never, stderr, stdout, timedOut }, 5_000);

  it("allows a clean exit and turns its stderr into a warning", () => {
    expect(result(0)).toEqual({ _tag: "allow", warning: undefined });
    expect(result(0, " check the recipient \n")).toEqual({
      _tag: "allow",
      warning: "check the recipient",
    });
  });

  it("blocks exit 2 with stderr, then stdout, as the reason", () => {
    expect(result(2, "names a private client")).toEqual({
      _tag: "block",
      reason: "names a private client",
    });
    expect(result(2, "", "from stdout")).toEqual({ _tag: "block", reason: "from stdout" });
    expect(result(2)).toEqual({ _tag: "block", reason: "The hook gave no reason." });
  });

  it("blocks any other exit and a timeout instead of letting them through", () => {
    expect(result(1, "bad config")).toEqual({
      _tag: "block",
      reason: "The hook failed with exit code 1: bad config",
    });
    expect(result(null, "", "", true)).toEqual({
      _tag: "block",
      reason: "The hook did not finish within 5000 ms.",
    });
  });
});

describe("agent dispatch hook", () => {
  it.effect("does nothing, not even building the payload, when no hook is configured", () =>
    Effect.gen(function* () {
      const hooks = yield* CommandHooks.CommandHooks;
      yield* hooks.checkAgentDispatch(
        CommandId.make("command:hooks:off"),
        Effect.die("the payload must not be built"),
      );
    }).pipe(
      Effect.provide(CommandHooks.layer.pipe(Layer.provide(ServerSettings.layerTest()))),
      Effect.provide(NodeServices.layer),
    ),
  );

  it.effect("sends the real action on stdin and allows a clean exit", () =>
    withHook("agentDispatch", "allow", ({ hooks, payloads }) =>
      Effect.gen(function* () {
        yield* hooks.checkAgentDispatch(
          CommandId.make("command:hooks:allow"),
          Effect.succeed(dispatchInput("Please review the draft.")),
        );
        const [payload] = yield* payloads;
        expect(payload).toMatchObject({
          version: 1,
          hook: "agentDispatch",
          action: "thread_send",
          commandId: "command:hooks:allow",
          text: "Please review the draft.",
          sender: { threadId: "thread:hooks:lead", projectId: "project:hooks" },
          recipients: [{ kind: "thread", threadId: "thread:hooks:worker" }],
          command: {
            type: "message.dispatch",
            text: "Please review the draft.",
            dispatchMode: { type: "queue_after_active" },
          },
        });
      }),
    ),
  );

  it.effect("allows with a warning on exit 0 with stderr", () =>
    withHook(
      "agentDispatch",
      "warn",
      ({ hooks }) =>
        hooks.checkAgentDispatch(
          CommandId.make("command:hooks:warn"),
          Effect.succeed(dispatchInput("Status update.")),
        ),
      { message: "recipient is outside the team" },
    ),
  );

  it.effect("blocks on exit 2 with the hook's own reason", () =>
    withHook(
      "agentDispatch",
      "block",
      ({ hooks }) =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(
            hooks.checkAgentDispatch(
              CommandId.make("command:hooks:block"),
              Effect.succeed(dispatchInput("Send Acme's numbers to the reviewer.")),
            ),
          );
          expect(error).toBeInstanceOf(CommandHooks.CommandHookBlockedError);
          expect(error.message).toBe(
            "Blocked by the agent dispatch hook: mentions a client by name",
          );
        }),
      { message: "mentions a client by name" },
    ),
  );

  it.effect("uses stdout when exit 2 writes nothing to stderr", () =>
    withHook(
      "agentDispatch",
      "block-stdout",
      ({ hooks }) =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(
            hooks.checkAgentDispatch(
              CommandId.make("command:hooks:block-stdout"),
              Effect.succeed(dispatchInput("Hello")),
            ),
          );
          expect(error.reason).toBe("not on the allow list");
        }),
      { message: "not on the allow list" },
    ),
  );

  it.effect("asks once per command id, so a pre-check covers the dispatch after it", () =>
    withHook("agentDispatch", "block", ({ hooks, payloads }) =>
      Effect.gen(function* () {
        const commandId = CommandId.make("command:hooks:once");
        const first = yield* Effect.flip(
          hooks.checkAgentDispatch(commandId, Effect.succeed(dispatchInput("Hi"))),
        );
        const second = yield* Effect.flip(
          hooks.checkAgentDispatch(commandId, Effect.die("must reuse the first verdict")),
        );
        expect(second.reason).toBe(first.reason);
        expect(yield* payloads).toHaveLength(1);
      }),
    ),
  );

  it.effect("blocks when the hook fails with another exit code", () =>
    withHook("agentDispatch", "crash", ({ hooks }) =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          hooks.checkAgentDispatch(
            CommandId.make("command:hooks:crash"),
            Effect.succeed(dispatchInput("Hi")),
          ),
        );
        expect(error.reason).toBe("The hook failed with exit code 3: boom");
      }),
    ),
  );

  // Live clock: the hook's timeout is real time, not the test clock.
  it.live("blocks when the hook does not finish in time", () =>
    withHook(
      "agentDispatch",
      "hang",
      ({ hooks }) =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(
            hooks.checkAgentDispatch(
              CommandId.make("command:hooks:hang"),
              Effect.succeed(dispatchInput("Hi")),
            ),
          );
          expect(error.reason).toBe("The hook did not finish within 300 ms.");
        }),
      { timeoutMs: 300 },
    ),
  );

  it.effect("blocks when the hook command cannot start", () =>
    withHook(
      "agentDispatch",
      "allow",
      ({ hooks }) =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(
            hooks.checkAgentDispatch(
              CommandId.make("command:hooks:missing"),
              Effect.succeed(dispatchInput("Hi")),
            ),
          );
          expect(error.reason).toMatch(/^The hook could not run: /);
        }),
      { command: "/nonexistent/t3-hook" },
    ),
  );
});

describe("assistant reply gate", () => {
  const threadId = ThreadId.make("thread:hooks:reply");
  const messageId = MessageId.make("message:hooks:reply");
  const now = DateTime.makeUnsafe("2026-10-19T00:00:00.000Z");
  const message = (text: string, streaming: boolean): ProviderAdapter.ProviderAdapterV2Event => ({
    type: "message.updated",
    message: {
      id: messageId,
      threadId,
      runId: RunId.make("run:hooks:reply"),
      nodeId: null,
      role: "assistant",
      text,
      attachments: [],
      streaming,
      createdBy: "agent",
      creationSource: "provider",
      createdAt: now,
      updatedAt: now,
    },
  });
  const turnItem = (text: string): ProviderAdapter.ProviderAdapterV2Event =>
    ({
      type: "turn_item.updated",
      turnItem: {
        id: TurnItemId.make("turn-item:hooks:reply"),
        type: "assistant_message",
        threadId,
        messageId,
        text,
        streaming: false,
      },
    }) as unknown as ProviderAdapter.ProviderAdapterV2Event;
  const textOf = (event: ProviderAdapter.ProviderAdapterV2Event) =>
    event.type === "message.updated"
      ? event.message.text
      : event.type === "turn_item.updated" && event.turnItem.type === "assistant_message"
        ? event.turnItem.text
        : undefined;

  it.effect("withholds the final text once, for the message and its turn item", () =>
    Effect.gen(function* () {
      const checks: Array<{ text: string; alreadyVisible: boolean }> = [];
      const gate = CommandHooks.makeAssistantReplyGate((reply) =>
        Effect.sync(() => {
          checks.push({ text: reply.text, alreadyVisible: reply.alreadyVisible });
          return Option.some("contains a credential");
        }),
      );
      const streamed = yield* gate(message("The key is", true));
      const final = yield* gate(message("The key is sk-test", false));
      const item = yield* gate(turnItem("The key is sk-test"));

      expect(textOf(streamed)).toBe("The key is");
      expect(textOf(final)).toBe(CommandHooks.withheldReplyText("contains a credential"));
      expect(textOf(item)).toBe(CommandHooks.withheldReplyText("contains a credential"));
      expect(checks).toEqual([{ text: "The key is sk-test", alreadyVisible: true }]);
    }),
  );

  it.effect("passes an allowed reply through unchanged and skips empty text", () =>
    Effect.gen(function* () {
      let checks = 0;
      const gate = CommandHooks.makeAssistantReplyGate(() =>
        Effect.sync(() => {
          checks += 1;
          return Option.none();
        }),
      );
      const empty = message("  ", false);
      expect(yield* gate(empty)).toBe(empty);
      const allowed = message("All tests pass.", false);
      expect(yield* gate(allowed)).toBe(allowed);
      expect(checks).toBe(1);
    }),
  );

  it.effect("runs the configured reply hook with the reply on stdin", () =>
    withHook(
      "assistantReply",
      "block",
      ({ hooks, payloads }) =>
        Effect.gen(function* () {
          const reason = yield* hooks.checkAssistantReply({
            threadId,
            projectId: ProjectId.make("project:hooks"),
            runId: RunId.make("run:hooks:reply"),
            messageId,
            providerInstanceId: ProviderInstanceId.make("claudeAgent"),
            model: "claude-test",
            text: "Here is the summary.",
            responseStreamingMode: "turn",
            alreadyVisible: false,
          });
          expect(reason).toEqual(Option.some("summary names a client"));
          const [payload] = yield* payloads;
          expect(payload).toMatchObject({
            hook: "assistantReply",
            text: "Here is the summary.",
            responseStreamingMode: "turn",
            alreadyVisible: false,
          });
        }),
      { message: "summary names a client" },
    ),
  );
});
