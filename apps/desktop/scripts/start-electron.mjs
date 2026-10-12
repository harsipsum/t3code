import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";

import { desktopDir, resolveElectronLaunchCommand } from "./electron-launcher.mjs";

NodeChildProcess.execFileSync(
  process.execPath,
  [NodePath.join(desktopDir, "scripts/build-browser-secret.mjs")],
  { stdio: "inherit" },
);

const childEnv = { ...process.env };
delete childEnv.ELECTRON_RUN_AS_NODE;

const debugPort = process.env.T3CODE_DESKTOP_REMOTE_DEBUGGING_PORT?.trim();
const electronArgs = ["dist-electron/main.cjs"];
if (debugPort) {
  if (!/^\d+$/.test(debugPort) || Number(debugPort) < 1024 || Number(debugPort) > 65535) {
    throw new Error("T3CODE_DESKTOP_REMOTE_DEBUGGING_PORT must be a port from 1024 to 65535.");
  }
  electronArgs.push(`--remote-debugging-port=${debugPort}`, "--remote-debugging-address=127.0.0.1");
}
const electronCommand = resolveElectronLaunchCommand(electronArgs);
const child = NodeChildProcess.spawn(electronCommand.electronPath, electronCommand.args, {
  stdio: "inherit",
  cwd: desktopDir,
  env: childEnv,
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
