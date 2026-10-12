import test from "node:test";
import assert from "node:assert/strict";
import {
  buildDecision,
  decisionConfig,
  localDecisionUrl,
  validateDecision,
  runChromeAct,
} from "../src/decision.mjs";
import {
  projectSnapshot,
  resolveScopeRoot,
  scopedSnapshotNodes,
} from "../../../apps/chrome-extension/snapshot.js";
const config = {
  ...decisionConfig({
    T3_DECISION_MODEL_ENABLED: "1",
    T3_DECISION_MODEL_URL: "http://127.0.0.1:8080/v1/systemone",
  }),
  maxChars: 10000,
};
const input = {
  tabId: 1,
  intent: "Fill the known form and continue",
  textSlots: [{ id: "name", field: "Name", text: "Exact supplied text" }],
  maxSteps: 1,
};
const observation = {
  snapshotId: "fresh",
  title: "Public form",
  url: "http://localhost/form",
  text: "public state",
  elements: [
    { ref: "e1", role: "textbox", name: "Name", canType: true, value: "", states: {} },
    { ref: "e2", role: "button", name: "Continue", states: {} },
  ],
};
function answer(choices, choice) {
  return {
    answers: {
      action: {
        type: "choice",
        choice,
        confidence: 1,
        probabilities: Object.fromEntries(
          [...choices.keys()].map((id) => [id, id === choice ? 1 : 0]),
        ),
      },
    },
    usage: { input_tokens: 20, output_tokens: 0 },
  };
}

