import { randomUuidV4 } from "@t3tools/provider-core/server/randomUuid";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest, type HttpClientResponse } from "effect/http";
import * as AcpError from "effect-acp/errors";

import { run } from "../process.ts";
import { makeSseDecoder, type SseFrame } from "../sse.ts";

/**
 * Claude Code cloud sessions over the API that `claude --teleport`,
 * `claude -p --cloud <id>` and claude.ai use. The access token is read fresh
 * from Claude Code's own credential store for every request and never stored,
 * as Anthropic's CI guidance for these endpoints recommends; Claude Code keeps
 * refreshing it. Sessions need the `user:sessions:claude_code` scope, which
 * `claude setup-token` tokens lack.
 */
const API_BASE = "https://api.anthropic.com";
const LEGACY_SESSIONS_BETA = "ccr-byoc-2025-07-29";
const SESSIONS_SCOPE = "user:sessions:claude_code";
const KEYCHAIN_SERVICE = "Claude Code-credentials";

export const claudeSessionUrl = (sessionId: string) => `https://claude.ai/code/${sessionId}`;

const Credentials = Schema.Struct({
  claudeAiOauth: Schema.optional(
    Schema.Struct({
      accessToken: Schema.optional(Schema.String),
      expiresAt: Schema.optional(Schema.Number),
      scopes: Schema.optional(Schema.Array(Schema.String)),
    }),
  ),
});
const decodeCredentials = Schema.decodeUnknownOption(Schema.fromJsonString(Credentials));
const AccountConfig = Schema.Struct({
  oauthAccount: Schema.optional(
    Schema.Struct({ organizationUuid: Schema.optional(Schema.String) }),
  ),
});
const decodeAccountConfig = Schema.decodeUnknownOption(Schema.fromJsonString(AccountConfig));
const Settings = Schema.Struct({
  remote: Schema.optional(Schema.Struct({ defaultEnvironmentId: Schema.optional(Schema.String) })),
});
const decodeSettings = Schema.decodeUnknownOption(Schema.fromJsonString(Settings));

const signedOutError = () =>
  AcpError.AcpRequestError.authRequired(
    "Claude Code is not signed in to a claude.ai account with cloud sessions. Sign in, then try again.",
  );

export interface ClaudeAuth {
  readonly accessToken: string;
}

/** Claude Code's own config directory, honoring CLAUDE_CONFIG_DIR like the CLI. */
const configDirectory = Effect.gen(function* () {
  const env = yield* HostProcess.Environment;
  return env.CLAUDE_CONFIG_DIR ?? `${yield* HostProcess.HomeDirectory}/.claude`;
});

const readFileOrNone = (file: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.readFileString(file).pipe(Effect.option);
  });

const readCredentialsText = Effect.gen(function* () {
  const path = yield* Path.Path;
  const fromFile = yield* readFileOrNone(path.join(yield* configDirectory, ".credentials.json"));
  if (Option.isSome(fromFile) || (yield* HostProcess.Platform) !== "darwin") return fromFile;
  // macOS keeps the default login in the keychain; reading it may show the
  // keychain's own approval prompt once.
  const keychain = yield* run("security", [
    "find-generic-password",
    "-s",
    KEYCHAIN_SERVICE,
    "-w",
  ]).pipe(Effect.orElseSucceed(() => ({ code: 1, stdout: "", stderr: "" })));
  return keychain.code === 0 ? Option.some(keychain.stdout.trim()) : Option.none<string>();
});

export const readClaudeAuth = Effect.gen(function* () {
  const text = yield* readCredentialsText;
  const oauth = Option.flatMap(text, decodeCredentials).pipe(
    Option.flatMap((credentials) => Option.fromNullishOr(credentials.claudeAiOauth)),
  );
  if (Option.isNone(oauth) || !oauth.value.accessToken) return yield* signedOutError();
  if (oauth.value.scopes !== undefined && !oauth.value.scopes.includes(SESSIONS_SCOPE)) {
    return yield* AcpError.AcpRequestError.authRequired(
      `This Claude login cannot reach cloud sessions (missing the ${SESSIONS_SCOPE} scope). Sign in again with \`claude auth login\`; tokens from \`claude setup-token\` are inference-only.`,
    );
  }
  if (
    oauth.value.expiresAt !== undefined &&
    oauth.value.expiresAt <= (yield* Clock.currentTimeMillis)
  ) {
    return yield* AcpError.AcpRequestError.authRequired(
      "Claude Code's login has expired. Run any Claude Code command (or sign in again) so it refreshes, then try again.",
    );
  }
  return { accessToken: oauth.value.accessToken } satisfies ClaudeAuth;
});

