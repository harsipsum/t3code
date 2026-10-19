// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { FetchHttpClient } from "effect/http";
import * as EffectAcpAgent from "effect-acp/agent";

import { runCloudAgent } from "./agent.ts";
import { makeClaudeCloudBackend } from "./claude/backend.ts";
import { makeCodexCloudBackend } from "./codex/backend.ts";
import { makeSessionStore, stateDirectory } from "./state.ts";

const VERSION = "0.1.0";

const CLOUD_PROVIDERS = ["claude", "codex"] as const;
type CloudProvider = (typeof CLOUD_PROVIDERS)[number];

const isCloudProvider = (value: string | undefined): value is CloudProvider =>
  CLOUD_PROVIDERS.some((provider) => provider === value);

/** ACP terminal sign-in hands the terminal to the provider's own login. */
function runLogin(provider: CloudProvider): number {
  const [command, args] =
    provider === "claude"
      ? [process.env.T3_CLOUD_ACP_CLAUDE ?? "claude", ["auth", "login"]]
      : [process.env.T3_CLOUD_ACP_CODEX ?? "codex", ["login", "--device-auth"]];
  const result = NodeChildProcess.spawnSync(command, args, { stdio: "inherit" });
  if (result.error) {
    process.stderr.write(`Could not run ${command}: ${result.error.message}\n`);
    return 1;
  }
  return result.status ?? 1;
}

/**
 * `t3 cloud-acp <claude|codex> [login]`: an ACP agent whose sessions are
 * provider-hosted cloud sessions, for a T3 Local ACP command provider.
 */
export function runCloudAcp(argv: ReadonlyArray<string>): void {
  const [provider, command] = argv;
  if (!isCloudProvider(provider)) {
    process.stderr.write(`Usage: t3 cloud-acp <${CLOUD_PROVIDERS.join("|")}> [login]\n`);
    process.exitCode = 2;
    return;
  }
  if (command === "login") {
    process.exitCode = runLogin(provider);
    return;
  }
  const program = Effect.gen(function* () {
    const store = yield* makeSessionStore(yield* stateDirectory(provider));
    const backend =
      provider === "claude"
        ? yield* makeClaudeCloudBackend(store, VERSION)
        : yield* makeCodexCloudBackend(store, VERSION);
    return yield* runCloudAgent(backend, store);
  }).pipe(
    Effect.provide(EffectAcpAgent.layerStdio()),
    Effect.scoped,
    Effect.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
  );
  NodeRuntime.runMain(program);
}
