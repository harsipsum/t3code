import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as EffectAcpAgent from "effect-acp/agent";
import * as AcpError from "effect-acp/errors";
import type * as AcpSchema from "effect-acp/schema";
import { randomUuidV4 } from "@t3tools/provider-core/server/randomUuid";

import type * as FileSystem from "effect/FileSystem";
import type { HttpClient } from "effect/http";
import type * as Path from "effect/Path";
import type { ChildProcessSpawner } from "effect/process";

import type { SessionStore } from "./state.ts";

export type BackendServices =
  | FileSystem.FileSystem
  | Path.Path
  | ChildProcessSpawner.ChildProcessSpawner
  | HttpClient.HttpClient;

export type Emit = (update: AcpSchema.SessionUpdate) => Effect.Effect<void>;

export interface PromptInput {
  readonly sessionId: string;
  readonly cwd: string;
  readonly text: string;
  readonly emit: Emit;
  /** Resolves when T3 sends `session/cancel` for this prompt. */
  readonly cancelled: Deferred.Deferred<void>;
}

/** One provider's cloud surface. Every method reports only what the provider really did. */
export interface CloudBackend {
  readonly info: { readonly name: string; readonly title: string; readonly version: string };
  readonly authMethods: ReadonlyArray<AcpSchema.AuthMethod>;
  readonly ensureSignedIn: Effect.Effect<void, AcpError.AcpError>;
  readonly signOut: Effect.Effect<void, AcpError.AcpError>;
  readonly listSessions: (
    request: AcpSchema.ListSessionsRequest,
  ) => Effect.Effect<AcpSchema.ListSessionsResponse, AcpError.AcpError>;
  /** Fails when the session no longer exists on the provider. */
  readonly checkSession: (sessionId: string) => Effect.Effect<void, AcpError.AcpError>;
  /** Shows provider activity T3 has not seen and follows a turn still running remotely. */
  readonly sync: (input: PromptInput) => Effect.Effect<AcpSchema.StopReason, AcpError.AcpError>;
  readonly prompt: (input: PromptInput) => Effect.Effect<AcpSchema.StopReason, AcpError.AcpError>;
}

export const LOCAL_SESSION_PREFIX = "t3-cloud-";

const USER_REQUEST = /<user_request>\n?([\s\S]*?)\n?<\/user_request>/;

/**
 * The user's words from a T3 ACP prompt. T3 wraps them with its own
 * instructions and appends a runtime block; both describe T3's local harness
 * and MCP tools, which a cloud session does not have, so they stay here.
 */
export function cloudPromptText(prompt: ReadonlyArray<AcpSchema.ContentBlock>): string {
  return prompt
    .flatMap((block) => {
      switch (block.type) {
        case "text": {
          const value = typeof block.text === "string" ? block.text : "";
          if (value.startsWith("<runtime_info>")) return [];
          return [USER_REQUEST.exec(value)?.[1] ?? value];
        }
        case "resource_link":
          return [`[${block.name}](${block.uri})`];
        default:
          return [`[${block.type} attachment not sent: cloud sessions only take text from T3]`];
      }
    })
    .join("\n");
}

/**
 * Prompts that ask for the cloud state instead of new cloud work. After its own
 * restart T3 sends one of the forms in
 * apps/server/src/orchestration-v2/RestartContinuation.ts; forwarding it would
 * start a cloud turn nobody asked for, while the cloud session never stopped.
 */
export function isSyncPrompt(text: string): boolean {
  const trimmed = text.trim();
  return (
    trimmed === "/sync" ||
    trimmed === "Continue where you left off." ||
    trimmed.startsWith("Note: the T3 server restarted, and this background work was cancelled")
  );
}

export const runCloudAgent = (backend: CloudBackend, store: SessionStore) =>
  Effect.gen(function* () {
    const agent = yield* EffectAcpAgent.AcpAgent;
    const cancellations = new Map<string, Deferred.Deferred<void>>();
    // `session/prompt` carries no cwd; the creating or resuming request does.
    const cwds = new Map<string, string>();

    yield* agent.handleInitialize(() =>
      Effect.succeed({
        protocolVersion: 2,
        info: backend.info,
        // Baseline session support: new, prompt, cancel, list and resume. No
        // fork, delete, providers or MCP: the cloud session cannot reach T3's
        // local MCP server, and the provider owns its own history.
        capabilities: { session: {} },
        authMethods: [...backend.authMethods],
      }),
    );

    yield* agent.handleAuthenticate(() => backend.ensureSignedIn.pipe(Effect.as({})));
    yield* agent.handleLogout(() => backend.signOut.pipe(Effect.as({})));

    yield* agent.handleCreateSession((request) =>
      Effect.gen(function* () {
        yield* backend.ensureSignedIn;
        const sessionId = `${LOCAL_SESSION_PREFIX}${yield* randomUuidV4}`;
        cwds.set(sessionId, request.cwd);
        return { sessionId };
      }),
    );

    yield* agent.handleListSessions((request) =>
      backend.ensureSignedIn.pipe(Effect.andThen(backend.listSessions(request))),
    );

    // History is not replayed here: T3 keeps load replay out of the thread, and
    // the first prompt or `/sync` shows what T3 has not seen yet instead.
    yield* agent.handleLoadSession((request) =>
      Effect.gen(function* () {
        yield* backend.ensureSignedIn;
        cwds.set(request.sessionId, request.cwd);
        if (!request.sessionId.startsWith(LOCAL_SESSION_PREFIX)) {
          yield* backend.checkSession(request.sessionId);
          return {};
        }
        const record = yield* store.read(request.sessionId);
        if (record.remoteId !== undefined) yield* backend.checkSession(request.sessionId);
        return {};
      }),
    );

    yield* agent.handleCloseSession(() => Effect.succeed({}));

    yield* agent.handlePrompt((request) => {
      const cancelled = Deferred.makeUnsafe<void>();
      return Effect.gen(function* () {
        cancellations.set(request.sessionId, cancelled);
        const text = cloudPromptText(request.prompt);
        const input: PromptInput = {
          sessionId: request.sessionId,
          cwd: cwds.get(request.sessionId) ?? process.cwd(),
          text,
          cancelled,
          emit: (update) =>
            agent.client
              .sessionUpdate({ sessionId: request.sessionId, update })
              .pipe(Effect.ignore),
        };
        const stopReason = yield* isSyncPrompt(text) ? backend.sync(input) : backend.prompt(input);
        yield* input.emit({ sessionUpdate: "state_update", state: "idle", stopReason });
        return {};
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            // A newer prompt may already own this session's entry.
            if (cancellations.get(request.sessionId) === cancelled) {
              cancellations.delete(request.sessionId);
            }
          }),
        ),
      );
    });

    yield* agent.handleCancel((notification) =>
      Effect.suspend(() => {
        const cancelled = cancellations.get(notification.sessionId);
        return cancelled === undefined ? Effect.void : Deferred.succeed(cancelled, undefined);
      }).pipe(Effect.asVoid),
    );

    return yield* Effect.never;
  });