const readOrganizationUuid = Effect.gen(function* () {
  const path = yield* Path.Path;
  const env = yield* HostProcess.Environment;
  const file = env.CLAUDE_CONFIG_DIR
    ? path.join(env.CLAUDE_CONFIG_DIR, ".claude.json")
    : path.join(yield* HostProcess.HomeDirectory, ".claude.json");
  const config = Option.flatMap(yield* readFileOrNone(file), decodeAccountConfig);
  return Option.getOrUndefined(
    Option.flatMap(config, (value) =>
      Option.fromNullishOr(value.oauthAccount?.organizationUuid?.trim() || undefined),
    ),
  );
});

/** Claude Code's own `remote.defaultEnvironmentId` setting, as `claude --cloud` uses it. */
export const readDefaultEnvironmentId = Effect.gen(function* () {
  const env = yield* HostProcess.Environment;
  if (env.CLAUDE_CLOUD_ENVIRONMENT) return env.CLAUDE_CLOUD_ENVIRONMENT;
  const path = yield* Path.Path;
  const settings = Option.flatMap(
    yield* readFileOrNone(path.join(yield* configDirectory, "settings.json")),
    decodeSettings,
  );
  return Option.getOrUndefined(
    Option.flatMap(settings, (value) => Option.fromNullishOr(value.remote?.defaultEnvironmentId)),
  );
});

const baseHeaders = (auth: ClaudeAuth) => ({
  authorization: `Bearer ${auth.accessToken}`,
  "anthropic-version": "2023-06-01",
  "anthropic-client-platform": "cli",
  "content-type": "application/json",
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const serverMessage = (body: unknown): string | undefined =>
  isRecord(body) && isRecord(body.error) && typeof body.error.message === "string"
    ? body.error.message
    : undefined;

const failForStatus = (response: HttpClientResponse.HttpClientResponse, what: string) =>
  Effect.gen(function* () {
    const body = yield* response.json.pipe(Effect.orElseSucceed(() => null));
    const message = serverMessage(body);
    if (response.status === 401) return yield* signedOutError();
    if (response.status === 404) {
      return yield* AcpError.AcpRequestError.invalidParams(
        message ?? `${what}: the Claude cloud session was not found for this account.`,
      );
    }
    return yield* AcpError.AcpRequestError.internalError(
      `${what} failed (HTTP ${response.status})${message ? `: ${message}` : ""}`,
    );
  });

const transportError = (what: string) => (cause: unknown) =>
  AcpError.AcpRequestError.internalError(
    `${what} could not reach api.anthropic.com: ${cause instanceof Error ? cause.message : String(cause)}`,
  );

const requestJson = (
  request: HttpClientRequest.HttpClientRequest,
  what: string,
): Effect.Effect<unknown, AcpError.AcpError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client
      .execute(request)
      .pipe(Effect.timeout("30 seconds"), Effect.mapError(transportError(what)));
    if (response.status < 200 || response.status >= 300) {
      return yield* failForStatus(response, what);
    }
    return yield* response.json.pipe(Effect.mapError(transportError(what)));
  });

export interface CloudSessionSummary {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly repository: string | undefined;
  readonly updatedAt: string | undefined;
}

