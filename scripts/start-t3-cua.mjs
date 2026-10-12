import { access } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { configureT3Cua, repoRoot } from "./t3-cua-profile.mjs";

const profile = await configureT3Cua();
await access(path.join(repoRoot, "apps/desktop/dist-electron/main.cjs")).catch(() => {
  throw new Error("Build this checkout first with vp run build:desktop.");
});
const child = spawn(
  process.execPath,
  [path.join(repoRoot, "apps/desktop/scripts/start-electron.mjs")],
  {
    cwd: repoRoot,
    stdio: "inherit",
    env: {
      ...process.env,
      T3CODE_HOME: profile.t3Home,
      T3CODE_DESKTOP_USER_DATA: profile.electronHome,
      T3CODE_DESKTOP_APP_USER_MODEL_ID: "dev.t3code.cua",
      T3CODE_DISABLE_AUTO_UPDATE: "1",
      T3CODE_DESKTOP_PROTOCOL_REGISTRATION_MANAGED: "1",
      OPEN_HARNESS_CUA_HOME: profile.computerHome,
      T3_CUA_REPO_ROOT: repoRoot,
    },
  },
);
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => child.kill());
