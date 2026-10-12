import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
export const homeDir = resolve(
  process.env.T3_COMPUTER_USE_HOME || resolve(repoRoot, ".t3/computer-use"),
);
export const hostName = "dev.t3code.cua";