test("chooser is opt-in and rejects remote or non-decision endpoints", () => {
  assert.equal(decisionConfig({}).enabled, false);
  assert.equal(localDecisionUrl("http://127.0.0.1:8080"), "http://127.0.0.1:8080/v1/systemone");
  for (const url of [
    "https://example.com/v1/systemone",
    "http://0.0.0.0:8080",
    "http://localhost:8080/v1/chat/completions",
    "http://a:b@localhost:8080/v1/systemone",
  ])
    assert.throws(() => localDecisionUrl(url));
});
test("choices retain exact supplied text and refuse passwords, disabled targets and invented options", () => {
  const snapshot = {
    ...observation,
    elements: [
      ...observation.elements,
      { ref: "e3", role: "textbox", name: "Password", canType: true, password: true },
      { ref: "e4", role: "button", name: "Disabled", states: { disabled: true } },
      {
        ref: "e5",
        role: "combobox",
        name: "Route",
        options: [{ label: "Only supplied option", value: "opaque", selected: false }],
      },
    ],
  };
  const { choices } = buildDecision(snapshot, input, config);
  assert.ok(
    [...choices.values()].some(
      (c) => c.action === "type" && c.args.text === input.textSlots[0].text,
    ),
  );
  assert.ok(![...choices.values()].some((c) => ["e3", "e4"].includes(c.args?.ref)));
  assert.ok(
    [...choices.values()]
      .filter((c) => c.action === "select")
      .every((c) => c.args.value === "opaque"),
  );
  assert.ok(![...choices.values()].some((c) => c.action === "click" && c.args.ref === "e5"));
  const payload = answer(choices, "invented");
  assert.throws(() => validateDecision(payload, choices, 0.6));
});
test("large menus or payloads hand back control rather than silently dropping choices", () => {
  assert.throws(() => buildDecision(observation, input, { ...config, maxCandidates: 2 }));
  assert.throws(() => buildDecision(observation, input, { ...config, maxChars: 20 }));
  assert.throws(() =>
    buildDecision(
      observation,
      { ...input, textSlots: [...input.textSlots, ...input.textSlots] },
      config,
    ),
  );
  assert.throws(() => buildDecision({ ...observation, omittedNodes: 1 }, input, config));
});
test("uncertainty and malformed probability maps never execute", () => {
  const { choices } = buildDecision(observation, input, config);
  const first = [...choices.keys()][0];
  const payload = answer(choices, first);
  const selectedProbability = 1 / choices.size + 0.1 * (1 - 1 / choices.size);
  payload.answers.action.probabilities = Object.fromEntries(
    [...choices.keys()].map((id) => [
      id,
      id === first ? selectedProbability : (1 - selectedProbability) / (choices.size - 1),
    ]),
  );
  payload.answers.action.confidence = 0.1;
  assert.throws(() => validateDecision(payload, choices, 0.6), /uncertain/);
  payload.answers.action.confidence = 1;
  payload.answers.action.probabilities[first] = NaN;
  assert.throws(() => validateDecision(payload, choices, 0.6));
});
test("choice and normalized confidence must agree with the supplied probabilities", () => {
  const choices = new Map([
    ["click", { action: "click" }],
    ["handoff", { action: "handoff" }],
  ]);
  const payload = {
    answers: {
      action: {
        type: "choice",
        choice: "click",
        confidence: 0.99,
        probabilities: { click: 0.01, handoff: 0.99 },
      },
    },
  };
  assert.throws(() => validateDecision(payload, choices, 0.6), /choice disagrees/);
  payload.answers.action.probabilities = { click: 0.9, handoff: 0.1 };
  assert.throws(() => validateDecision(payload, choices, 0.6), /confidence disagrees/);
  payload.answers.action.confidence = 0.8;
  assert.equal(validateDecision(payload, choices, 0.6).action, "click");
});
test("uncertain decisions retain numeric diagnostics and token usage without executing", async () => {
  let executed = false;
  const result = await runChromeAct({
    input,
    config,
    call: async (action) => {
      if (action === "snapshot") return observation;
      executed = true;
    },
    fetcher: async (_url, request) => {
      const ids = Object.keys(JSON.parse(request.body).questions.action.criteria);
      const probability = 1 / ids.length + 0.2 * (1 - 1 / ids.length);
      const payload = answer(new Map(ids.map((id) => [id, {}])), ids[0]);
      payload.answers.action.confidence = 0.2;
      payload.answers.action.probabilities = Object.fromEntries(
        ids.map((id) => [id, id === ids[0] ? probability : (1 - probability) / (ids.length - 1)]),
      );
      return { ok: true, json: async () => payload };
    },
  });
  assert.equal(executed, false);
  assert.equal(result.status, "handoff");
  assert.equal(result.decisions[0].status, "refused");
  assert.equal(result.decisions[0].confidence, 0.2);
  assert.ok(result.decisions[0].probability > 0);
  assert.equal(result.usage[0].input_tokens, 20);
});
test("routine uses fresh refs, exact text, bounded steps and a final observation", async () => {
  const calls = [];
  let snapshots = 0;
  const result = await runChromeAct({
    input,
    config,
    call: async (action, args) => {
      calls.push({ action, args });
      return action === "snapshot" ? { ...observation, snapshotId: "s" + ++snapshots } : {};
    },
    fetcher: async (_url, request) => {
      assert.equal(request.redirect, "error");
      const body = JSON.parse(request.body);
      const choices = new Map(Object.keys(body.questions.action.criteria).map((id) => [id, {}]));
      return { ok: true, json: async () => answer(choices, [...choices.keys()][0]) };
    },
  });
  assert.equal(result.status, "budget");
  assert.equal(result.steps, 1);
  const mutation = calls.find((c) => c.action === "type");
  assert.equal(mutation.args.text, input.textSlots[0].text);
  assert.equal(mutation.args.snapshotId, "s1");
  assert.equal(mutation.args.decisionGuard, true);
  assert.equal(result.observation.snapshotId, "s2");
  assert.equal(result.usage[0].output_tokens, 0);
});
test("stale target re-observes once and uses the new ref snapshot", async () => {
  let snapshots = 0,
    attempts = 0;
  const result = await runChromeAct({
    input,
    config,
    call: async (action, args) => {
      if (action === "snapshot") return { ...observation, snapshotId: "s" + ++snapshots };
      if (++attempts === 1) throw new Error("Stale snapshot. Refresh.");
      assert.equal(args.snapshotId, "s2");
      return {};
    },
    fetcher: async (_url, request) => {
      const ids = Object.keys(JSON.parse(request.body).questions.action.criteria);
      return { ok: true, json: async () => answer(new Map(ids.map((id) => [id, {}])), ids[0]) };
    },
  });
  assert.equal(result.recoveries, 1);
  assert.equal(result.steps, 1);
  assert.equal(attempts, 2);
});
test("timeout/cancellation stops before executing a returned choice", async () => {
  const controller = new AbortController();
  let mutated = false;
  await assert.rejects(() =>
    runChromeAct({
      input,
      config,
      signal: controller.signal,
      call: async (action) => {
        if (action === "snapshot") return observation;
        mutated = true;
      },
      fetcher: async (_url, request) => {
        controller.abort();
        const ids = Object.keys(JSON.parse(request.body).questions.action.criteria);
        return { ok: true, json: async () => answer(new Map(ids.map((id) => [id, {}])), ids[0]) };
      },
    }),
  );
  assert.equal(mutated, false);
});
test("structured observation omits password values as well as unknown field values", () => {
  const nodes = [
    {
      nodeId: "1",
      backendDOMNodeId: 1,
      role: { value: "textbox" },
      name: { value: "Password" },
      isPassword: true,
      safeValue: "secret",
      inputKind: "password",
    },
    {
      nodeId: "2",
      backendDOMNodeId: 2,
      role: { value: "textbox" },
      name: { value: "Unknown" },
      value: { value: "unverified" },
    },
  ];
  const result = projectSnapshot(nodes);
  assert.ok(!JSON.stringify(result.elements).includes("secret"));
  assert.ok(!JSON.stringify(result.elements).includes("unverified"));
});

