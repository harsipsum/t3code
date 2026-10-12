import assert from "node:assert/strict";
import test from "node:test";

test("actual extension invalidation preserves only the original internal scope identity", async (t) => {
  const event = () => ({
    listeners: [],
    addListener(listener) {
      this.listeners.push(listener);
    },
  });
  const pending = new Map();
  const port = {
    onMessage: event(),
    onDisconnect: event(),
    postMessage(message) {
      if (message.type === "reply") pending.get(message.id)?.(message);
    },
  };
  const tab = { id: 7, title: "Generic public form", url: "http://localhost/form" };
  let rootId = 10,
    rootName = "Initial row",
    selectedValue = "a",
    optionLabel = "Second";
  let mutations = 0;
  const nodes = () => [
    {
      nodeId: "row",
      backendDOMNodeId: rootId,
      role: { value: "row" },
      name: { value: rootName },
      childIds: ["select", "save"],
    },
    {
      nodeId: "select",
      backendDOMNodeId: 11,
      role: { value: "combobox" },
      name: { value: "Stage" },
      value: { value: selectedValue },
    },
    { nodeId: "save", backendDOMNodeId: 12, role: { value: "button" }, name: { value: "Save" } },
  ];
  const options = () => [
    { label: "First", value: "a", selected: selectedValue === "a", disabled: false },
    { label: optionLabel, value: "b", selected: selectedValue === "b", disabled: false },
  ];
  const previousChrome = globalThis.chrome;
  globalThis.chrome = {
    runtime: { id: "test", onMessage: event(), connectNative: () => port },
    tabs: { get: async () => ({ ...tab }), onRemoved: event(), onUpdated: event() },
    debugger: {
      attach: async () => {},
      detach: async () => {},
      onDetach: event(),
      onEvent: event(),
      sendCommand: async (_target, method, args = {}) => {
        if (method === "Accessibility.getFullAXTree") return { nodes: nodes() };
        if (method === "Accessibility.getPartialAXTree")
          return { nodes: nodes().filter((node) => node.backendDOMNodeId === args.backendNodeId) };
        if (method === "DOM.describeNode") return { node: { nodeName: "SELECT", attributes: [] } };
        if (method === "DOM.resolveNode") return { object: { objectId: "select" } };
        if (method === "Runtime.callFunctionOn") {
          if (args.functionDeclaration.includes("function(choice)")) {
            selectedValue = args.arguments[0].value.text;
            rootName = "Changed child value";
            mutations++;
            return { result: { value: { value: selectedValue, label: selectedValue } } };
          }
          return { result: { value: { value: selectedValue, options: options() } } };
        }
        if (method === "Page.getLayoutMetrics")
          return { cssVisualViewport: { clientWidth: 800, clientHeight: 600, pageX: 0, pageY: 0 } };
        return {};
      },
    },
  };
  t.after(() => {
    globalThis.chrome = previousChrome;
  });
  await import("../../../apps/chrome-extension/service-worker.js?scope-state-proof");
  const popup = (message) =>
    new Promise((resolve) =>
      globalThis.chrome.runtime.onMessage.listeners[0](message, {}, resolve),
    );
  assert.equal((await popup({ action: "allow", tabId: 7 })).ok, true);
  port.onMessage.listeners[0]({ type: "connected" });
  let sequence = 0;
  const command = async (action, args) => {
    const id = String(++sequence);
    const response = await new Promise((resolve) => {
      pending.set(id, resolve);
      port.onMessage.listeners[0]({
        type: "command",
        id,
        action,
        args: { tabId: 7, ...args },
        expiresAt: Date.now() + 10000,
      });
    });
    pending.delete(id);
    if (response.error) throw new Error(response.error);
    return response.result;
  };
  const initial = await command("snapshot", {});
  const scoped = await command("snapshot", {
    scope: { ref: "e1", snapshotId: initial.snapshotId },
    structured: true,
  });
  await command("select", {
    ref: "e2",
    snapshotId: scoped.snapshotId,
    value: "b",
    decisionGuard: true,
  });
  await assert.rejects(
    command("snapshot", { scope: { ref: "e1", snapshotId: scoped.snapshotId }, structured: true }),
    /Stale snapshot/,
  );
  const continued = await command("snapshot", {
    scopeContinuation: scoped.scopeContinuation,
    structured: true,
  });
  assert.equal(continued.scope.name, "Changed child value");
  assert.equal(continued.scopeContinuation, scoped.scopeContinuation);
  assert.equal(continued.elements.find((node) => node.ref === "e2").value, "b");
  await command("select", {
    ref: "e2",
    snapshotId: continued.snapshotId,
    value: "a",
    decisionGuard: true,
  });
  assert.equal(mutations, 2, "two actions survive the real public-ref invalidation path");
  rootId = 99;
  await assert.rejects(
    command("snapshot", { scopeContinuation: scoped.scopeContinuation, structured: true }),
    /changed or disappeared/,
  );
  rootId = undefined;
  await assert.rejects(
    command("snapshot", { scopeContinuation: scoped.scopeContinuation, structured: true }),
    /changed or disappeared/,
  );
  rootId = 10;
  const refreshed = await command("snapshot", {});
  optionLabel = "Externally changed option";
  await assert.rejects(
    command("select", {
      ref: "e2",
      snapshotId: refreshed.snapshotId,
      value: "b",
      decisionGuard: true,
    }),
    /selection or options changed/,
  );
  assert.equal(mutations, 2);
  await command("select", { ref: "e2", snapshotId: refreshed.snapshotId, value: "b" });
  assert.equal(mutations, 3, "existing direct-tool behavior remains unchanged");
  globalThis.chrome.debugger.onEvent.listeners[0]({ tabId: 7 }, "DOM.documentUpdated");
  await assert.rejects(
    command("snapshot", { scopeContinuation: scoped.scopeContinuation, structured: true }),
    /no longer valid/,
  );
});
