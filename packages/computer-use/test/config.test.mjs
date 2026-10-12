import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { computerUseConfig, repoRoot } from "../src/config.mjs";
import { decisionConfig } from "../src/decision.mjs";

test("new computer-use environment names override legacy configuration without moving defaults", () => {
  const legacy = { T3_COMPUTER_USE_HOME: "old-home", T3_COMPUTER_USE_BROWSER_ONLY: "1" };
  assert.deepEqual(computerUseConfig(legacy), { homeDir: resolve("old-home"), browserOnly: true });
  assert.deepEqual(
    computerUseConfig({
      ...legacy,
      OPEN_HARNESS_CUA_HOME: "new-home",
      OPEN_HARNESS_CUA_BROWSER_ONLY: "0",
    }),
    { homeDir: resolve("new-home"), browserOnly: false },
  );
  assert.equal(computerUseConfig({}).homeDir, resolve(repoRoot, ".t3/computer-use"));
});

test("decision aliases preserve old profiles and explicit new zero takes precedence", () => {
  const legacy = {
    T3_DECISION_MODEL_ENABLED: "1",
    T3_DECISION_MODEL_URL: "http://localhost:8767/v1/systemone",
    T3_DECISION_MODEL_ID: "legacy",
    T3_DECISION_MODEL_MAX_STATE_CHARS: "7000",
    T3_DECISION_MODEL_MAX_CANDIDATES: "30",
    T3_DECISION_MODEL_MIN_CONFIDENCE: "0.8",
  };
  assert.equal(decisionConfig(legacy).enabled, true);
  const modern = decisionConfig({
    ...legacy,
    OPEN_HARNESS_CUA_DECISION_ENABLED: "0",
    OPEN_HARNESS_CUA_DECISION_URL: "http://127.0.0.1:8767/v1/systemone",
    OPEN_HARNESS_CUA_DECISION_ID: "modern",
    OPEN_HARNESS_CUA_DECISION_MAX_STATE_CHARS: "6000",
    OPEN_HARNESS_CUA_DECISION_MAX_CANDIDATES: "24",
    OPEN_HARNESS_CUA_DECISION_MIN_CONFIDENCE: "0",
  });
  assert.deepEqual(modern, {
    enabled: false,
    endpoint: "http://127.0.0.1:8767/v1/systemone",
    model: "modern",
    maxChars: 6000,
    maxCandidates: 24,
    minConfidence: 0,
  });
});
