import type { ProviderInstanceEnvironment } from "@t3tools/contracts";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as Effect from "effect/Effect";

/**
 * The environment an instance's agent runs with. `T3CODE_ACP_STATE_DIR` is a
 * directory inside this T3 home that belongs to the instance alone, for agents
 * whose own records follow T3 threads, such as `t3 cloud-acp`'s record of what
 * each thread has already shown.
 */
export const acpAgentEnvironment = Effect.fn("acpAgentEnvironment")(function* (
  instanceId: string,
  environment: ProviderInstanceEnvironment | undefined,
  hostEnvironment: NodeJS.ProcessEnv,
) {
  const host = yield* ProviderHost.ProviderHost;
  return {
    ...(yield* mergeProviderInstanceEnvironment(environment, hostEnvironment)),
    T3CODE_ACP_STATE_DIR: `${host.paths.stateDir}/acp/${instanceId}`,
  } satisfies NodeJS.ProcessEnv;
});
