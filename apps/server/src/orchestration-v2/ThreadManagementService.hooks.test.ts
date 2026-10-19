import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  NodeId,
  type OrchestrationV2ThreadProjection,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as CommandHooks from "../hooks/CommandHooks.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

// Blocks any action whose text mentions "Acme"; records every payload.
const HOOK_SCRIPT = `
const fs = require("node:fs");
const input = fs.readFileSync(0, "utf8");
fs.appendFileSync(process.argv[2], input + "\\n");
if (JSON.parse(input).text.includes("Acme")) {
  process.stderr.write("names a client");
  process.exit(2);
}
`;

const projectId = ProjectId.make("project:hooks");
const leadId = ThreadId.make("thread:hooks:lead");
const workerId = ThreadId.make("thread:hooks:worker");
const instanceId = ProviderInstanceId.make("codex");
const runId = RunId.make("run:hooks:worker");

const projection = (threadId: ThreadId) =>
  ({
    thread: {
      id: threadId,
      projectId,
      title: threadId === leadId ? "Lead" : "Worker",
      deletedAt: null,
      archivedAt: null,
      modelSelection: { instanceId, model: "gpt-5-codex" },
    },
    // A running turn, so steer and restart have a target.
    runs: [{ id: runId, status: "running", activeAttemptId: "attempt:hooks", ordinal: 1 }],
    providerTurns: [{ runAttemptId: "attempt:hooks", status: "running" }],
    messages: [],
    turnItems: [],
  }) as unknown as OrchestrationV2ThreadProjection;

