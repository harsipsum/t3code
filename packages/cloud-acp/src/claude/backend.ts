import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as AcpError from "effect-acp/errors";
import type * as AcpSchema from "effect-acp/schema";
import { randomUuidV4 } from "@t3tools/provider-core/server/randomUuid";

import {
  LOCAL_SESSION_PREFIX,
  type BackendServices,
  type CloudBackend,
  type Emit,
  type PromptInput,
} from "../agent.ts";
import { readBranchDiff, readWorkspaceRepository, run } from "../process.ts";
import type { SessionStore } from "../state.ts";
import * as Api from "./api.ts";
import { makeClaudeTranscriptMapper, type TurnOutcome } from "./transcript.ts";

/** A long cloud session is summarized on sync; the full transcript stays on claude.ai. */
const MAX_SYNCED_EVENTS = 300;
/** After Stop, wait this long for the interrupted turn's own result. */
const INTERRUPT_GRACE = "30 seconds";

const text = (value: string): AcpSchema.ContentBlock => ({ type: "text", text: value });

const note = (emit: Emit, id: string, body: string) =>
  emit({ sessionUpdate: "agent_message_chunk", messageId: `note:${id}`, content: text(body) });

function topLevelUserUuid(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const event = payload as Record<string, unknown>;
  if (event.type !== "user" || event.parent_tool_use_id != null || event.isSynthetic === true) {
    return undefined;
  }
  const message = event.message as { content?: unknown } | undefined;
  const content = message?.content;
  const isToolResult =
    Array.isArray(content) &&
    content.some((part) => (part as { type?: unknown } | null)?.type === "tool_result");
  return isToolResult || typeof event.uuid !== "string" ? undefined : event.uuid;
}

