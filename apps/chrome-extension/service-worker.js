import {
  projectSnapshot,
  resolveScopeRoot,
  scopedSnapshotNodes,
  findSnapshotMatches,
  projectSearchSnapshot,
} from "./snapshot.js";

const HOST = "dev.t3code.cua";
const allowed = new Map();
const snapshots = new Map();
const scopeContinuations = new Map();
function clearScopeContinuations(tabId) {
  for (const [token, entry] of scopeContinuations)
    if (entry.tabId === tabId) scopeContinuations.delete(token);
}
function continuationAnchor(token, tabId, origin) {
  const entry = scopeContinuations.get(token);
  if (!entry || entry.expiresAt <= Date.now() || entry.tabId !== tabId || entry.origin !== origin) {
    if (entry) scopeContinuations.delete(token);
    throw new Error("The decision scope continuation expired or is no longer valid.");
  }
  return entry;
}
const queues = new Map();
const exportWaiters = new Map();
const cancelledCommands = new Set();
let port;
let connected = false;
let connectionError = "Open a T3 provider with the computer-use MCP server first.";

async function state() {
  const tabs = [];
  for (const tabId of allowed.keys()) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (!/^https?:\/\//.test(tab.url || "") || new URL(tab.url).origin !== allowed.get(tabId))
        throw new Error("Approved origin changed.");
      tabs.push({ tabId, title: tab.title, url: tab.url });
    } catch {
      allowed.delete(tabId);
      snapshots.delete(tabId);
      clearScopeContinuations(tabId);
      await chrome.debugger.detach({ tabId }).catch(() => {});
    }
  }
  port?.postMessage({ type: "state", tabs });
  return tabs;
}

function connect() {
  if (port) return;
  port = chrome.runtime.connectNative(HOST);
  port.onMessage.addListener((message) => {
    if (message.type === "connected") {
      connected = true;
      connectionError = "";
      void state();
    } else if (message.type === "error") {
      connected = false;
      connectionError = message.message;
    } else if (message.type === "cancel") {
      cancelledCommands.add(message.id);
    } else if (message.type === "exported") {
      const waiter = exportWaiters.get(message.requestId);
      if (waiter) {
        clearTimeout(waiter.timer);
        exportWaiters.delete(message.requestId);
        waiter.resolve(message.result);
      }
    } else if (message.type === "command") {
      const tabId = message.args?.tabId;
      const previous = queues.get(tabId) || Promise.resolve();
      const current = previous
        .catch(() => {})
        .then(async () => {
          if (!connected || Date.now() >= message.expiresAt)
            throw new Error("Command expired before execution. Take a new snapshot.");
          return execute(message.action, message.args || {}, message.expiresAt, message.id);
        });
      queues.set(tabId, current);
      void current
        .then(
          (result) => port?.postMessage({ type: "reply", id: message.id, result }),
          (error) =>
            port?.postMessage({
              type: "reply",
              id: message.id,
              error: error.message || "Chrome action failed.",
            }),
        )
        .finally(() => {
          cancelledCommands.delete(message.id);
          if (queues.get(tabId) === current) queues.delete(tabId);
        });
    }
  });
  port.onDisconnect.addListener(() => {
    connectionError = chrome.runtime.lastError?.message || "Native host disconnected.";
    connected = false;
    port = undefined;
    for (const [tabId] of allowed) void chrome.debugger.detach({ tabId }).catch(() => {});
    allowed.clear();
    snapshots.clear();
    scopeContinuations.clear();
    for (const waiter of exportWaiters.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(connectionError));
    }
    exportWaiters.clear();
  });
  port.postMessage({ type: "hello", extensionId: chrome.runtime.id, tabs: [] });
}

const cdp = (tabId, method, params = {}) => chrome.debugger.sendCommand({ tabId }, method, params);

async function requireTab(tabId) {
  if (!allowed.has(tabId))
    throw new Error("This tab is not allowed. Use the T3 Browser popup to approve it.");
  const tab = await chrome.tabs.get(tabId);
  if (!/^https?:\/\//.test(tab.url || "") || new URL(tab.url).origin !== allowed.get(tabId)) {
    allowed.delete(tabId);
    snapshots.delete(tabId);
    clearScopeContinuations(tabId);
    await chrome.debugger.detach({ tabId }).catch(() => {});
    await state();
    throw new Error("This tab left the approved site. Allow it again in the T3 Browser popup.");
  }
  return tab;
}