const withThreads = <A, E>(
  run: (context: {
    readonly threads: ThreadManagementService.ThreadManagementServiceShape;
    readonly dispatched: ReadonlyArray<string>;
    readonly payloads: Effect.Effect<ReadonlyArray<Record<string, unknown>>>;
  }) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-dispatch-hooks-" });
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
    const dispatched: Array<string> = [];
    const settings = ServerSettings.layerTest({
      hooks: { agentDispatch: { command: process.execPath, args: [script, log] } },
    });
    const layer = ThreadManagementService.layer.pipe(
      Layer.provide(CommandHooks.layer.pipe(Layer.provide(settings))),
      Layer.provide(Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({})),
      Layer.provide(
        Layer.mock(Orchestrator.OrchestratorV2)({
          getThreadRecords: (threadId) => Effect.succeed(projection(threadId)),
          dispatch: (command) =>
            Effect.sync(() => {
              dispatched.push(command.type);
              return { sequence: 1, storedEvents: [] } as never;
            }),
        }),
      ),
      Layer.provide(settings),
      Layer.provide(CommandReceiptStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory))),
    );
    return yield* Effect.gen(function* () {
      const threads = yield* ThreadManagementService.ThreadManagementService;
      return yield* run({ threads, dispatched, payloads });
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

const send = (mode: ThreadManagementService.ThreadManagementSendMode, text: string) => ({
  projectId,
  commandId: CommandId.make(`command:hooks:send:${mode}`),
  threadId: workerId,
  messageId: MessageId.make(`message:hooks:send:${mode}`),
  senderThreadId: leadId,
  text,
  attachments: [],
  mode,
  createdBy: "agent" as const,
  creationSource: "mcp" as const,
});

describe("agent dispatch hook at the thread management chokepoint", () => {
  it.effect("blocks a thread send in every delivery mode before anything is written", () =>
    withThreads(({ threads, dispatched, payloads }) =>
      Effect.gen(function* () {
        for (const mode of ["auto", "queue", "steer", "restart"] as const) {
          const error = yield* Effect.flip(threads.sendToThread(send(mode, "Acme's Q3 numbers")));
          expect(error).toBeInstanceOf(CommandHooks.CommandHookBlockedError);
          expect(error.message).toBe("Blocked by the agent dispatch hook: names a client");
        }
        expect(dispatched).toEqual([]);
        const seen = yield* payloads;
        expect(
          seen.map(
            (payload) => (payload.command as { dispatchMode: { type: string } }).dispatchMode.type,
          ),
        ).toEqual(["steer_active", "queue_after_active", "steer_active", "restart_active"]);
        expect(seen[0]).toMatchObject({
          action: "thread_send",
          sender: { threadId: leadId, title: "Lead", projectId },
          recipients: [{ kind: "thread", threadId: workerId, title: "Worker", projectId }],
        });
      }),
    ),
  );

  it.effect("lets an allowed send through to the orchestrator", () =>
    withThreads(({ threads, dispatched }) =>
      Effect.gen(function* () {
        // The mock projection has no message, so the send fails after dispatching.
        yield* Effect.exit(threads.sendToThread(send("queue", "Tests pass on main.")));
        expect(dispatched).toEqual(["message.dispatch"]);
      }),
    ),
  );

  it.effect("blocks a delegated task before its child thread exists", () =>
    withThreads(({ threads, dispatched, payloads }) =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          threads.dispatch({
            type: "delegated_task.request",
            createdBy: "agent",
            creationSource: "mcp",
            commandId: CommandId.make("command:hooks:delegate"),
            parentThreadId: leadId,
            parentRunId: runId,
            parentNodeId: NodeId.make("node:hooks:lead"),
            task: "Email Acme the draft",
            modelSelection: { instanceId, model: "gpt-5-codex" },
            runtimeMode: "full-access",
            interactionMode: "default",
          }),
        );
        expect(error).toBeInstanceOf(CommandHooks.CommandHookBlockedError);
        expect(dispatched).toEqual([]);
        expect((yield* payloads)[0]).toMatchObject({
          action: "delegate_task",
          text: "Email Acme the draft",
          sender: { threadId: leadId },
          recipients: [
            { kind: "delegated_task", parentThreadId: leadId, providerInstanceId: instanceId },
          ],
        });
      }),
    ),
  );

  it.effect("checks a new thread's first message before the thread exists, once", () =>
    withThreads(({ threads, dispatched, payloads }) =>
      Effect.gen(function* () {
        const firstMessage = {
          type: "message.dispatch",
          createdBy: "agent",
          creationSource: "mcp",
          commandId: CommandId.make("command:hooks:create:message"),
          threadId: ThreadId.make("thread:hooks:new"),
          senderThreadId: leadId,
          messageId: MessageId.make("message:hooks:create"),
          text: "Start the migration.",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
        } satisfies ThreadManagementService.AgentDispatchHookCommand;
        yield* threads.checkAgentDispatch({
          command: firstMessage,
          newThread: {
            projectId,
            title: "Migration",
            modelSelection: { instanceId, model: "gpt-5-codex" },
          },
        });
        yield* threads.dispatch(firstMessage);
        expect(dispatched).toEqual(["message.dispatch"]);
        const seen = yield* payloads;
        expect(seen).toHaveLength(1);
        expect(seen[0]).toMatchObject({
          action: "thread_create",
          recipients: [{ kind: "new_thread", threadId: "thread:hooks:new", title: "Migration" }],
        });

        const blocked = {
          ...firstMessage,
          commandId: CommandId.make("command:hooks:create:blocked"),
          text: "Ask Acme",
        };
        yield* Effect.flip(
          threads.checkAgentDispatch({
            command: blocked,
            newThread: {
              projectId,
              title: "Blocked",
              modelSelection: { instanceId, model: "gpt-5-codex" },
            },
          }),
        );
        expect(dispatched).toEqual(["message.dispatch"]);
      }),
    ),
  );

  it.effect("leaves T3 Code's own continuations and user sends to the user", () =>
    withThreads(({ threads, dispatched, payloads }) =>
      Effect.gen(function* () {
        const exits = yield* Effect.all([
          Effect.exit(
            threads.dispatch({
              type: "message.dispatch",
              commandId: CommandId.make("command:hooks:continuation"),
              threadId: workerId,
              messageId: MessageId.make("message:hooks:continuation"),
              text: "Acme background task completed.",
              attachments: [],
              dispatchMode: { type: "queue_after_active" },
              createdBy: "agent",
              creationSource: "server",
            }),
          ),
          Effect.exit(
            threads.sendToThread({
              ...send("queue", "Acme"),
              createdBy: "user",
              creationSource: "web",
            }),
          ),
        ]);
        expect(Exit.isSuccess(exits[0])).toBe(true);
        expect(dispatched).toEqual(["message.dispatch", "message.dispatch"]);
        expect(yield* payloads).toEqual([]);
      }),
    ),
  );
});
