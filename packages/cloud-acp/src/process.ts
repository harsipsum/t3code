import { parseGitHubRepositoryNameWithOwnerFromRemoteUrl } from "@t3tools/shared/git";
import { spawnAndCollect } from "@t3tools/provider-core/server/snapshotProbe";
import * as Effect from "effect/Effect";
import { ChildProcess } from "effect/process";

export const run = (
  command: string,
  args: ReadonlyArray<string>,
  options: { readonly cwd?: string; readonly env?: Record<string, string> } = {},
) =>
  spawnAndCollect(
    command,
    ChildProcess.make(command, [...args], {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.env === undefined ? {} : { env: options.env, extendEnv: true }),
    }),
  );

/** Large enough for a reviewable change, small enough to keep the thread responsive. */
const MAX_PATCH_BYTES = 200_000;

export interface BranchDiff {
  readonly patch: string;
  readonly truncated: boolean;
}

/**
 * The cloud session's pushed branch against its base, read with plain git in
 * the project checkout. Fetching only adds remote-tracking objects; the
 * working tree is untouched. Returns undefined when the branch is not
 * reachable, for example before the session pushed.
 */
export const readBranchDiff = (cwd: string, branch: string, base: string | undefined) =>
  Effect.gen(function* () {
    // Resolve each ref through FETCH_HEAD: `origin/<name>` only appears when the
    // clone's refspec covers it, and this must not write refs of its own.
    const fetchSha = (ref: string) =>
      Effect.gen(function* () {
        const fetched = yield* run("git", ["fetch", "--no-tags", "origin", ref], {
          cwd,
          env: { GIT_TERMINAL_PROMPT: "0" },
        });
        if (fetched.code !== 0) return undefined;
        const sha = yield* run("git", ["rev-parse", "FETCH_HEAD"], { cwd });
        return sha.code === 0 ? sha.stdout.trim() : undefined;
      });
    const head = yield* fetchSha(branch);
    if (head === undefined) return undefined;
    const baseSha = (base === undefined ? undefined : yield* fetchSha(base)) ?? "HEAD";
    const threeDot = yield* run("git", ["diff", "--no-color", `${baseSha}...${head}`], { cwd });
    // A shallow checkout may not reach the merge base; compare the tips instead.
    const diff =
      threeDot.code === 0
        ? threeDot
        : yield* run("git", ["diff", "--no-color", baseSha, head], { cwd });
    if (diff.code !== 0) return undefined;
    return diff.stdout.length > MAX_PATCH_BYTES
      ? { patch: diff.stdout.slice(0, MAX_PATCH_BYTES), truncated: true }
      : { patch: diff.stdout, truncated: false };
  }).pipe(
    Effect.timeoutOption("60 seconds"),
    Effect.map((result) => (result._tag === "Some" ? result.value : undefined)),
    Effect.orElseSucceed(() => undefined),
  );

export interface WorkspaceRepository {
  /** `owner/name` of the GitHub `origin` remote. */
  readonly nameWithOwner: string;
  readonly branch: string | undefined;
}

/** The GitHub repository and branch a cloud session for this checkout should clone. */
export const readWorkspaceRepository = (cwd: string) =>
  Effect.gen(function* () {
    const origin = yield* run("git", ["remote", "get-url", "origin"], { cwd });
    const nameWithOwner =
      origin.code === 0
        ? parseGitHubRepositoryNameWithOwnerFromRemoteUrl(origin.stdout.trim())
        : null;
    if (nameWithOwner === null) return undefined;
    const branch = yield* run("git", ["branch", "--show-current"], { cwd });
    const name = branch.stdout.trim();
    return {
      nameWithOwner,
      branch: branch.code === 0 && name !== "" ? name : undefined,
    } satisfies WorkspaceRepository;
  }).pipe(Effect.orElseSucceed(() => undefined));
