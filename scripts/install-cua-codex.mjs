import { mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { repoRoot } from "./t3-cua-profile.mjs";

const version = "0.162.1";
const runtimeDirectory = path.join(repoRoot, ".t3", "codex-runtime");
await mkdir(runtimeDirectory, { recursive: true, mode: 0o700 });
const npmCli = path.join(
  path.dirname(process.execPath),
  "node_modules",
  "npm",
  "bin",
  "npm-cli.js",
);
const install = spawn(
  process.execPath,
  [
    npmCli,
    "install",
    "--prefix",
    runtimeDirectory,
    "--no-save",
    "--no-audit",
    "--no-fund",
    `@openai/codex@${version}`,
  ],
  { stdio: "inherit", cwd: repoRoot },
);
const code = await new Promise((resolve) => install.once("exit", resolve));
if (code !== 0) throw new Error(`Fork-local Codex installation failed (${code}).`);
console.log(`Codex ${version} installed only in ${runtimeDirectory}.`);
console.log("Run node scripts/t3-cua-profile.mjs --luna to use it in this fork.");
