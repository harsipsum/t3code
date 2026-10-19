import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

/**
 * What this agent must remember across T3 restarts, one file per ACP session so
 * concurrent agent processes never rewrite each other's records.
 *
 * - `remoteId`: sessions T3 starts get an ACP id before the provider assigns
 *   one (the first prompt creates the cloud work), so the mapping keeps import
 *   from creating a second T3 thread for the same cloud session.
 * - `deliveredSequence`: the last provider event shown in T3, so a sync after a
 *   restart or import shows only what T3 has not seen and never repeats a result.
 */
export const SessionRecord = Schema.Struct({
  remoteId: Schema.optional(Schema.String),
  deliveredSequence: Schema.optional(Schema.Number),
});
export type SessionRecord = typeof SessionRecord.Type;

const RecordJson = Schema.fromJsonString(SessionRecord);
const decodeRecord = Schema.decodeUnknownOption(RecordJson);
const encodeRecord = Schema.encodeSync(RecordJson);

export const defaultStateDirectory = Effect.gen(function* () {
  const env = yield* HostProcess.Environment;
  if (env.T3_CLOUD_ACP_STATE_DIR) return env.T3_CLOUD_ACP_STATE_DIR;
  const home = yield* HostProcess.HomeDirectory;
  const platform = yield* HostProcess.Platform;
  if (platform === "darwin") return `${home}/Library/Application Support/t3-cloud-acp`;
  if (platform === "win32") {
    return `${env.LOCALAPPDATA ?? `${home}\\AppData\\Local`}\\t3-cloud-acp`;
  }
  return `${env.XDG_STATE_HOME ?? `${home}/.local/state`}/t3-cloud-acp`;
});

export const makeSessionStore = (directory: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const fileFor = (sessionId: string) =>
      path.join(directory, `${encodeURIComponent(sessionId)}.json`);

    const read = (sessionId: string) =>
      fs.readFileString(fileFor(sessionId)).pipe(
        Effect.map((text) => decodeRecord(text)),
        Effect.map((record) => (record._tag === "Some" ? record.value : {})),
        Effect.orElseSucceed((): SessionRecord => ({})),
      );

    const update = (sessionId: string, patch: Partial<SessionRecord>) =>
      Effect.gen(function* () {
        const next = { ...(yield* read(sessionId)), ...patch };
        yield* fs.makeDirectory(directory, { recursive: true });
        const target = fileFor(sessionId);
        const temporary = `${target}.${process.pid}.tmp`;
        yield* fs.writeFileString(temporary, encodeRecord(next));
        yield* fs.rename(temporary, target);
      }).pipe(Effect.orDie);

    /** ACP session id for each provider id this agent created, for import dedupe. */
    const localIdsByRemoteId = Effect.gen(function* () {
      const names = yield* fs.readDirectory(directory).pipe(Effect.orElseSucceed(() => []));
      const result = new Map<string, string>();
      for (const name of names) {
        if (!name.endsWith(".json")) continue;
        const sessionId = decodeURIComponent(name.slice(0, -".json".length));
        const record = yield* read(sessionId);
        if (record.remoteId !== undefined) result.set(record.remoteId, sessionId);
      }
      return result;
    });

    return { read, update, localIdsByRemoteId };
  });

export type SessionStore = Effect.Success<ReturnType<typeof makeSessionStore>>;
