export function resolveScopeRoot(nodes, anchor, continuation = false) {
  if (!["row", "dialog", "form", "listitem", "menu", "group", "region"].includes(anchor.role))
    throw new Error(
      "Choose a row, dialog, form, listitem, menu, group or region as the decision scope.",
    );
  const root = nodes.find((node) => node.backendDOMNodeId === anchor.backendNodeId);
  const name = String(root?.name?.value || "").replace(/[\r\n]+/g, " ");
  if (
    !root ||
    root.ignored ||
    root.role?.value !== anchor.role ||
    (!continuation && name !== anchor.name)
  )
    throw new Error("The decision scope changed or disappeared. Take a new snapshot.");
  return root;
}

export function scopedSnapshotNodes(nodes, rootNodeId) {
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  const found = [];
  const visited = new Set();
  function visit(id) {
    if (visited.has(id)) return;
    const node = byId.get(id);
    if (!node) throw new Error("The decision scope has an incomplete accessibility tree.");
    visited.add(id);
    found.push(node);
    for (const childId of node.childIds || []) visit(childId);
  }
  visit(rootNodeId);
  return found;
}

export function findSnapshotMatches(nodes, query) {
  const search = String(query).trim().toLocaleLowerCase();
  if (!search || search.length > 200) throw new Error("query must contain 1 to 200 characters.");
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  const parents = new Map();
  for (const node of nodes)
    for (const child of node.childIds || []) parents.set(child, node.nodeId);
  const matches = nodes.filter(
    (node) =>
      !node.ignored &&
      !["RootWebArea", "InlineTextBox"].includes(node.role?.value) &&
      String(node.name?.value || "")
        .toLocaleLowerCase()
        .includes(search),
  );
  const roots = new Set();
  for (const match of matches) {
    let current = match;
    let fallback;
    let selected;
    const visited = new Set();
    while (current && !visited.has(current.nodeId)) {
      visited.add(current.nodeId);
      const role = current.role?.value;
      if (["row", "dialog", "form", "listitem"].includes(role)) {
        selected = current;
        break;
      }
      if (!fallback && ["menu", "group", "region"].includes(role)) fallback = current;
      current = byId.get(parents.get(current.nodeId));
    }
    roots.add((selected || fallback || match).nodeId);
  }
  // An ancestor context already contains a descendant context in full.
  for (const rootId of [...roots]) {
    let parent = parents.get(rootId);
    const visited = new Set();
    while (parent !== undefined && !visited.has(parent)) {
      visited.add(parent);
      if (roots.has(parent)) {
        roots.delete(rootId);
        break;
      }
      parent = parents.get(parent);
    }
  }
  return {
    query,
    matchedNodes: matches.length,
    contexts: [...roots].map((rootId) => ({ rootId, nodes: scopedSnapshotNodes(nodes, rootId) })),
  };
}

export function projectSearchSnapshot(found, maxNodes = 500) {
  const selected = [];
  let count = 0;
  for (const context of found.contexts) {
    const full = projectSnapshot(context.nodes, Number.MAX_SAFE_INTEGER, context.rootId);
    if (count + full.nodeCount > maxNodes) continue;
    selected.push(context);
    count += full.nodeCount;
  }
  const projection = projectSnapshot(
    selected.flatMap((context) => context.nodes),
    maxNodes,
    undefined,
    selected.map((context) => context.rootId),
  );
  const contexts = selected.map((context) => {
    const root = context.nodes[0];
    const ref = [...projection.refs].find(
      ([, value]) => value.backendNodeId === root.backendDOMNodeId,
    )?.[0];
    return { ref, role: root.role?.value, name: String(root.name?.value || "") };
  });
  return {
    ...projection,
    search: {
      query: found.query,
      matchedNodes: found.matchedNodes,
      contextCount: found.contexts.length,
      returnedContexts: selected.length,
      omittedContexts: found.contexts.length - selected.length,
      ambiguous: found.contexts.length > 1,
      outsideContentExcluded: true,
      completeReturnedContexts: true,
      contexts,
    },
  };
}