function assertDeadline(expiresAt = Infinity, commandId) {
  if (cancelledCommands.has(commandId))
    throw new Error(
      "Command cancelled before the next input. Already-applied input cannot be undone.",
    );
  if (Date.now() >= expiresAt)
    throw new Error("Command expired before execution. Take a new snapshot.");
}

async function referencedNode(tabId, args) {
  const snapshot = snapshots.get(tabId);
  if (!snapshot || snapshot.id !== args.snapshotId)
    throw new Error("Stale snapshot. Run chrome_snapshot again.");
  const ref = snapshot.refs.get(args.ref);
  if (!ref) throw new Error("Unknown element ref. Run chrome_snapshot again.");
  const tree = await cdp(tabId, "Accessibility.getPartialAXTree", {
    backendNodeId: ref.backendNodeId,
    fetchRelatives: false,
  });
  const current = tree.nodes.find((node) => node.backendDOMNodeId === ref.backendNodeId);
  const name = String(current?.name?.value || "").replace(/[\r\n]+/g, " ");
  if (!current || current.role?.value !== ref.role || name !== ref.name)
    throw new Error("The referenced element changed. Run chrome_snapshot again.");
  if (args.decisionGuard) {
    const states = Object.fromEntries(
      (current.properties || [])
        .filter((item) => ["checked", "expanded", "disabled", "selected"].includes(item.name))
        .map((item) => [item.name, item.value?.value]),
    );
    if (JSON.stringify(states) !== JSON.stringify(ref.states))
      throw new Error("The referenced element state changed. Run chrome_snapshot again.");
    if (ref.inputKind) {
      const details = await cdp(tabId, "DOM.describeNode", { backendNodeId: ref.backendNodeId });
      const attributes = details.node.attributes || [];
      const typeIndex = attributes.indexOf("type");
      const kind =
        details.node.nodeName === "TEXTAREA"
          ? "textarea"
          : details.node.nodeName === "INPUT"
            ? typeIndex < 0
              ? "text"
              : attributes[typeIndex + 1].toLowerCase()
            : "unknown";
      if (kind !== ref.inputKind || String(current.value?.value ?? "") !== ref.value)
        throw new Error(
          "The referenced element value or input type changed. Run chrome_snapshot again.",
        );
    }
    if (ref.selectOptions) {
      const object = await cdp(tabId, "DOM.resolveNode", { backendNodeId: ref.backendNodeId });
      try {
        const result = await cdp(tabId, "Runtime.callFunctionOn", {
          objectId: object.object.objectId,
          functionDeclaration:
            "function(){if(this.tagName!=='SELECT')return null;return {value:this.value,options:Array.from(this.options).slice(0,100).map(o=>({label:o.label,value:o.value,selected:o.selected,disabled:o.disabled}))}}",
          returnByValue: true,
        });
        if (
          result.exceptionDetails ||
          !result.result.value ||
          result.result.value.value !== ref.selectValue ||
          JSON.stringify(result.result.value.options) !== JSON.stringify(ref.selectOptions)
        )
          throw new Error(
            "The referenced element selection or options changed. Run chrome_snapshot again.",
          );
      } finally {
        await cdp(tabId, "Runtime.releaseObject", { objectId: object.object.objectId }).catch(
          () => {},
        );
      }
    }
  }
  return ref;
}

async function point(tabId, args, expiresAt, commandId) {
  const ref = await referencedNode(tabId, args);
  const object = await cdp(tabId, "DOM.resolveNode", { backendNodeId: ref.backendNodeId });
  try {
    assertDeadline(expiresAt, commandId);
    await cdp(tabId, "Runtime.callFunctionOn", {
      objectId: object.object.objectId,
      functionDeclaration: "function(){this.scrollIntoView({block:'center',inline:'center'});}",
      returnByValue: true,
    });
  } finally {
    await cdp(tabId, "Runtime.releaseObject", { objectId: object.object.objectId }).catch(() => {});
  }
  const box = await cdp(tabId, "DOM.getBoxModel", { backendNodeId: ref.backendNodeId });
  const quad = box.model.content;
  return {
    x: (quad[0] + quad[2] + quad[4] + quad[6]) / 4,
    y: (quad[1] + quad[3] + quad[5] + quad[7]) / 4,
    backendNodeId: ref.backendNodeId,
  };
}

