import { parseGitHubRepositoryNameWithOwnerFromRemoteUrl } from "@t3tools/shared/git";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import { spawnAndCollect } from "@t3tools/provider-core/server/snapshotProbe";
import * as Effect from "effect/Effect";
import { ChildProcess } from "effect/process";

/** Runs without a shell; on Windows this also resolves npm `.cmd` shims. */
export const run = (
  command: string,
  args: ReadonlyArray<string>,
  options: { readonly cwd?: string; readonly env?: Record<string, string> } = {},
) =>
  Effect.gen(function* () {
    const spawn = yield* resolveSpawnCommand(command, args);
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawn.command, spawn.args, {
        shell: spawn.shell,
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        ...(options.env === undefined ? {} : { env: options.env, extendEnv: true }),
      }),
    );
  });

/** Large enough for a reviewable change, small enough to keep the thread responsive. */
const MAX_PATCH_BYTES = 200_000;

export interface BranchDiff {
  readonly head: string;
  readonly patch: string;
  readonly truncated: boolean;
}

/** Git must fail rather than wait for a password, passphrase or host prompt. */
const NON_INTERACTIVE_GIT = { GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: "ssh -o BatchMode=yes" };

/**
 * The cloud session's pushed branch against its base, read with plain git in
 * the project checkout. Refs are resolved with `ls-remote` and fetched by sha,
 * so nothing is written to the checkout's refs and a concurrent fetch cannot
 * swap what is compared. Returns undefined when the branch is not reachable,
 * for example before the session pushed.
 */
export const readBranchDiff = (cwd: string, branch: string, base: string | undefined) =>
  Effect.gen(function* () {
    /** Branch or tag name, or a commit sha, fetched by sha. */
    const remoteSha = (revision: string) =>
      Effect.gen(function* () {
        let sha: string | undefined = /^[0-9a-f]{40,64}$/.test(revision) ? revision : undefined;
        if (sha === undefined) {
          const listed = yield* run(
            "git",
            ["ls-remote", "--", "origin", `refs/heads/${revision}`, `refs/tags/${revision}`],
            { cwd, env: NON_INTERACTIVE_GIT },
          );
          // An annotated tag also lists its peeled commit (`^{}`); diff against that.
          const lines = listed.code === 0 ? listed.stdout.trim().split("\n") : [];
          const line = lines.find((entry) => entry.endsWith("^{}")) ?? lines[0];
          sha = line?.split(/\s/)[0];
        }
        if (!sha || !/^[0-9a-f]{40,64}$/.test(sha)) return undefined;
        const fetched = yield* run("git", ["fetch", "--no-tags", "--", "origin", sha], {
          cwd,
          env: NON_INTERACTIVE_GIT,
        });
        return fetched.code === 0 ? sha : undefined;
      });
    const head = yield* remoteSha(branch);
    if (head === undefined) return undefined;
    // A base that cannot be resolved gives no diff rather than one against the wrong commit.
    const baseSha = base === undefined ? "HEAD" : yield* remoteSha(base);
    if (baseSha === undefined) return undefined;
    const threeDot = yield* run("git", ["diff", "--no-color", `${baseSha}...${head}`], { cwd });
    // A shallow checkout may not reach the merge base; compare the tips instead.
    const diff =
      threeDot.code === 0
        ? threeDot
        : yield* run("git", ["diff", "--no-color", baseSha, head], { cwd });
    if (diff.code !== 0) return undefined;
    const { text, truncated } = capPatch(diff.stdout);
    return { head, patch: text, truncated } satisfies BranchDiff;
  }).pipe(
    Effect.timeoutOption("60 seconds"),
    Effect.map((result) => (result._tag === "Some" ? result.value : undefined)),
    Effect.orElseSucceed(() => undefined),
  );

export function capPatch(patch: string): { readonly text: string; readonly truncated: boolean } {
  return patch.length > MAX_PATCH_BYTES
    ? { text: patch.slice(0, MAX_PATCH_BYTES), truncated: true }
    : { text: patch, truncated: false };
}

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