/** Emit values only after the caller verifies a non-password DOM input type. */
export function projectSnapshot(nodes, maxNodes = 500, rootNodeId, contextRootIds = []) {
  if (rootNodeId !== undefined) nodes = scopedSnapshotNodes(nodes, rootNodeId);
  const forceRoots = new Set(contextRootIds);
  if (rootNodeId !== undefined) forceRoots.add(rootNodeId);
  const byId = new Map(nodes.filter((node) => node.nodeId).map((node) => [node.nodeId, node]));
  const children = new Set(nodes.flatMap((node) => node.childIds || []));
  const retained = [];
  const visited = new Set();
  const containers = new Set([
    "RootWebArea",
    "table",
    "row",
    "list",
    "listitem",
    "form",
    "dialog",
    "menu",
    "MenuListPopup",
  ]);
  function visit(node, depth = 0, ancestors = []) {
    if (visited.has(node)) return;
    visited.add(node);
    const role = String(node.role?.value || "unknown");
    const name = String(node.name?.value || "").replace(/[\r\n]+/g, " ");
    const duplicateText =
      role === "StaticText" &&
      ancestors.some((parent) => parent.name === name || parent.safeValue === name);
    const keep =
      !node.ignored &&
      role !== "InlineTextBox" &&
      !duplicateText &&
      (name ||
        containers.has(role) ||
        forceRoots.has(node.nodeId) ||
        node.isPassword ||
        typeof node.safeValue === "string");
    if (keep) retained.push({ node, depth, role, name });
    const next = keep ? [...ancestors, { name, safeValue: node.safeValue }] : ancestors;
    for (const childId of node.childIds || []) {
      const child = byId.get(childId);
      if (child) visit(child, depth + (keep ? 1 : 0), next);
    }
  }
  if (rootNodeId !== undefined) {
    const root = byId.get(rootNodeId);
    if (!root)
      throw new Error("The decision scope is unavailable in the current accessibility tree.");
    visit(root);
  } else {
    for (const node of nodes) if (!node.nodeId || !children.has(node.nodeId)) visit(node);
    for (const node of nodes) visit(node);
  }
  const refs = new Map();
  const lines = [];
  const elements = [];
  let rootRef;
  for (const { node, depth, role, name } of retained.slice(0, maxNodes)) {
    let ref = "";
    if (node.backendDOMNodeId) {
      ref = `e${refs.size + 1}`;
      if (node.nodeId === rootNodeId) rootRef = ref;
      const states = Object.fromEntries(
        (node.properties || [])
          .filter((item) => ["checked", "expanded", "disabled", "selected"].includes(item.name))
          .map((item) => [item.name, item.value?.value]),
      );
      refs.set(ref, {
        backendNodeId: node.backendDOMNodeId,
        role,
        name,
        states,
        ...(!node.isPassword && node.inputKind
          ? { inputKind: node.inputKind, value: node.safeValue }
          : {}),
        ...(node.selectOptions
          ? { selectValue: node.safeValue, selectOptions: node.selectOptions }
          : {}),
      });
      elements.push({
        ref,
        role,
        name,
        states,
        password: node.isPassword === true,
        canType: !node.isPassword && !!node.inputKind,
        ...(node.isPassword || typeof node.safeValue !== "string" ? {} : { value: node.safeValue }),
        ...(node.selectOptions ? { options: node.selectOptions } : {}),
      });
    }
    const states = (node.properties || [])
      .filter(
        (item) =>
          ["checked", "expanded", "disabled", "selected", "level", "required"].includes(
            item.name,
          ) && item.value?.value !== false,
      )
      .map((item) => `${item.name}=${JSON.stringify(item.value?.value)}`)
      .join(" ");
    const value = node.isPassword
      ? " value=[redacted]"
      : typeof node.safeValue === "string"
        ? ` value=${JSON.stringify(node.safeValue)}`
        : "";
    const options = node.selectOptions ? ` options=${JSON.stringify(node.selectOptions)}` : "";
    lines.push(
      `${ref ? `[${ref}] ` : ""}${"  ".repeat(Math.min(depth, 12))}${role}${name ? ` ${JSON.stringify(name)}` : ""}${value}${states ? ` ${states}` : ""}${options}`,
    );
  }
  return {
    text: lines.join("\n"),
    refs,
    nodeCount: lines.length,
    omittedNodes: Math.max(0, retained.length - lines.length),
    elements,
    rootRef,
  };
}