test("explicit scope retains its complete subtree and excludes neighbouring rows", () => {
  const nodes = [
    { nodeId: "page", role: { value: "RootWebArea" }, childIds: ["one", "two"] },
    {
      nodeId: "one",
      backendDOMNodeId: 10,
      role: { value: "row" },
      name: { value: "First row" },
      childIds: ["field", "save"],
    },
    {
      nodeId: "field",
      backendDOMNodeId: 11,
      role: { value: "textbox" },
      name: { value: "Name" },
      inputKind: "text",
      safeValue: "current public value",
    },
    { nodeId: "save", backendDOMNodeId: 12, role: { value: "button" }, name: { value: "Save" } },
    { nodeId: "two", backendDOMNodeId: 20, role: { value: "row" }, name: { value: "Other row" } },
  ];
  const anchor = { backendNodeId: 10, role: "row", name: "First row" };
  const root = resolveScopeRoot(nodes, anchor);
  assert.deepEqual(
    scopedSnapshotNodes(nodes, root.nodeId).map((node) => node.nodeId),
    ["one", "field", "save"],
  );
  const projected = projectSnapshot(nodes, 500, root.nodeId);
  assert.equal(projected.nodeCount, 3);
  assert.equal(projected.omittedNodes, 0);
  assert.equal(projected.rootRef, "e1");
  assert.match(projected.text, /First row.*\n.*current public value.*\n.*Save/);
  assert.doesNotMatch(projected.text, /Other row/);
  const scope = {
    ref: "e1",
    snapshotId: "new",
    role: "row",
    name: "First row",
    outsideContentExcluded: true,
  };
  const { body } = buildDecision(
    { ...observation, ...projected, snapshotId: "new", scope },
    input,
    config,
  );
  assert.equal(body.state.scope.outsideContentExcluded, true);
  assert.equal(body.state.publicObservation, projected.text);
});

test("changed, unsupported, detached or incomplete scopes are refused", () => {
  const node = {
    nodeId: "row",
    backendDOMNodeId: 10,
    role: { value: "row" },
    name: { value: "Current row" },
  };
  const anchor = { backendNodeId: 10, role: "row", name: "Current row" };
  assert.throws(() => resolveScopeRoot([], anchor), /changed or disappeared/);
  assert.throws(
    () => resolveScopeRoot([{ ...node, name: { value: "Different row" } }], anchor),
    /changed or disappeared/,
  );
  assert.throws(() => resolveScopeRoot([node], { ...anchor, role: "button" }), /Choose a row/);
  assert.throws(
    () => projectSnapshot([{ ...node, childIds: ["missing"] }], 500, "row"),
    /incomplete/,
  );
  assert.equal(projectSnapshot([node], 1, "row").omittedNodes, 0);
});

test("scoped routine refreshes the scope ID and never falls back to the whole page", async () => {
  let snapshots = 0;
  const scope = { ref: "row", snapshotId: "original" };
  const result = await runChromeAct({
    input: { ...input, scope },
    config,
    call: async (action, args) => {
      if (action !== "snapshot") return {};
      if (snapshots === 0) assert.deepEqual(args.scope, scope);
      else {
        assert.equal(args.scope, undefined);
        assert.equal(args.scopeContinuation, "internal-token");
      }
      const snapshotId = "s" + ++snapshots;
      return {
        ...observation,
        snapshotId,
        scopeContinuation: "internal-token",
        scope: {
          ref: "e0",
          snapshotId,
          role: "form",
          name: "Known form",
          outsideContentExcluded: true,
        },
      };
    },
    fetcher: async (_url, request) => {
      const ids = Object.keys(JSON.parse(request.body).questions.action.criteria);
      return { ok: true, json: async () => answer(new Map(ids.map((id) => [id, {}])), ids[0]) };
    },
  });
  assert.equal(result.steps, 1);
  assert.equal(result.observation.scope.snapshotId, "s2");
  assert.equal(result.observation.scopeContinuation, undefined);
  const refused = await runChromeAct({
    input: { ...input, scope },
    config,
    call: async () => observation,
    fetcher: async () => {
      throw new Error("No model call allowed after scope loss");
    },
  });
  assert.equal(refused.status, "handoff");
  assert.equal(refused.steps, 0);
  assert.match(refused.reason, /no whole-page fallback/);
});