const keyInfo = {
  Enter: ["Enter", "Enter", 13],
  Tab: ["Tab", "Tab", 9],
  Escape: ["Escape", "Escape", 27],
  Esc: ["Escape", "Escape", 27],
  Backspace: ["Backspace", "Backspace", 8],
  Delete: ["Delete", "Delete", 46],
  Space: [" ", "Space", 32],
  ArrowLeft: ["ArrowLeft", "ArrowLeft", 37],
  ArrowUp: ["ArrowUp", "ArrowUp", 38],
  ArrowRight: ["ArrowRight", "ArrowRight", 39],
  ArrowDown: ["ArrowDown", "ArrowDown", 40],
  Home: ["Home", "Home", 36],
  End: ["End", "End", 35],
  PageUp: ["PageUp", "PageUp", 33],
  PageDown: ["PageDown", "PageDown", 34],
};
async function press(tabId, keys, expiresAt, commandId) {
  let modifiers = 0;
  const regular = [];
  for (const key of keys) {
    const normalized = key.toLowerCase();
    if (["control", "ctrl"].includes(normalized)) modifiers |= 2;
    else if (normalized === "alt") modifiers |= 1;
    else if (normalized === "shift") modifiers |= 8;
    else if (["meta", "command", "win"].includes(normalized)) modifiers |= 4;
    else regular.push(key);
  }
  if (regular.length !== 1)
    throw new Error("Use one key plus optional Control/Alt/Shift/Meta modifiers.");
  const value = regular[0];
  const info =
    keyInfo[value] ||
    (/^[a-z]$/i.test(value)
      ? [value.toLowerCase(), `Key${value.toUpperCase()}`, value.toUpperCase().charCodeAt(0)]
      : /^[0-9]$/.test(value)
        ? [value, `Digit${value}`, value.charCodeAt(0)]
        : null);
  if (!info) throw new Error("Unsupported key. Use chrome_type to insert Unicode text.");
  const [key, code, windowsVirtualKeyCode] = info;
  assertDeadline(expiresAt, commandId);
  try {
    await cdp(tabId, "Input.dispatchKeyEvent", {
      type: "keyDown",
      key,
      code,
      windowsVirtualKeyCode,
      modifiers,
      ...(modifiers === 0 && key.length === 1 ? { text: key } : {}),
    });
  } finally {
    await cdp(tabId, "Input.dispatchKeyEvent", {
      type: "keyUp",
      key,
      code,
      windowsVirtualKeyCode,
      modifiers,
    });
  }
}

async function sessionSnapshot(tabId, profileName = "Chrome session", scope = "current-domain") {
  const tab = await requireTab(tabId);
  const hostname = new URL(tab.url).hostname;
  const site = new URL(tab.url);
  const requiredOrigins =
    scope === "all-sites" ? ["<all_urls>"] : [`${site.protocol}//${site.hostname}/*`];
  if (!(await chrome.permissions.contains({ origins: requiredOrigins })))
    throw new Error(
      "Use the popup's Save session button to grant cookie access for this site first.",
    );
  const stores = await chrome.cookies.getAllCookieStores();
  const storeId = stores.find((store) => store.tabIds.includes(tabId))?.id;
  const candidates = await chrome.cookies.getAll(storeId ? { storeId } : {});
  const cookies =
    scope === "all-sites"
      ? candidates
      : candidates.filter((cookie) => {
          const domain = cookie.domain.replace(/^\./, "");
          return cookie.hostOnly
            ? domain === hostname
            : domain === hostname || hostname.endsWith(`.${domain}`);
        });
  return {
    version: 1,
    capturedAt: new Date().toISOString(),
    browser: "chrome",
    profileName,
    scope,
    selectedHostname: hostname,
    domains: [...new Set(cookies.map((cookie) => cookie.domain))],
    cookies,
  };
}

