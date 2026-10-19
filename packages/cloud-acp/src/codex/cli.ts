/**
 * Codex Cloud through the `codex cloud` commands (codex-cli 0.163): `list`,
 * `status`, `diff` and `exec`. The CLI has no command to read a task's
 * conversation, send a follow-up, cancel, or list environments, and its app
 * server exposes no cloud-task methods, so neither does this agent. Parsing is
 * tolerant because `--json` output is not documented.
 */
export const codexTaskUrl = (taskId: string) => `https://chatgpt.com/codex/tasks/${taskId}`;

export interface CodexTask {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly updatedAt: string | undefined;
  readonly url: string;
  readonly environment: string | undefined;
  readonly summary: string | undefined;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const firstString = (record: Record<string, unknown>, keys: ReadonlyArray<string>) => {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return undefined;
};

function statusOf(record: Record<string, unknown>): string {
  const direct = firstString(record, ["status", "task_status", "state"]);
  if (direct) return direct;
  const display = record.task_status_display ?? record.latest_turn_status_display;
  if (isRecord(display)) return firstString(display, ["latest_turn_status", "status"]) ?? "unknown";
  return "unknown";
}

function summaryOf(record: Record<string, unknown>): string | undefined {
  const summary = isRecord(record.summary)
    ? record.summary
    : isRecord(record.diff_stats)
      ? record.diff_stats
      : undefined;
  if (summary === undefined) return undefined;
  const files = summary.files_modified ?? summary.files_changed;
  const added = summary.lines_added;
  const removed = summary.lines_removed;
  if (typeof added !== "number" && typeof files !== "number") return undefined;
  return `${typeof files === "number" ? `${files} files, ` : ""}+${typeof added === "number" ? added : 0} -${typeof removed === "number" ? removed : 0}`;
}

function parseCodexTask(raw: unknown): CodexTask | undefined {
  if (!isRecord(raw)) return undefined;
  const id = firstString(raw, ["id", "task_id"]);
  if (id === undefined) return undefined;
  return {
    id,
    title: firstString(raw, ["title", "name", "prompt"]) ?? "Untitled Codex task",
    status: statusOf(raw),
    updatedAt: firstString(raw, ["updated_at", "updatedAt", "created_at"]),
    url: firstString(raw, ["url", "task_url"]) ?? codexTaskUrl(id),
    environment: firstString(raw, ["environment_label", "environment_id", "environment"]),
    summary: summaryOf(raw),
  };
}

export function parseCodexTaskList(stdout: string): {
  readonly tasks: ReadonlyArray<CodexTask>;
  readonly cursor: string | undefined;
} {
  let body: unknown;
  try {
    body = JSON.parse(stdout);
  } catch {
    return { tasks: [], cursor: undefined };
  }
  const items = Array.isArray(body)
    ? body
    : isRecord(body)
      ? ([body.tasks, body.items, body.data].find(Array.isArray) ?? [])
      : [];
  const cursor = isRecord(body)
    ? firstString(body, ["cursor", "next_cursor", "nextCursor"])
    : undefined;
  return {
    tasks: items.flatMap((item) => {
      const task = parseCodexTask(item);
      return task === undefined ? [] : [task];
    }),
    cursor,
  };
}

/** Codex Cloud task states that will not change on their own. */
export function isTerminalCodexStatus(status: string): boolean {
  return /ready|complete|applied|error|fail|cancel/i.test(status);
}

export function isFailedCodexStatus(status: string): boolean {
  return /error|fail|cancel/i.test(status);
}

/** The status word `codex cloud status` prints, if it printed one. */
export function parseCodexStatusText(stdout: string): string | undefined {
  return /\b(pending|queued|in[ _]progress|running|ready|completed?|applied|error|failed|cancell?ed)\b/i.exec(
    stdout,
  )?.[1];
}

/** The new task's id from `codex cloud exec` output, as an id or a task URL. */
export function parseSubmittedTaskId(stdout: string): string | undefined {
  return (
    /codex\/tasks\/([A-Za-z0-9_-]+)/.exec(stdout)?.[1] ??
    /\b(task_[A-Za-z0-9_-]+)\b/.exec(stdout)?.[1]
  );
}