function repositoryFromSources(sources: unknown): string | undefined {
  if (!Array.isArray(sources)) return undefined;
  for (const source of sources) {
    const url = isRecord(source)
      ? isRecord(source.git_repository)
        ? source.git_repository.url
        : source.type === "git_repository"
          ? source.url
          : undefined
      : undefined;
    if (typeof url !== "string") continue;
    const match = /github\.com[/:]([^/]+\/[^/.]+?)(?:\.git)?\/?$/i.exec(url);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

/** Worker states that mean a turn is in flight; the API has used both spellings. */
export const isBusyStatus = (status: string) => /working|running/i.test(status);

function parseSessionSummary(raw: unknown): CloudSessionSummary | undefined {
  if (!isRecord(raw) || typeof raw.id !== "string") return undefined;
  const config = isRecord(raw.config) ? raw.config : undefined;
  const context = isRecord(raw.session_context) ? raw.session_context : undefined;
  return {
    id: raw.id,
    title: typeof raw.title === "string" && raw.title.trim() !== "" ? raw.title : "Untitled",
    status:
      raw.status === "archived"
        ? "archived"
        : typeof raw.worker_status === "string"
          ? raw.worker_status
          : typeof raw.session_status === "string"
            ? raw.session_status
            : "idle",
    repository: repositoryFromSources(config?.sources ?? context?.sources),
    updatedAt:
      typeof raw.last_event_at === "string"
        ? raw.last_event_at
        : typeof raw.updated_at === "string"
          ? raw.updated_at
          : undefined,
  };
}

export const listCloudSessions = (auth: ClaudeAuth) =>
  requestJson(
    HttpClientRequest.get(`${API_BASE}/v1/code/sessions`).pipe(
      HttpClientRequest.setHeaders(baseHeaders(auth)),
    ),
    "Listing Claude cloud sessions",
  ).pipe(
    Effect.map((body) =>
      isRecord(body) && Array.isArray(body.data)
        ? body.data.flatMap((raw) => {
            const parsed = parseSessionSummary(raw);
            return parsed === undefined ? [] : [parsed];
          })
        : [],
    ),
  );

export interface CloudSessionDetail extends CloudSessionSummary {
  readonly outcomeBranch: string | undefined;
  readonly sourceRevision: string | undefined;
}

export const getCloudSession = (auth: ClaudeAuth, sessionId: string) =>
  requestJson(
    HttpClientRequest.get(`${API_BASE}/v1/code/sessions/${encodeURIComponent(sessionId)}`).pipe(
      HttpClientRequest.setHeaders(baseHeaders(auth)),
    ),
    "Reading the Claude cloud session",
  ).pipe(
    Effect.flatMap((body) => {
      const raw = isRecord(body) ? (body.response_shape ?? body.session ?? body) : undefined;
      const summary = parseSessionSummary(raw);
      if (summary === undefined || !isRecord(raw)) {
        return AcpError.AcpRequestError.internalError(
          "Claude returned a cloud session this agent cannot read.",
        );
      }
      const context = isRecord(raw.session_context)
        ? raw.session_context
        : isRecord(raw.config)
          ? raw.config
          : {};
      const outcome = Array.isArray(context.outcomes)
        ? context.outcomes.find(
            (item) =>
              isRecord(item) && (item.type === "git_repository" || isRecord(item.git_repository)),
          )
        : undefined;
      const gitInfo = isRecord(outcome)
        ? isRecord(outcome.git_info)
          ? outcome.git_info
          : isRecord(outcome.git_repository) && isRecord(outcome.git_repository.git_info)
            ? outcome.git_repository.git_info
            : undefined
        : undefined;
      const branch = Array.isArray(gitInfo?.branches) ? gitInfo.branches[0] : undefined;
      const source = Array.isArray(context.sources) ? context.sources[0] : undefined;
      const revision = isRecord(source)
        ? isRecord(source.git_repository)
          ? source.git_repository.revision
          : source.revision
        : undefined;
      return Effect.succeed({
        ...summary,
        outcomeBranch: typeof branch === "string" ? branch : undefined,
        sourceRevision: typeof revision === "string" ? revision : undefined,
      } satisfies CloudSessionDetail);
    }),
  );

export interface CloudEvent {
  readonly sequence: number;
  readonly payload: unknown;
}

function parseEvent(raw: unknown): CloudEvent | undefined {
  if (!isRecord(raw)) return undefined;
  const sequence = Number(raw.sequence_num);
  return Number.isSafeInteger(sequence) ? { sequence, payload: raw.payload } : undefined;
}

/** Durable events after `afterSequence`, oldest first, following `next_cursor`. */
export const readCloudEvents = (auth: ClaudeAuth, sessionId: string, afterSequence: number) =>
  Effect.gen(function* () {
    const events: Array<CloudEvent> = [];
    let cursor = afterSequence > 0 ? String(afterSequence) : undefined;
    for (let page = 0; page < 200; page++) {
      const body = yield* requestJson(
        HttpClientRequest.get(
          `${API_BASE}/v1/code/sessions/${encodeURIComponent(sessionId)}/events`,
        ).pipe(
          HttpClientRequest.setHeaders(baseHeaders(auth)),
          HttpClientRequest.setUrlParams({
            sort_order: "asc",
            ...(cursor === undefined ? {} : { cursor }),
          }),
        ),
        "Reading Claude cloud session events",
      );
      const data = isRecord(body) && Array.isArray(body.data) ? body.data : [];
      for (const raw of data) {
        const event = parseEvent(raw);
        if (event !== undefined && event.sequence > afterSequence) events.push(event);
      }
      const next = isRecord(body) ? body.next_cursor : undefined;
      if (typeof next !== "string" && typeof next !== "number") break;
      cursor = String(next);
    }
    return events;
  });

export type StreamedFrame =
  | { readonly kind: "durable"; readonly event: CloudEvent }
  | { readonly kind: "ephemeral"; readonly payload: unknown };

function parseStreamFrame(frame: SseFrame): StreamedFrame | undefined {
  if (frame.event !== "client_event" && frame.event !== "ephemeral_event") return undefined;
  let data: unknown;
  try {
    data = JSON.parse(frame.data);
  } catch {
    return undefined;
  }
  if (frame.event === "ephemeral_event") {
    return isRecord(data) ? { kind: "ephemeral", payload: data.payload } : undefined;
  }
  const event =
    parseEvent(data) ?? parseEvent({ ...(isRecord(data) ? data : {}), sequence_num: frame.id });
  return event === undefined ? undefined : { kind: "durable", event };
}

/** Live events after `afterSequence`; the stream ends when the server closes it. */
export const streamCloudEvents = (auth: ClaudeAuth, sessionId: string, afterSequence: number) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client
      .execute(
        HttpClientRequest.get(
          `${API_BASE}/v1/code/sessions/${encodeURIComponent(sessionId)}/events/stream`,
        ).pipe(
          HttpClientRequest.setHeaders({
            ...baseHeaders(auth),
            accept: "text/event-stream",
            ...(afterSequence > 0 ? { "last-event-id": String(afterSequence) } : {}),
          }),
        ),
      )
      .pipe(Effect.mapError(transportError("Streaming the Claude cloud session")));
    if (response.status < 200 || response.status >= 300) {
      return yield* failForStatus(response, "Streaming the Claude cloud session");
    }
    const decode = makeSseDecoder();
    return response.stream.pipe(
      Stream.decodeText(),
      Stream.mapError(transportError("Streaming the Claude cloud session")),
      Stream.flatMap((chunk) =>
        Stream.fromIterable(
          decode(chunk).flatMap((frame) => {
            const parsed = parseStreamFrame(frame);
            return parsed === undefined ? [] : [parsed];
          }),
        ),
      ),
    );
  });

