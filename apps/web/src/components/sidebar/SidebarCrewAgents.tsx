import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { CircleAlertIcon, CircleDashedIcon, ShieldQuestionIcon } from "lucide-react";
import { type MouseEvent as ReactMouseEvent, memo, useState } from "react";

import type { CrewAgent } from "../../crewAgentStore";
import { cn } from "../../lib/utils";
import type { SidebarThreadSummary } from "../../types";
import { useUiStateStore } from "../../uiStateStore";
import {
  hasUnseenCompletion,
  resolveSidebarThreadStatus,
  resolveThreadLastVisitedAt,
} from "../Sidebar.logic";

export interface SidebarCrewAgentEntry {
  readonly agent: CrewAgent;
  /** Null while the thread's environment is offline or the thread was deleted. */
  readonly thread: SidebarThreadSummary | null;
}

function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const letters = words.length > 1 ? words[0]![0]! + words[1]![0]! : (words[0] ?? "?").slice(0, 2);
  return letters.toUpperCase();
}

function CrewAvatar(props: { name: string; avatarUrl: string | null; working: boolean }) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const showImage = props.avatarUrl !== null && props.avatarUrl !== failedUrl;
  return (
    <span className="relative inline-flex size-8 shrink-0">
      {showImage ? (
        <img
          src={props.avatarUrl!}
          alt=""
          draggable={false}
          referrerPolicy="no-referrer"
          onError={() => setFailedUrl(props.avatarUrl)}
          className="size-8 rounded-full object-cover ring-1 ring-border/60"
        />
      ) : (
        <span
          aria-hidden
          className="flex size-8 items-center justify-center rounded-full bg-sidebar-row-active font-medium text-2xs text-secondary-label ring-1 ring-border/60"
        >
          {initialsOf(props.name)}
        </span>
      )}
      {props.working ? (
        <span
          aria-hidden
          className="pointer-events-none absolute -inset-0.5 rounded-full ring-2 ring-info/70 motion-safe:animate-pulse"
        />
      ) : null}
    </span>
  );
}

function previewOf(thread: SidebarThreadSummary | null): string | null {
  const latest = thread?.source.latestVisibleMessage ?? null;
  if (latest === null) return null;
  const text = latest.text.replace(/\s+/g, " ").trim();
  if (text.length === 0) return null;
  return latest.role === "user" ? `You: ${text}` : text;
}

const SidebarCrewAgentRow = memo(function SidebarCrewAgentRow(props: {
  entry: SidebarCrewAgentEntry;
  isActive: boolean;
  onOpen: (event: ReactMouseEvent, threadRef: ScopedThreadRef) => void;
  onContextMenu: (agent: CrewAgent, position: { x: number; y: number }) => void;
}) {
  const { agent, thread } = props.entry;
  const threadKey = scopedThreadKey(agent.threadRef);
  const localLastVisitedAt = useUiStateStore((state) => state.threadLastVisitedAtById[threadKey]);
  const available = thread !== null;
  const status = thread ? resolveSidebarThreadStatus(thread) : null;
  const isUnread =
    thread !== null &&
    hasUnseenCompletion({
      ...thread,
      lastVisitedAt: resolveThreadLastVisitedAt(thread.lastVisitedAt, localLastVisitedAt),
    });
  const preview = available ? previewOf(thread) : "Unavailable while its environment is offline";
  const statusLabel =
    status === "working"
      ? {
          label: "Working",
          icon: <CircleDashedIcon aria-hidden className="size-3.5" />,
          className: "text-info",
        }
      : status === "approval" || status === "input"
        ? {
            label: status === "approval" ? "Approval" : "Input",
            icon: <ShieldQuestionIcon aria-hidden className="size-3.5" />,
            className: "text-warning-foreground",
          }
        : status === "failed" || status === "limited"
          ? {
              label: status === "limited" ? "Limited" : "Failed",
              icon: <CircleAlertIcon aria-hidden className="size-3.5" />,
              className: status === "limited" ? "text-warning" : "text-error",
            }
          : null;

  return (
    <li>
      <button
        type="button"
        data-testid="sidebar-crew-agent-row"
        data-thread-key={threadKey}
        aria-current={props.isActive ? "page" : undefined}
        aria-disabled={!available}
        onClick={(event) => {
          if (available) props.onOpen(event, agent.threadRef);
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          props.onContextMenu(agent, { x: event.clientX, y: event.clientY });
        }}
        onKeyDown={(event) => {
          if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
            event.preventDefault();
            const rect = event.currentTarget.getBoundingClientRect();
            props.onContextMenu(agent, { x: rect.left, y: rect.bottom });
          }
        }}
        className={cn(
          "group/crew-row flex w-full min-w-0 cursor-pointer items-center gap-2.5 rounded-md px-(--sidebar-row-content-inset) py-1.5 text-left outline-none select-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:cursor-default",
          props.isActive
            ? "bg-sidebar-row-active text-sidebar-foreground"
            : "text-sidebar-foreground hover:bg-sidebar-row-hover",
          !available && "opacity-60",
        )}
      >
        <CrewAvatar name={agent.name} avatarUrl={agent.avatarUrl} working={status === "working"} />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className={cn("truncate text-sm", isUnread ? "font-semibold" : "font-medium")}>
              {agent.name}
            </span>
            {agent.role ? (
              <span className="shrink-0 truncate rounded-sm border border-border/70 px-1 text-4xs leading-4 text-secondary-label">
                {agent.role}
              </span>
            ) : null}
            <span className="ml-auto flex shrink-0 items-center gap-1">
              {statusLabel ? (
                <span
                  className={cn(
                    "inline-flex items-center gap-1 text-2xs font-medium",
                    statusLabel.className,
                  )}
                >
                  {statusLabel.icon}
                  <span role="status">{statusLabel.label}</span>
                </span>
              ) : isUnread ? (
                <span aria-label="Unread" className="size-2 rounded-full bg-info" />
              ) : null}
            </span>
          </span>
          {preview ? (
            <span
              className={cn(
                "truncate text-xs",
                isUnread ? "text-sidebar-foreground" : "text-secondary-label",
              )}
            >
              {preview}
            </span>
          ) : null}
        </span>
      </button>
    </li>
  );
});

/**
 * Crew agents sit above the thread list: provider-backed conversations the user
 * treats like contacts (for example an ACP connector to an agent that lives in
 * another app). Rows open the agent's thread; the list below hides them.
 */
export function SidebarCrewAgents(props: {
  entries: ReadonlyArray<SidebarCrewAgentEntry>;
  activeThreadKey: string | null;
  onOpen: (event: ReactMouseEvent, threadRef: ScopedThreadRef) => void;
  onContextMenu: (agent: CrewAgent, position: { x: number; y: number }) => void;
}) {
  if (props.entries.length === 0) return null;
  return (
    <section aria-label="Crew" data-testid="sidebar-crew-agents" className="px-0.5 pt-1 pb-1.5">
      <ul className="flex flex-col gap-px">
        {props.entries.map((entry) => {
          const threadKey = scopedThreadKey(
            scopeThreadRef(entry.agent.threadRef.environmentId, entry.agent.threadRef.threadId),
          );
          return (
            <SidebarCrewAgentRow
              key={threadKey}
              entry={entry}
              isActive={props.activeThreadKey === threadKey}
              onOpen={props.onOpen}
              onContextMenu={props.onContextMenu}
            />
          );
        })}
      </ul>
      <div aria-hidden className="mx-(--sidebar-row-content-inset) mt-1.5 h-px bg-border/60" />
    </section>
  );
}
