import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const actions = new Set(["windows", "snapshot", "click", "type", "key", "scroll"]);
const helperPath = fileURLToPath(new URL("./windows.ps1", import.meta.url));
const maxOutputBytes = 32 * 1024 * 1024;
const helperTimeoutMs = 20_000;

function validateRequest(action, args, homeDir) {
  if (process.platform !== "win32") {
    throw new Error("Windows computer use is available only on Windows.");
  }
  if (!actions.has(action)) {
    throw new Error("Unsupported Windows action.");
  }
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("Windows action arguments must be an object.");
  }
  if (args.windowId !== undefined && typeof args.windowId !== "string") {
    throw new Error("windowId must be a string returned by the windows action.");
  }
  if (action !== "windows" && !args.windowId) {
    throw new Error("Pass a windowId returned by the windows action.");
  }
  if (args.includeImage !== undefined && typeof args.includeImage !== "boolean") {
    throw new Error("includeImage must be a boolean.");
  }
  if (
    args.coordinateSpace !== undefined &&
    (!["click", "scroll"].includes(action) || !["desktop", "window"].includes(args.coordinateSpace))
  ) {
    throw new Error(
      "coordinateSpace is supported only for click/scroll and must be desktop or window.",
    );
  }
  if (homeDir !== undefined && typeof homeDir !== "string") {
    throw new Error("homeDir must be a path string.");
  }
  if (action === "snapshot" && (!homeDir || !path.isAbsolute(homeDir))) {
    throw new Error("An absolute homeDir is required when taking a snapshot.");
  }
}

function abortError() {
  const error = new Error("Windows CUA action was cancelled.");
  error.name = "AbortError";
  return error;
}

function getAbortSignal(options) {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new Error("Windows CUA options must be an object.");
  }
  const signal = options.signal;
  if (
    signal !== undefined &&
    (!signal ||
      typeof signal.aborted !== "boolean" ||
      typeof signal.addEventListener !== "function" ||
      typeof signal.removeEventListener !== "function")
  ) {
    throw new Error("options.signal must be an AbortSignal.");
  }
  return signal;
}

function callPowerShell(request, signal) {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        helperPath,
      ],
      { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
    );
    const helperPid = child.pid;

    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let timedOut = false;
    let abortHandler;

    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (abortHandler) signal?.removeEventListener("abort", abortHandler);
      callback(value);
    };

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, helperTimeoutMs);
    timeout.unref?.();

    abortHandler = () => {
      if (settled) return;
      if (helperPid !== undefined && child.pid === helperPid) child.kill();
      finish(reject, abortError());
    };
    if (signal) {
      signal.addEventListener("abort", abortHandler, { once: true });
      if (signal.aborted) abortHandler();
    }

    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxOutputBytes) {
        child.kill();
        finish(reject, new Error("Windows CUA returned too much data."));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      if (stderrBytes < 4096) {
        const kept = chunk.subarray(0, 4096 - stderrBytes);
        stderr.push(kept);
        stderrBytes += kept.length;
      }
    });
    child.on("error", () => {
      finish(reject, new Error("Could not start the Windows CUA helper."));
    });
    child.on("close", (code) => {
      if (timedOut) {
        finish(reject, new Error("Windows CUA helper timed out."));
        return;
      }
      if (code !== 0) {
        const detail = Buffer.concat(stderr).toString("utf8").trim();
        finish(
          reject,
          new Error(detail || `Windows CUA helper exited with code ${code ?? "unknown"}.`),
        );
        return;
      }
      try {
        const result = JSON.parse(Buffer.concat(stdout).toString("utf8"));
        finish(resolve, result);
      } catch {
        finish(reject, new Error("Windows CUA helper returned invalid JSON."));
      }
    });

    child.stdin.on("error", () => {
      // A helper that already exited will report its result through `close`.
    });
    child.stdin.end(JSON.stringify(request));
  });
}

export async function runWindowsAction(action, args = {}, homeDir, options = {}) {
  validateRequest(action, args, homeDir);
  const signal = getAbortSignal(options);
  if (signal?.aborted) throw abortError();
  return callPowerShell({ action, args, homeDir: homeDir ?? null }, signal);
}