const postEvents = (auth: ClaudeAuth, sessionId: string, events: ReadonlyArray<unknown>) =>
  requestJson(
    HttpClientRequest.post(
      `${API_BASE}/v1/code/sessions/${encodeURIComponent(sessionId)}/events`,
    ).pipe(
      HttpClientRequest.setHeaders(baseHeaders(auth)),
      HttpClientRequest.bodyJsonUnsafe({ events }),
    ),
    "Sending to the Claude cloud session",
  );

/**
 * Queues a user message. The uuid makes a retried POST a server-side duplicate
 * instead of a second message, so a send that may or may not have landed is
 * retried with it; results name it in `user_message_uuids`.
 */
export const sendUserMessage = (
  auth: ClaudeAuth,
  sessionId: string,
  input: { readonly uuid: string; readonly text: string },
) =>
  postEvents(auth, sessionId, [
    {
      uuid: input.uuid,
      session_id: sessionId,
      type: "user",
      parent_tool_use_id: null,
      message: { role: "user", content: input.text },
    },
  ]).pipe(
    Effect.map((body) => {
      const result =
        isRecord(body) && Array.isArray(body.results) && isRecord(body.results[0])
          ? body.results[0]
          : undefined;
      const sequence = Number(result?.sequence_num);
      return Number.isSafeInteger(sequence) ? sequence : undefined;
    }),
    Effect.retry({ times: 2 }),
  );

