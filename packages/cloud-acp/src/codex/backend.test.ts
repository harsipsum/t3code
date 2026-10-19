// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { FetchHttpClient } from "effect/http";
import type * as AcpSchema from "effect-acp/schema";

import type { PromptInput } from "../agent.ts";
import { makeSessionStore } from "../state.ts";
import { makeCodexCloudBackend } from "./backend.ts";

/**
 * A stand-in `codex` binary for the CLI boundary only: it records each call and
 * reports the task as pending once, then ready. It proves this agent's
 * handling of `codex cloud` output, not anything about Codex Cloud itself.
 */
const FAKE_CODEX = String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const log = process.env.FAKE_CODEX_LOG;
const args = process.argv.slice(2);
fs.appendFileSync(log, JSON.stringify(args) + "\n");
const calls = fs.readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
const lists = calls.filter((call) => call[0] === "cloud" && call[1] === "list").length;
if (args[0] === "login" && args[1] === "status") { console.log("Logged in using ChatGPT"); process.exit(0); }
if (args[0] === "cloud" && args[1] === "exec") { console.log("Submitted as https://chatgpt.com/codex/tasks/task_e_proof123"); process.exit(0); }
if (args[0] === "cloud" && args[1] === "list") {
  console.log(JSON.stringify({ tasks: [{ id: "task_e_proof123", title: "Add proof marker", status: lists > 1 ? "ready" : "pending", environment_label: "harsipsum/t3code", summary: { files_modified: 1, lines_added: 1, lines_removed: 0 } }] }));
  process.exit(0);
}
if (args[0] === "cloud" && args[1] === "diff") { console.log("diff --git a/proof.txt b/proof.txt\n+hosted by Codex Cloud"); process.exit(0); }
process.exit(3);
`;

const setup = Effect.gen(function* () {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "cloud-acp-codex-"));
  const codex = NodePath.join(root, "codex");
  NodeFS.writeFileSync(codex, FAKE_CODEX, { mode: 0o755 });
  const log = NodePath.join(root, "calls.jsonl");
  NodeFS.writeFileSync(log, "");
  process.env.T3_CLOUD_ACP_CODEX = codex;
  process.env.FAKE_CODEX_LOG = log;
  process.env.CODEX_CLOUD_ENV = "env_proof";
  const layer = Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer);
  const store = yield* makeSessionStore(NodePath.join(root, "state")).pipe(Effect.provide(layer));
  const backend = yield* makeCodexCloudBackend(store, "test").pipe(Effect.provide(layer));
  const run = (sessionId: string, text: string, sync = false) =>
    Effect.gen(function* () {
      const updates: Array<AcpSchema.SessionUpdate> = [];
      const firstStatus = yield* Deferred.make<void>();
      const input: PromptInput = {
        sessionId,
        cwd: root,
        text,
        userText: text,
        cancelled: yield* Deferred.make<void>(),
        emit: (update) =>
          Effect.sync(() => void updates.push(update)).pipe(
            Effect.andThen(
              update.sessionUpdate === "tool_call_update"
                ? Deferred.succeed(firstStatus, undefined)
                : Effect.void,
            ),
            Effect.asVoid,
          ),
      };
      const fiber = yield* Effect.forkChild(
        Effect.result(sync ? backend.sync(input) : backend.prompt(input)),
      );
      // The task reports pending on the first poll; move past one poll interval.
      yield* Effect.raceFirst(Deferred.await(firstStatus), Fiber.await(fiber));
      yield* TestClock.adjust("10 seconds");
      return { stopReason: yield* Fiber.join(fiber), updates };
    });
  const calls = () =>
    NodeFS.readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Array<string>);
  return { run, calls };
});

describe("Codex Cloud backend", () => {
  it.effect("submits a task, waits for it to settle, and shows its result once", () =>
    Effect.gen(function* () {
      const { run, calls } = yield* setup;
      const sessionId = "t3-cloud-codex-thread";
      const first = yield* run(sessionId, "Add a proof marker");
      assert.equal(first.stopReason._tag === "Success" && first.stopReason.success, "end_turn");
      const exec = calls().find((call) => call[1] === "exec");
      assert.deepEqual(exec?.slice(0, 4), ["cloud", "exec", "--env", "env_proof"]);
      assert.equal(exec?.at(-1), "Add a proof marker");

      const diff = first.updates.find(
        (update) =>
          update.sessionUpdate === "tool_call_update" && update.title === "Codex Cloud diff",
      );
      assert.include(JSON.stringify(diff), "+hosted by Codex Cloud");

      const synced = yield* run(sessionId, "/sync", true);
      assert.notInclude(JSON.stringify(synced.updates), "+hosted by Codex Cloud");
      assert.include(JSON.stringify(synced.updates), "Already shown in this thread.");

      const followUp = yield* run(sessionId, "Also update the README");
      assert.equal(followUp.stopReason._tag, "Failure");
      assert.include(JSON.stringify(followUp.stopReason), "cannot take follow-ups from T3");
      assert.include(
        JSON.stringify(followUp.stopReason),
        "https://chatgpt.com/codex/tasks/task_e_proof123",
      );
      assert.equal(calls().filter((call) => call[1] === "exec").length, 1);
    }),
  );
});
