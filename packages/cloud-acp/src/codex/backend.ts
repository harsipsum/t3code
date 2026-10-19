import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as AcpError from "effect-acp/errors";
import type * as AcpSchema from "effect-acp/schema";
import { randomUuidV4 } from "@t3tools/provider-core/server/randomUuid";

import {
  LOCAL_SESSION_PREFIX,
  type BackendServices,
  type CloudBackend,
  type PromptInput,
} from "../agent.ts";
import { capPatch, readWorkspaceRepository, run } from "../process.ts";
import type { SessionStore } from "../state.ts";
import * as Cli from "./cli.ts";

const POLL_INTERVAL = "10 seconds";
/** A watch that may have run for an hour survives a few failed status reads. */
const MAX_POLL_FAILURES = 3;

const text = (value: string): AcpSchema.ContentBlock => ({ type: "text", text: value });

export const makeCodexCloudBackend = (store: SessionStore, version: string) =>
  Effect.gen(function* () {
    const services = yield* Effect.context<BackendServices>();
    const provide = <A, E>(effect: Effect.Effect<A, E, BackendServices>) =>
      Effect.provideContext(effect, services);
    const codex = process.env.T3_CLOUD_ACP_CODEX ?? "codex";

    const codexRun = (args: ReadonlyArray<string>, cwd?: string) =>
      provide(run(codex, args, cwd === undefined ? {} : { cwd })).pipe(
        Effect.mapError(() =>
          AcpError.AcpRequestError.internalError(
            `Could not run \`${codex}\`. Install the Codex CLI (npm i -g @openai/codex) or set T3_CLOUD_ACP_CODEX.`,
          ),
        ),
      );

    const failed = (what: string, result: { stdout: string; stderr: string; code: number }) => {
      const output = (result.stderr.trim() || result.stdout.trim()).slice(0, 600);
      return /not logged in|log ?in|unauthori[sz]ed|401/i.test(output)
        ? AcpError.AcpRequestError.authRequired(
            `Codex is not signed in to ChatGPT for Codex Cloud. Sign in, then try again. (${output})`,
          )
        : AcpError.AcpRequestError.internalError(
            `${what} failed (exit ${result.code})${output ? `: ${output}` : ""}`,
          );
    };

    const ensureSignedIn = Effect.gen(function* () {
      const status = yield* codexRun(["login", "status"]);
      if (status.code !== 0 || /not logged in/i.test(status.stdout + status.stderr)) {
        return yield* AcpError.AcpRequestError.authRequired(
          "Codex is not signed in. Codex Cloud needs a ChatGPT sign-in (an API key cannot reach it).",
        );
      }
    });

    const listTasks = (cursor: string | undefined) =>
      Effect.gen(function* () {
        const result = yield* codexRun([
          "cloud",
          "list",
          "--json",
          "--limit",
          "20",
          ...(cursor === undefined ? [] : ["--cursor", cursor]),
        ]);
        if (result.code !== 0) return yield* failed("`codex cloud list`", result);
        return Cli.parseCodexTaskList(result.stdout);
      });

    const findTask = (taskId: string) =>
      Effect.gen(function* () {
        let cursor: string | undefined;
        for (let page = 0; page < 5; page++) {
          const listed = yield* listTasks(cursor);
          const task = listed.tasks.find((candidate) => candidate.id === taskId);
          if (task !== undefined) return Option.some(task);
          if (listed.cursor === undefined) break;
          cursor = listed.cursor;
        }
        return Option.none<Cli.CodexTask>();
      });

    const readStatus = (taskId: string) =>
      Effect.gen(function* () {
        const listed = yield* findTask(taskId);
        if (Option.isSome(listed)) return { status: listed.value.status, task: listed.value };
        const result = yield* codexRun(["cloud", "status", taskId]);
        if (result.code !== 0) return yield* failed("`codex cloud status`", result);
        return {
          status: Cli.parseCodexStatusText(result.stdout) ?? "unknown",
          task: undefined,
        };
      });

    const remoteIdFor = (sessionId: string) =>
      sessionId.startsWith(LOCAL_SESSION_PREFIX)
        ? store.read(sessionId).pipe(Effect.map((record) => record.remoteId))
        : Effect.succeed(sessionId);

    const statusRow = (taskId: string, status: string, detail?: string) =>
      ({
        sessionUpdate: "tool_call_update",
        toolCallId: `codex-cloud:${taskId}`,
        title: `Codex Cloud task: ${status}`,
        kind: "other",
        status: Cli.isTerminalCodexStatus(status)
          ? Cli.isFailedCodexStatus(status)
            ? "failed"
            : "completed"
          : "in_progress",
        content: [
          {
            type: "content",
            content: text(`${detail ? `${detail}\n` : ""}${Cli.codexTaskUrl(taskId)}`),
          },
        ],
      }) satisfies AcpSchema.SessionUpdate;

    /** Shows a finished task's diff and summary once, then records it as delivered. */
    const deliverResult = (
      input: PromptInput,
      taskId: string,
      status: string,
      task?: Cli.CodexTask,
    ) =>
      Effect.gen(function* () {
        const diff = yield* codexRun(["cloud", "diff", taskId], input.cwd);
        const { text: patch, truncated } = capPatch(diff.code === 0 ? diff.stdout : "");
        if (patch.trim() !== "") {
          yield* input.emit({
            sessionUpdate: "tool_call_update",
            toolCallId: `codex-cloud-diff:${taskId}`,
            title: `Codex Cloud diff${truncated ? " (truncated)" : ""}`,
            kind: "read",
            status: "completed",
            content: [{ type: "diff", changes: [], patch: { format: "git_patch", text: patch } }],
          });
        }
        yield* input.emit({
          sessionUpdate: "agent_message_chunk",
          messageId: `codex-result:${taskId}`,
          content: text(
            `Codex Cloud task ${Cli.isFailedCodexStatus(status) ? "ended" : "finished"}: **${status}**${
              task?.summary ? ` (${task.summary})` : ""
            }. Review, apply or open a PR from [the task](${Cli.codexTaskUrl(taskId)}); \`codex cloud apply ${taskId}\` applies it to this checkout.`,
          ),
        });
        yield* store.update(input.sessionId, { resultDelivered: true });
      });

    /** Polls until the task settles. Stop ends T3's wait only: Codex Cloud keeps running. */
    const watch = (input: PromptInput, taskId: string) =>
      Effect.gen(function* () {
        let last = "";
        let failures = 0;
        while (true) {
          const read = yield* Effect.result(readStatus(taskId));
          if (read._tag === "Failure") {
            if (read.failure.code === -32000 || ++failures >= MAX_POLL_FAILURES) {
              return yield* read.failure;
            }
          }
          const { status, task } =
            read._tag === "Success" ? read.success : { status: last, task: undefined };
          if (read._tag === "Success") failures = 0;
          if (read._tag === "Success" && status !== last) {
            yield* input.emit(statusRow(taskId, status, task?.title));
            last = status;
          }
          if (read._tag === "Success" && Cli.isTerminalCodexStatus(status)) {
            yield* deliverResult(input, taskId, status, task);
            return "end_turn" as const;
          }
          const stopped = yield* Deferred.await(input.cancelled).pipe(
            Effect.timeoutOption(POLL_INTERVAL),
          );
          if (Option.isSome(stopped)) {
            yield* input.emit({
              sessionUpdate: "agent_message_chunk",
              messageId: `codex-stop:${taskId}`,
              content: text(
                `Stopped watching. Codex Cloud has no cancel command in the CLI, so [the task](${Cli.codexTaskUrl(taskId)}) keeps running; send \`/sync\` to check on it later.`,
              ),
            });
            return "cancelled" as const;
          }
        }
      });

    const backend: CloudBackend = {
      info: { name: "t3-cloud-codex", title: "Codex Cloud", version },
      authMethods: [
        {
          type: "terminal",
          methodId: "codex-device-login",
          name: "Sign in with ChatGPT",
          description: "Runs `codex login --device-auth`; approve the code in your browser.",
          args: ["login"],
        },
      ],
      ensureSignedIn,
      signOut: codexRun(["logout"]).pipe(Effect.asVoid),
      listSessions: (request) =>
        Effect.gen(function* () {
          const listed = yield* listTasks(request.cursor ?? undefined);
          const local = yield* store.localIdsByRemoteId;
          const cwd = request.cwd ?? process.cwd();
          return {
            sessions: listed.tasks.map((task) => ({
              sessionId: local.get(task.id) ?? task.id,
              cwd,
              title: task.environment ? `${task.title} · ${task.environment}` : task.title,
              ...(task.updatedAt === undefined ? {} : { updatedAt: task.updatedAt }),
              _meta: { url: task.url, status: task.status },
            })),
            ...(listed.cursor === undefined ? {} : { nextCursor: listed.cursor }),
          };
        }),
      checkSession: (sessionId) =>
        Effect.gen(function* () {
          const taskId = yield* remoteIdFor(sessionId);
          if (taskId === undefined) return;
          yield* readStatus(taskId);
        }),
      sync: (input) =>
        Effect.gen(function* () {
          const taskId = yield* remoteIdFor(input.sessionId);
          if (taskId === undefined) {
            return yield* AcpError.AcpRequestError.invalidParams(
              "This thread has not started a Codex Cloud task yet. Send a task to start one.",
            );
          }
          const { status } = yield* readStatus(taskId);
          const record = yield* store.read(input.sessionId);
          if (Cli.isTerminalCodexStatus(status) && record.resultDelivered === true) {
            yield* input.emit(statusRow(taskId, status, "Already shown in this thread."));
            return "end_turn" as const;
          }
          return yield* watch(input, taskId);
        }),
      prompt: (input) =>
        Effect.gen(function* () {
          const existing = yield* remoteIdFor(input.sessionId);
          if (existing !== undefined) {
            return yield* AcpError.AcpRequestError.invalidRequest(
              `Codex Cloud tasks cannot take follow-ups from T3: the Codex CLI has no command for it. Continue in [the task](${Cli.codexTaskUrl(existing)}), or start a new T3 thread for new work. Send \`/sync\` for its latest status.`,
            );
          }
          const environment = process.env.CODEX_CLOUD_ENV?.trim();
          if (!environment) {
            return yield* AcpError.AcpRequestError.invalidParams(
              "Set CODEX_CLOUD_ENV in this provider's environment to a Codex Cloud environment id or label; `codex cloud` in a terminal lists the environments the CLI can use.",
            );
          }
          const repository = yield* provide(readWorkspaceRepository(input.cwd));
          const submitted = yield* codexRun(
            [
              "cloud",
              "exec",
              "--env",
              environment,
              ...(repository?.branch === undefined ? [] : ["--branch", repository.branch]),
              "--",
              input.text,
            ],
            input.cwd,
          );
          if (submitted.code !== 0) return yield* failed("`codex cloud exec`", submitted);
          const taskId = Cli.parseSubmittedTaskId(submitted.stdout + submitted.stderr);
          if (taskId === undefined) {
            return yield* AcpError.AcpRequestError.internalError(
              `Codex Cloud accepted the task but printed no task id this agent recognizes: ${submitted.stdout.trim().slice(0, 300)}`,
            );
          }
          yield* store.update(input.sessionId, { remoteId: taskId });
          yield* input.emit({
            sessionUpdate: "agent_message_chunk",
            messageId: `codex-submitted:${yield* randomUuidV4}`,
            content: text(
              `Submitted to [Codex Cloud](${Cli.codexTaskUrl(taskId)}) in environment \`${environment}\`. T3 checks its status every 10 seconds; closing T3 does not stop the task.\n\n`,
            ),
          });
          return yield* watch(input, taskId);
        }),
    };
    return backend;
  });
