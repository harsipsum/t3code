import assert from "node:assert/strict";
import test from "node:test";
import {
  findSnapshotMatches,
  projectSearchSnapshot,
  projectSnapshot,
} from "../../../apps/chrome-extension/snapshot.js";

function row(id, label) {
  return [
    {
      nodeId: id,
      backendDOMNodeId: Number(id),
      role: { value: "row" },
      childIds: [id + "-text", id + "-edit"],
    },
    { nodeId: id + "-text", role: { value: "StaticText" }, name: { value: label } },
    {
      nodeId: id + "-edit",
      backendDOMNodeId: Number(id) + 1000,
      role: { value: "button" },
      name: { value: "Edit" },
    },
  ];
}

test("query finds a late match before limiting and retains its complete row context", () => {
  const prefix = Array.from({ length: 80 }, (_, index) =>
    row(String(index + 1), "Earlier item " + index),
  );
  const nodes = [
    {
      nodeId: "page",
      role: { value: "RootWebArea" },
      childIds: [...prefix.map((r) => r[0].nodeId), "99"],
    },
    ...prefix.flat(),
    ...row("99", "Needle item"),
  ];
  assert.doesNotMatch(projectSnapshot(nodes, 5).text, /Needle/);
  const result = projectSearchSnapshot(findSnapshotMatches(nodes, "needle"), 5);
  assert.match(result.text, /row.*\n.*Needle item.*\n.*Edit/);
  assert.doesNotMatch(result.text, /Earlier item/);
  assert.equal(result.nodeCount, 3);
  assert.equal(result.omittedNodes, 0);
  assert.equal(result.search.contexts[0].ref, "e1");
  assert.equal(result.search.completeReturnedContexts, true);
});

test("many matches report ambiguity and omit whole contexts without splitting them", () => {
  const nodes = [...row("1", "Duplicate item"), ...row("2", "Duplicate item")];
  const result = projectSearchSnapshot(findSnapshotMatches(nodes, "Duplicate"), 3);
  assert.equal(result.search.matchedNodes, 2);
  assert.equal(result.search.contextCount, 2);
  assert.equal(result.search.returnedContexts, 1);
  assert.equal(result.search.omittedContexts, 1);
  assert.equal(result.search.ambiguous, true);
  assert.equal(result.nodeCount, 3);
  assert.equal(result.omittedNodes, 0);
  assert.equal(result.search.outsideContentExcluded, true);
  const tooSmall = projectSearchSnapshot(findSnapshotMatches(nodes, "Duplicate"), 2);
  assert.equal(tooSmall.nodeCount, 0);
  assert.equal(tooSmall.search.omittedContexts, 2);
});

test("query matches public names only, while matched contexts retain password redaction", () => {
  const nodes = [
    {
      nodeId: "form",
      backendDOMNodeId: 1,
      role: { value: "form" },
      childIds: ["password", "unknown"],
    },
    {
      nodeId: "password",
      backendDOMNodeId: 2,
      role: { value: "textbox" },
      name: { value: "Password" },
      isPassword: true,
      safeValue: "secret-value",
    },
    {
      nodeId: "unknown",
      backendDOMNodeId: 3,
      role: { value: "textbox" },
      name: { value: "Unverified" },
      value: { value: "secret-value" },
    },
  ];
  assert.equal(findSnapshotMatches(nodes, "secret-value").matchedNodes, 0);
  const result = projectSearchSnapshot(findSnapshotMatches(nodes, "Password"));
  assert.match(result.text, /redacted/);
  assert.doesNotMatch(JSON.stringify(result), /secret-value/);
});