/** The same interrupt the Stop button on claude.ai sends. */
export const interruptSession = (auth: ClaudeAuth, sessionId: string) =>
  Effect.gen(function* () {
    yield* postEvents(auth, sessionId, [
      {
        uuid: yield* randomUuidV4,
        type: "control_request",
        request_id: yield* randomUuidV4,
        request: { subtype: "interrupt" },
      },
    ]);
  });

export interface CloudEnvironment {
  readonly id: string;
  readonly name: string;
  readonly kind: string | undefined;
}

const legacyHeaders = (auth: ClaudeAuth, organizationUuid: string) => ({
  ...baseHeaders(auth),
  "anthropic-beta": LEGACY_SESSIONS_BETA,
  "x-organization-uuid": organizationUuid,
});

const requireOrganization = Effect.gen(function* () {
  const organizationUuid = yield* readOrganizationUuid;
  if (organizationUuid === undefined) {
    return yield* AcpError.AcpRequestError.authRequired(
      "Claude Code's login does not record an organization. Sign in again with `claude auth login`.",
    );
  }
  return organizationUuid;
});

export const listEnvironments = (auth: ClaudeAuth) =>
  Effect.gen(function* () {
    const organizationUuid = yield* requireOrganization;
    const body = yield* requestJson(
      HttpClientRequest.get(`${API_BASE}/v1/environment_providers`).pipe(
        HttpClientRequest.setHeaders(legacyHeaders(auth, organizationUuid)),
      ),
      "Listing Claude cloud environments",
    );
    const environments =
      isRecord(body) && Array.isArray(body.environments) ? body.environments : [];
    return environments.flatMap((raw): Array<CloudEnvironment> => {
      if (!isRecord(raw) || typeof raw.environment_id !== "string") return [];
      return [
        {
          id: raw.environment_id,
          name: typeof raw.name === "string" ? raw.name : raw.environment_id,
          kind: typeof raw.kind === "string" ? raw.kind : undefined,
        },
      ];
    });
  });

/**
 * Creates an idle cloud session that clones `repository` at `revision`; the
 * first message is sent separately so it carries a uuid this agent knows.
 */
export const createCloudSession = (
  auth: ClaudeAuth,
  input: {
    readonly title: string;
    readonly environmentId: string;
    readonly repository: string;
    readonly revision: string | undefined;
  },
) =>
  Effect.gen(function* () {
    const organizationUuid = yield* requireOrganization;
    const body = yield* requestJson(
      HttpClientRequest.post(`${API_BASE}/v1/sessions`).pipe(
        HttpClientRequest.setHeaders(legacyHeaders(auth, organizationUuid)),
        HttpClientRequest.bodyJsonUnsafe({
          title: input.title,
          events: [],
          session_context: {
            sources: [
              {
                type: "git_repository",
                url: `https://github.com/${input.repository}`,
                ...(input.revision === undefined ? {} : { revision: input.revision }),
              },
            ],
            outcomes: [],
          },
          ...(input.environmentId.startsWith("ccpool_")
            ? { self_hosted_runner_pool_id: input.environmentId }
            : { environment_id: input.environmentId }),
        }),
      ),
      "Creating the Claude cloud session",
    );
    const id = isRecord(body) ? (isRecord(body.session) ? body.session.id : body.id) : undefined;
    if (typeof id !== "string" || id === "") {
      return yield* AcpError.AcpRequestError.internalError(
        "Claude created a cloud session but returned no session id; check claude.ai/code before retrying.",
      );
    }
    return id;
  });
