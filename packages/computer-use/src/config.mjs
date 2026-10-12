import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
export function computerUseConfig(environment = process.env) {
  return {
    homeDir: resolve(
      (environment.OPEN_HARNESS_CUA_HOME ?? environment.T3_COMPUTER_USE_HOME) ||
        resolve(repoRoot, ".t3/computer-use"),
    ),
    browserOnly:
      (environment.OPEN_HARNESS_CUA_BROWSER_ONLY ?? environment.T3_COMPUTER_USE_BROWSER_ONLY) ===
      "1",
  };
}
export const { homeDir, browserOnly } = computerUseConfig();
// Keep the installed Chrome wire identifier stable across the product rename.
export const hostName = "dev.t3code.cua";