async function execute(action, args, expiresAt = Infinity, commandId) {
  assertDeadline(expiresAt, commandId);
  if (action === "tabs") {
    return { tabs: (await state()).map((tab) => ({ ...tab, allowed: true })) };
  }
  const tab = await requireTab(args.tabId);
  const tabId = args.tabId;
  if (action === "snapshot") {
    if ((args.scope || args.scopeContinuation) && args.query)
      throw new Error("Use either a decision scope or a snapshot query.");
    if (args.scope && args.scopeContinuation)
      throw new Error("Use either an initial scope or its internal continuation.");
    const origin = new URL(tab.url).origin;
    const anchor = args.scopeContinuation
      ? continuationAnchor(args.scopeContinuation, tabId, origin)
      : args.scope
        ? await referencedNode(tabId, args.scope)
        : undefined;
    const result = await cdp(tabId, "Accessibility.getFullAXTree");
    const scopeRoot = anchor
      ? resolveScopeRoot(result.nodes, anchor, !!args.scopeContinuation)
      : undefined;
    const found =
      args.query !== undefined ? findSnapshotMatches(result.nodes, args.query) : undefined;
    const observedNodes = found
      ? [
          ...new Map(
            found.contexts.flatMap((context) => context.nodes).map((node) => [node.nodeId, node]),
          ).values(),
        ]
      : scopeRoot
        ? scopedSnapshotNodes(result.nodes, scopeRoot.nodeId)
        : result.nodes;
    const textRoles = new Set(["textbox", "searchbox", "combobox", "spinbutton"]);
    await Promise.all(
      observedNodes
        .filter((node) => !node.ignored && textRoles.has(node.role?.value) && node.backendDOMNodeId)
        .slice(0, args.maxNodes || 500)
        .map(async (node) => {
          try {
            const details = await cdp(tabId, "DOM.describeNode", {
              backendNodeId: node.backendDOMNodeId,
            });
            const attributes = details.node.attributes || [];
            const typeIndex = attributes.indexOf("type");
            const type = typeIndex === -1 ? "text" : attributes[typeIndex + 1].toLowerCase();
            node.isPassword = details.node.nodeName === "INPUT" && type === "password";
            if (
              details.node.nodeName === "TEXTAREA" ||
              (details.node.nodeName === "INPUT" &&
                ["text", "search", "email", "url", "tel", "number"].includes(type))
            ) {
              node.safeValue = String(node.value?.value ?? "");
              node.inputKind = details.node.nodeName === "TEXTAREA" ? "textarea" : type;
            }
            if (details.node.nodeName === "SELECT") {
              const object = await cdp(tabId, "DOM.resolveNode", {
                backendNodeId: node.backendDOMNodeId,
              });
              try {
                const options = await cdp(tabId, "Runtime.callFunctionOn", {
                  objectId: object.object.objectId,
                  functionDeclaration:
                    "function(){return {value:this.value,options:Array.from(this.options).slice(0,100).map(o=>({label:o.label,value:o.value,selected:o.selected,disabled:o.disabled}))}}",
                  returnByValue: true,
                });
                node.safeValue = options.result.value.value;
                node.selectOptions = options.result.value.options;
              } finally {
                await cdp(tabId, "Runtime.releaseObject", {
                  objectId: object.object.objectId,
                }).catch(() => {});
              }
            }
          } catch {
            /* Unknown field types keep their values omitted. */
          }
        }),
    );
    const projection = found
      ? projectSearchSnapshot(found, args.maxNodes || 500)
      : projectSnapshot(observedNodes, args.maxNodes || 500, scopeRoot?.nodeId);
    if (scopeRoot && !projection.rootRef)
      throw new Error("The decision scope has no current element ref. Take a new snapshot.");
    let scopeContinuation = args.scopeContinuation;
    if (scopeRoot && !scopeContinuation) {
      for (const [token, entry] of scopeContinuations)
        if (entry.expiresAt <= Date.now()) scopeContinuations.delete(token);
      if (scopeContinuations.size >= 128)
        throw new Error("Too many active decision scopes; return to the planner.");
      scopeContinuation = crypto.randomUUID();
      scopeContinuations.set(scopeContinuation, {
        tabId,
        origin,
        backendNodeId: anchor.backendNodeId,
        role: anchor.role,
        expiresAt: Date.now() + 120000,
      });
    }
    const id = crypto.randomUUID();
    snapshots.set(tabId, { id, refs: projection.refs, capturedAt: Date.now() });
    const layout = await cdp(tabId, "Page.getLayoutMetrics");
    const view = layout.cssVisualViewport || layout.visualViewport;
    return {
      tabId,
      title: tab.title,
      url: tab.url,
      snapshotId: id,
      text: projection.text,
      nodeCount: projection.nodeCount,
      omittedNodes: projection.omittedNodes,
      ...(found ? { search: projection.search } : {}),
      viewport: {
        width: view.clientWidth,
        height: view.clientHeight,
        scrollX: view.pageX,
        scrollY: view.pageY,
      },
      ...(args.structured ? { elements: projection.elements, capturedAt: Date.now() } : {}),
      ...(scopeRoot
        ? {
            scope: {
              ref: projection.rootRef,
              snapshotId: id,
              role: anchor.role,
              name: String(scopeRoot.name?.value || "").replace(/[\r\n]+/g, " "),
              outsideContentExcluded: true,
            },
            scopeContinuation,
          }
        : {}),
    };
  }
  if (action === "screenshot") {
    const captureDeadline = Math.min(expiresAt, Date.now() + 5000);
    let timer;
    let result;
    try {
      result = await Promise.race([
        (async () => {
          const layout = await cdp(tabId, "Page.getLayoutMetrics");
          const view = layout.cssVisualViewport || layout.visualViewport;
          assertDeadline(captureDeadline, commandId);
          // An explicit viewport clip avoids waiting for a hidden tab's compositor.
          return cdp(tabId, "Page.captureScreenshot", {
            format: "png",
            captureBeyondViewport: true,
            optimizeForSpeed: true,
            clip: {
              x: view.pageX,
              y: view.pageY,
              width: view.clientWidth,
              height: view.clientHeight,
              scale: 1,
            },
          });
        })(),
        new Promise((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(
                  "Chrome screenshot did not complete within 5 seconds. Take a new snapshot before retrying.",
                ),
              ),
            Math.max(0, captureDeadline - Date.now()),
          );
        }),
      ]);
      assertDeadline(captureDeadline, commandId);
    } finally {
      clearTimeout(timer);
    }
    const header = Uint8Array.from(atob(result.data.slice(0, 48)), (character) =>
      character.charCodeAt(0),
    );
    const dimensions = new DataView(header.buffer);
    return {
      tabId,
      mimeType: "image/png",
      width: dimensions.getUint32(16),
      height: dimensions.getUint32(20),
      imageBase64: result.data,
    };
  }
  if (action === "exportSession")
    return { sessionSnapshot: await sessionSnapshot(tabId, args.profileName) };
  if (action === "navigate") {
    const url = new URL(args.url);
    if (!["http:", "https:"].includes(url.protocol))
      throw new Error("Only HTTP(S) navigation is supported.");
    if (url.origin !== allowed.get(tabId))
      throw new Error(
        "Navigation leaves the approved site. Open that site and allow its tab in the popup first.",
      );
    assertDeadline(expiresAt, commandId);
    clearScopeContinuations(tabId);
    await cdp(tabId, "Page.navigate", { url: url.href });
  } else if (action === "click") {
    const location = await point(tabId, args, expiresAt, commandId);
    const button = args.button || "left";
    const clickCount = args.clickCount || 1;
    assertDeadline(expiresAt, commandId);
    try {
      await cdp(tabId, "Input.dispatchMouseEvent", {
        type: "mousePressed",
        x: location.x,
        y: location.y,
        button,
        clickCount,
      });
    } finally {
      await cdp(tabId, "Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: location.x,
        y: location.y,
        button,
        clickCount,
      });
    }
  } else if (action === "select") {
    const ref = await referencedNode(tabId, args);
    const object = await cdp(tabId, "DOM.resolveNode", { backendNodeId: ref.backendNodeId });
    try {
      assertDeadline(expiresAt, commandId);
      const result = await cdp(tabId, "Runtime.callFunctionOn", {
        objectId: object.object.objectId,
        functionDeclaration:
          "function(choice){if(this.tagName!=='SELECT')return {error:'The referenced element is not a native select.'};if(this.disabled)return {error:'The select is disabled.'};const matches=Array.from(this.options).filter(o=>o[choice.matchBy]===choice.text);if(matches.length!==1)return {error:'The option must match exactly one value or label.'};const option=matches[0];if(option.disabled||option.parentElement?.disabled)return {error:'The option is disabled.'};this.focus();for(const o of this.options)o.selected=o===option;this.dispatchEvent(new Event('input',{bubbles:true}));this.dispatchEvent(new Event('change',{bubbles:true}));return {value:this.value,label:option.label}}",
        arguments: [
          {
            value: {
              matchBy: typeof args.value === "string" ? "value" : "label",
              text: args.value ?? args.label,
            },
          },
        ],
        returnByValue: true,
      });
      if (result.exceptionDetails || result.result.value?.error)
        throw new Error(result.result.value?.error || "Select action failed.");
    } finally {
      await cdp(tabId, "Runtime.releaseObject", { objectId: object.object.objectId }).catch(
        () => {},
      );
    }
  } else if (action === "type") {
    const location = await point(tabId, args, expiresAt, commandId);
    assertDeadline(expiresAt, commandId);
    await cdp(tabId, "DOM.focus", { backendNodeId: location.backendNodeId });
    if (args.clear) await press(tabId, ["Control", "A"], expiresAt, commandId);
    assertDeadline(expiresAt, commandId);
    await cdp(tabId, "Input.insertText", { text: args.text });
  } else if (action === "key") await press(tabId, args.keys, expiresAt, commandId);
  else if (action === "scroll") {
    const viewport = await cdp(tabId, "Runtime.evaluate", {
      expression: "({width:innerWidth,height:innerHeight})",
      returnByValue: true,
    });
    const size = viewport.result.value;
    assertDeadline(expiresAt, commandId);
    const x = args.x ?? size.width / 2,
      y = args.y ?? size.height / 2;
    const deltaX = args.deltaX || 0,
      deltaY = args.deltaY;
    if (![x, y, deltaX, deltaY].every(Number.isFinite))
      throw new Error("Scroll coordinates and deltas must be finite numbers.");
    // Native wheel dispatch can wait indefinitely for hidden-tab compositor ACKs.
    // A fixed DOM scroll operation works without activating the user's window.
    await cdp(tabId, "Runtime.evaluate", {
      expression: `(()=>{let el=document.elementFromPoint(${x},${y});while(el&&el!==document.documentElement){const s=getComputedStyle(el);if(/auto|scroll/.test(s.overflowY+s.overflowX)&&(el.scrollHeight>el.clientHeight||el.scrollWidth>el.clientWidth))break;el=el.parentElement}const target=el&&el!==document.documentElement?el:document.scrollingElement;target.scrollBy({left:${deltaX},top:${deltaY},behavior:'instant'});return {x:target.scrollLeft,y:target.scrollTop}})()`,
      returnByValue: true,
    });
  } else throw new Error("Unsupported Chrome action.");
  snapshots.delete(tabId);
  return { ok: true, tabId, needsSnapshot: true };
}