export const makeClaudeCloudBackend = (store: SessionStore, version: string) =>
  Effect.gen(function* () {
    const services = yield* Effect.context<BackendServices>();
    const provide = <A, E>(effect: Effect.Effect<A, E, BackendServices>) =>
      Effect.provideContext(effect, services);

    const auth = provide(Api.readClaudeAuth);

    const remoteIdFor = (sessionId: string) =>
      sessionId.startsWith(LOCAL_SESSION_PREFIX)
        ? store.read(sessionId).pipe(Effect.map((record) => record.remoteId))
        : Effect.succeed(sessionId);

    const markDelivered = (sessionId: string, sequence: number) =>
      store.update(sessionId, { deliveredSequence: sequence });

    /** Shows events after T3's delivered cursor; returns a turn still waiting for its result. */
    const catchUp = (input: PromptInput, remoteId: string, token: Api.ClaudeAuth) =>
      Effect.gen(function* () {
        const record = yield* store.read(input.sessionId);
        const after = record.deliveredSequence ?? 0;
        const events = yield* provide(Api.readCloudEvents(token, remoteId, after));
        const mapper = makeClaudeTranscriptMapper({
          ownUserMessageUuids: new Set(),
          quoteForeignUserMessages: true,
          sessionUrl: Api.claudeSessionUrl(remoteId),
        });
        let openTurn: string | undefined;
        for (const event of events) {
          const uuid = topLevelUserUuid(event.payload);
          if (uuid !== undefined) openTurn = uuid;
          const { outcome } = mapper.durable(event.payload);
          if (
            outcome !== undefined &&
            openTurn !== undefined &&
            outcome.userMessageUuids.includes(openTurn)
          ) {
            openTurn = undefined;
          }
        }
        const shown = events.slice(-MAX_SYNCED_EVENTS);
        if (events.length > 0) {
          yield* note(
            input.emit,
            `sync:${after}`,
            `Synced from the [Claude Code cloud session](${Api.claudeSessionUrl(remoteId)})${
              events.length > shown.length
                ? `; ${events.length - shown.length} earlier events are only shown there`
                : ""
            }.\n\n`,
          );
        }
        const renderer = makeClaudeTranscriptMapper({
          ownUserMessageUuids: new Set(),
          quoteForeignUserMessages: true,
          sessionUrl: Api.claudeSessionUrl(remoteId),
        });
        for (const event of shown) {
          for (const update of renderer.durable(event.payload).updates) yield* input.emit(update);
        }
        const last = events.at(-1)?.sequence ?? after;
        if (last !== after) yield* markDelivered(input.sessionId, last);
        return { lastSequence: last, openTurn, shownCount: events.length };
      });

    const emitBranchDiff = (input: PromptInput, remoteId: string, token: Api.ClaudeAuth) =>
      Effect.gen(function* () {
        const detail = yield* provide(Api.getCloudSession(token, remoteId)).pipe(Effect.option);
        if (Option.isNone(detail) || detail.value.outcomeBranch === undefined) return;
        const diff = yield* provide(
          readBranchDiff(input.cwd, detail.value.outcomeBranch, detail.value.sourceRevision),
        );
        if (diff === undefined || diff.patch.trim() === "") return;
        yield* input.emit({
          sessionUpdate: "tool_call_update",
          toolCallId: `cloud-diff:${remoteId}:${yield* randomUuidV4}`,
          title: `Cloud branch ${detail.value.outcomeBranch}${diff.truncated ? " (truncated)" : ""}`,
          kind: "read",
          status: "completed",
          content: [
            {
              type: "diff",
              changes: [],
              patch: { format: "git_patch", text: diff.patch },
            },
          ],
        });
      });

    /**
     * Follows the live stream until `isDone` accepts a result. The stream
     * resumes from the last durable event after a dropped connection, so
     * nothing is shown twice or skipped.
     */
    const follow = (
      input: PromptInput,
      remoteId: string,
      token: Api.ClaudeAuth,
      fromSequence: number,
      isDone: (outcome: TurnOutcome) => boolean,
      ownUserMessageUuids: ReadonlySet<string>,
    ) =>
      Effect.gen(function* () {
        const mapper = makeClaudeTranscriptMapper({
          ownUserMessageUuids,
          quoteForeignUserMessages: true,
          sessionUrl: Api.claudeSessionUrl(remoteId),
        });
        let last = fromSequence;
        let finished: TurnOutcome | undefined;
        let failures = 0;
        while (true) {
          const attempt = yield* provide(
            Effect.gen(function* () {
              const stream = yield* Api.streamCloudEvents(token, remoteId, last);
              failures = 0;
              yield* stream.pipe(
                Stream.runForEachWhile((frame) =>
                  Effect.gen(function* () {
                    if (frame.kind === "ephemeral") {
                      for (const update of mapper.ephemeral(frame.payload))
                        yield* input.emit(update);
                      return true;
                    }
                    if (frame.event.sequence <= last) return true;
                    const { updates, outcome } = mapper.durable(frame.event.payload);
                    for (const update of updates) yield* input.emit(update);
                    last = frame.event.sequence;
                    if (outcome !== undefined && isDone(outcome)) {
                      finished = outcome;
                      yield* markDelivered(input.sessionId, last);
                      return false;
                    }
                    return true;
                  }),
                ),
              );
            }),
          ).pipe(Effect.result);
          if (finished !== undefined) return finished;
          yield* markDelivered(input.sessionId, last);
          if (attempt._tag === "Failure") {
            failures += 1;
            if (failures >= 5) return yield* attempt.failure;
          }
          yield* Effect.sleep(`${Math.min(15, 2 ** failures)} seconds`);
        }
      });

    /** Races the turn against Stop; Stop sends the provider's own interrupt. */
    const followWithCancel = (
      input: PromptInput,
      remoteId: string,
      token: Api.ClaudeAuth,
      fromSequence: number,
      isDone: (outcome: TurnOutcome) => boolean,
      ownUserMessageUuids: ReadonlySet<string>,
    ) =>
      Effect.gen(function* () {
        const followed = yield* Effect.forkScoped(
          follow(input, remoteId, token, fromSequence, isDone, ownUserMessageUuids),
        );
        const first = yield* Effect.raceFirst(
          Fiber.join(followed),
          Deferred.await(input.cancelled).pipe(Effect.as("cancelled" as const)),
        );
        if (first !== "cancelled") return first;
        yield* provide(Api.interruptSession(token, remoteId));
        const settled = yield* Fiber.join(followed).pipe(Effect.timeoutOption(INTERRUPT_GRACE));
        if (Option.isNone(settled)) {
          yield* note(
            input.emit,
            `stop:${remoteId}`,
            `\n\nStop was sent to the [cloud session](${Api.claudeSessionUrl(remoteId)}), which has not confirmed it yet.`,
          );
        }
        return "cancelled" as const;
      }).pipe(Effect.scoped);

    const finish = (
      input: PromptInput,
      remoteId: string,
      token: Api.ClaudeAuth,
      outcome: TurnOutcome | "cancelled",
    ) =>
      Effect.gen(function* () {
        if (outcome === "cancelled") return "cancelled" as const;
        if (outcome.isError) {
          yield* note(
            input.emit,
            `error:${remoteId}`,
            `\n\nThe cloud session ended this turn with an error${outcome.resultText ? `: ${outcome.resultText}` : "."}`,
          );
        }
        yield* emitBranchDiff(input, remoteId, token);
        return "end_turn" as const;
      });

    const resolveEnvironment = (token: Api.ClaudeAuth) =>
      Effect.gen(function* () {
        const configured = yield* provide(Api.readDefaultEnvironmentId);
        const environments = yield* provide(Api.listEnvironments(token));
        if (configured !== undefined) {
          const match = environments.find(
            (env) => env.id === configured || env.name === configured,
          );
          return match?.id ?? configured;
        }
        const hosted = environments.find(
          (env) => env.kind === undefined || env.kind === "anthropic_cloud",
        );
        if (hosted === undefined) {
          return yield* AcpError.AcpRequestError.invalidParams(
            "No Claude Code cloud environment is set up for this account. Create one at claude.ai/code, then try again.",
          );
        }
        return hosted.id;
      });

    const createRemote = (input: PromptInput, token: Api.ClaudeAuth) =>
      Effect.gen(function* () {
        const repository = yield* provide(readWorkspaceRepository(input.cwd));
        if (repository === undefined) {
          return yield* AcpError.AcpRequestError.invalidParams(
            "Claude Code cloud sessions clone a GitHub repository, and this project has no GitHub `origin` remote.",
          );
        }
        const environmentId = yield* resolveEnvironment(token);
        const firstLine = input.text.trim().split("\n")[0] ?? "T3 Code task";
        const remoteId = yield* provide(
          Api.createCloudSession(token, {
            title: firstLine.length > 80 ? `${firstLine.slice(0, 77)}...` : firstLine,
            environmentId,
            repository: repository.nameWithOwner,
            revision: repository.branch,
          }),
        );
        yield* store.update(input.sessionId, { remoteId, deliveredSequence: 0 });
        yield* note(
          input.emit,
          `created:${remoteId}`,
          `Started a [Claude Code cloud session](${Api.claudeSessionUrl(remoteId)}) on ${repository.nameWithOwner}${
            repository.branch ? ` at \`${repository.branch}\`` : ""
          }. Commits there need to be pushed before the cloud session can see them.\n\n`,
        );
        return remoteId;
      });

    const requireRemote = (sessionId: string) =>
      remoteIdFor(sessionId).pipe(
        Effect.filterOrFail(
          (remoteId): remoteId is string => remoteId !== undefined,
          () =>
            AcpError.AcpRequestError.invalidParams(
              "This thread has not started a cloud session yet. Send a task to start one.",
            ),
        ),
      );

    const backend: CloudBackend = {
      info: { name: "t3-cloud-claude", title: "Claude Code cloud", version },
      authMethods: [
        {
          type: "terminal",
          methodId: "claude-login",
          name: "Sign in to Claude",
          description:
            "Runs `claude auth login`. Cloud sessions need a claude.ai login with cloud sessions enabled.",
          args: ["login"],
        },
      ],
      ensureSignedIn: Effect.asVoid(auth),
      signOut: provide(run(process.env.T3_CLOUD_ACP_CLAUDE ?? "claude", ["auth", "logout"])).pipe(
        Effect.mapError(() =>
          AcpError.AcpRequestError.internalError("`claude auth logout` failed."),
        ),
        Effect.asVoid,
      ),
      listSessions: (request) =>
        Effect.gen(function* () {
          const token = yield* auth;
          const cwd = request.cwd ?? process.cwd();
          const repository = yield* provide(readWorkspaceRepository(cwd));
          const local = yield* store.localIdsByRemoteId;
          const sessions = yield* provide(Api.listCloudSessions(token));
          return {
            sessions: sessions
              .filter(
                (session) =>
                  session.status !== "archived" &&
                  (repository === undefined ||
                    session.repository?.toLowerCase() === repository.nameWithOwner.toLowerCase()),
              )
              .map((session) => ({
                sessionId: local.get(session.id) ?? session.id,
                cwd,
                title: session.title,
                ...(session.updatedAt === undefined ? {} : { updatedAt: session.updatedAt }),
                _meta: { url: Api.claudeSessionUrl(session.id), status: session.status },
              })),
          };
        }),
      checkSession: (sessionId) =>
        Effect.gen(function* () {
          const remoteId = yield* requireRemote(sessionId);
          const detail = yield* provide(Api.getCloudSession(yield* auth, remoteId));
          if (detail.status === "archived") {
            return yield* AcpError.AcpRequestError.invalidParams(
              "This Claude cloud session is archived and cannot take messages.",
            );
          }
        }),
      sync: (input) =>
        Effect.gen(function* () {
          const token = yield* auth;
          const remoteId = yield* requireRemote(input.sessionId);
          const caught = yield* catchUp(input, remoteId, token);
          const detail = yield* provide(Api.getCloudSession(token, remoteId));
          if (caught.openTurn === undefined && !Api.isBusyStatus(detail.status)) {
            if (caught.shownCount === 0) {
              // A waiting session needs an answer only claude.ai can give.
              yield* note(
                input.emit,
                `idle:${caught.lastSequence}`,
                `The [cloud session](${Api.claudeSessionUrl(remoteId)}) is ${detail.status}; nothing new since T3 last showed it.`,
              );
            }
            return "end_turn";
          }
          const openTurn = caught.openTurn;
          const outcome = yield* followWithCancel(
            input,
            remoteId,
            token,
            caught.lastSequence,
            (result) => openTurn === undefined || result.userMessageUuids.includes(openTurn),
            new Set(),
          );
          return yield* finish(input, remoteId, token, outcome);
        }),
      prompt: (input) =>
        Effect.gen(function* () {
          const token = yield* auth;
          const existing = yield* remoteIdFor(input.sessionId);
          const remoteId = existing ?? (yield* createRemote(input, token));
          const caught = yield* catchUp(input, remoteId, token);
          const uuid = yield* randomUuidV4;
          yield* provide(Api.sendUserMessage(token, remoteId, { uuid, text: input.text }));
          const outcome = yield* followWithCancel(
            input,
            remoteId,
            token,
            caught.lastSequence,
            (result) => result.userMessageUuids.includes(uuid),
            new Set([uuid]),
          );
          return yield* finish(input, remoteId, token, outcome);
        }),
    };
    return backend;
  });
