/** Emit values only after the caller verifies a non-password DOM input type. */
export function projectSnapshot(nodes, maxNodes = 500) {
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
      (name || containers.has(role) || node.isPassword || typeof node.safeValue === "string");
    if (keep) retained.push({ node, depth, role, name });
    const next = keep ? [...ancestors, { name, safeValue: node.safeValue }] : ancestors;
    for (const childId of node.childIds || []) {
      const child = byId.get(childId);
      if (child) visit(child, depth + (keep ? 1 : 0), next);
    }
  }
  for (const node of nodes) if (!node.nodeId || !children.has(node.nodeId)) visit(node);
  for (const node of nodes) visit(node);
  const refs = new Map();
  const lines = [];
  for (const { node, depth, role, name } of retained.slice(0, maxNodes)) {
    let ref = "";
    if (node.backendDOMNodeId) {
      ref = `e${refs.size + 1}`;
      refs.set(ref, { backendNodeId: node.backendDOMNodeId, role, name });
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
  };
}