chrome.debugger.onDetach.addListener((source) => {
  allowed.delete(source.tabId);
  snapshots.delete(source.tabId);
  clearScopeContinuations(source.tabId);
  void state();
});
chrome.debugger.onEvent.addListener((source, method) => {
  if (method === "DOM.documentUpdated" || method === "Page.frameNavigated") {
    snapshots.delete(source.tabId);
    clearScopeContinuations(source.tabId);
  }
});
chrome.tabs.onRemoved.addListener((tabId) => {
  allowed.delete(tabId);
  snapshots.delete(tabId);
  clearScopeContinuations(tabId);
  void state();
});
chrome.tabs.onUpdated.addListener((tabId, changes) => {
  if (allowed.has(tabId) && (changes.url || changes.status === "complete"))
    void requireTab(tabId).catch(() => {});
});

chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  void (async () => {
    if (message.action === "status")
      return {
        connected,
        error: connectionError,
        extensionId: chrome.runtime.id,
        tabs: await state(),
      };
    if (message.action === "connect") {
      connect();
      return { connecting: true };
    }
    if (message.action === "allow") {
      connect();
      const tab = await chrome.tabs.get(message.tabId);
      if (!/^https?:\/\//.test(tab.url || ""))
        throw new Error("Open an HTTP(S) page to allow this tab.");
      if (!allowed.has(tab.id)) await chrome.debugger.attach({ tabId: tab.id }, "1.3");
      await cdp(tab.id, "Page.enable");
      await cdp(tab.id, "DOM.enable");
      await cdp(tab.id, "Accessibility.enable");
      allowed.set(tab.id, new URL(tab.url).origin);
      await state();
      return { allowed: true, tabId: tab.id };
    }
    if (message.action === "revoke") {
      allowed.delete(message.tabId);
      snapshots.delete(message.tabId);
      clearScopeContinuations(message.tabId);
      await chrome.debugger.detach({ tabId: message.tabId }).catch(() => {});
      await state();
      return { revoked: true };
    }
    if (message.action === "export") {
      if (!connected) throw new Error("Connect the T3 native host before saving a session.");
      const snapshot = await sessionSnapshot(
        message.tabId,
        message.profileName,
        message.scope || "current-domain",
      );
      const requestId = crypto.randomUUID();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          exportWaiters.delete(requestId);
          reject(new Error("Local session export timed out."));
        }, 30_000);
        exportWaiters.set(requestId, { resolve, reject, timer });
        port.postMessage({ type: "session-export", requestId, snapshot });
      });
    }
    throw new Error("Unknown popup action.");
  })().then(
    (result) => respond({ ok: true, result }),
    (error) => respond({ ok: false, error: error.message || "T3 Browser failed." }),
  );
  return true;
});
