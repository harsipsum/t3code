import type { OrchestrationV2SyncStatus } from "@t3tools/contracts";

export function AgentSyncNotice({ status }: { status: OrchestrationV2SyncStatus | null }) {
  if (
    !status ||
    (status.state === "live" && !status.readOnly && !status.partial && !status.message)
  )
    return null;
  const stateMessage =
    status.state === "live"
      ? "Connected to the agent."
      : status.state === "cached"
        ? "Showing saved history. Live updates are unavailable."
        : status.state === "disconnected"
          ? "The agent connection was lost. Reconnecting."
          : status.state === "needs_reload"
            ? "The agent changed this conversation. History needs to reload."
            : status.state === "error"
              ? "The agent could not sync this conversation."
              : "Connecting to the agent.";
  return (
    <div
      role="status"
      className="border-b px-4 py-2 text-xs text-secondary-label"
      data-agent-sync-status={status.state}
    >
      {status.message ?? stateMessage}
      {status.readOnly ? " Read only. Open the provider app to send." : ""}
      {status.partial && status.state !== "cached" ? " Some older messages are not loaded." : ""}
    </div>
  );
}
