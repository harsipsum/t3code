import {
  type CommandHook,
  type CommandHooks as CommandHooksSettings,
  type CommandId,
  type MessageId,
  OrchestrationV2Command,
  type ProjectId,
  type ProviderInstanceId,
  type ResponseStreamingMode,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ProcessRunner from "../processRunner.ts";
import * as ServerSettings from "../serverSettings.ts";

export type AgentDispatchAction = "thread_send" | "thread_create" | "delegate_task" | "queue_edit";

export interface HookThread {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly model: string;
}

export type HookRecipient =
  | ({ readonly kind: "thread" } & HookThread)
  /** A thread this same action creates, so it does not exist yet. */
  | ({ readonly kind: "new_thread" } & HookThread)
  /** The child thread is created together with the task. */
  | {
      readonly kind: "delegated_task";
      readonly parentThreadId: ThreadId;
      readonly projectId: ProjectId;
      readonly title: string | null;
      readonly providerInstanceId: ProviderInstanceId;
      readonly model: string;
    };

export interface AgentDispatchHookInput {
  readonly action: AgentDispatchAction;
  readonly text: string;
  readonly sender: HookThread | null;
  readonly recipients: ReadonlyArray<HookRecipient>;
  /** The command T3 Code commits when the hook allows it. */
  readonly command: OrchestrationV2Command;
}

export interface AssistantReplyHookInput {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly runId: RunId | null;
  readonly messageId: MessageId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly model: string;
  readonly text: string;
  readonly responseStreamingMode: ResponseStreamingMode;
  /** Earlier paragraphs of this reply were already written for clients to show. */
  readonly alreadyVisible: boolean;
}

export class CommandHookBlockedError extends Schema.TaggedError<CommandHookBlockedError>()(
  "CommandHookBlockedError",
  { reason: Schema.String },
) {
  override get message(): string {
    return `Blocked by the agent dispatch hook: ${this.reason}`;
  }
}

type Verdict =
  | { readonly _tag: "allow"; readonly warning: string | undefined }
  | { readonly _tag: "block"; readonly reason: string };

type Configured =
  | { readonly _tag: "off" }
  | { readonly _tag: "on"; readonly hook: CommandHook }
  | { readonly _tag: "unreadable" };

const UNREADABLE_SETTINGS = "T3 Code could not read its hook settings.";
const MAX_HOOK_OUTPUT_BYTES = 64 * 1024;
const MAX_REMEMBERED_ALLOWS = 512;

/**
 * Exit 2 blocks with the hook's own message. Anything else that is not a clean
 * exit 0 (another code, a timeout, a command that cannot start) also blocks, so
 * a broken check never lets everything through unnoticed.
 */
export function verdictForHookResult(
  result: Pick<ProcessRunner.ProcessRunOutput, "stdout" | "stderr" | "code" | "timedOut">,
  timeoutMs: number,
): Verdict {
  const stderr = result.stderr.trim();
  if (result.timedOut) {
    return { _tag: "block", reason: `The hook did not finish within ${timeoutMs} ms.` };
  }
  const code = result.code === null ? null : Number(result.code);
  if (code === 0) return { _tag: "allow", warning: stderr === "" ? undefined : stderr };
  if (code === 2) {
    return { _tag: "block", reason: stderr || result.stdout.trim() || "The hook gave no reason." };
  }
  return {
    _tag: "block",
    reason: `The hook failed with exit code ${code ?? "unknown"}${stderr === "" ? "." : `: ${stderr}`}`,
  };
}

const encodeCommand = Schema.encodeSync(OrchestrationV2Command);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

export interface CommandHooksShape {
  /**
   * Runs the configured agent dispatch hook. An allowed command id and text is
   * not asked again, so a check made before an action's first write covers the
   * dispatch that follows it; a block is never remembered, so a retry asks
   * again. The input is only built when a hook is configured, and None skips
   * the check.
   */
  readonly checkAgentDispatch: <E>(
    commandId: CommandId,
    input: Effect.Effect<Option.Option<AgentDispatchHookInput>, E>,
  ) => Effect.Effect<void, E | CommandHookBlockedError>;
  /** Some(reason) when the configured hook withholds the reply. */
  readonly checkAssistantReply: (
    input: AssistantReplyHookInput,
  ) => Effect.Effect<Option.Option<string>>;
}

export class CommandHooks extends Context.Service<CommandHooks, CommandHooksShape>()(
  "t3/hooks/CommandHooks",
) {}

export const make = Effect.fn("CommandHooks.make")(function* () {
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const allowedDispatches = new Set<string>();
  // A failed settings read (say, of an unrelated secret) must not switch off a
  // configured hook, so it falls back to the last configuration read. Before
  // any read has worked, whether a hook is configured is unknown, so it blocks.
  let lastHooks: CommandHooksSettings | undefined;

  const configured = (name: "agentDispatch" | "assistantReply") =>
    serverSettings.getSettings.pipe(
      Effect.map((settings) => {
        lastHooks = settings.hooks;
        return Option.some(settings.hooks);
      }),
      Effect.catch((error) =>
        Effect.logWarning("command-hook.settings-read-failed", { error }).pipe(
          Effect.as(Option.fromUndefinedOr(lastHooks)),
        ),
      ),
      Effect.map(
        Option.match({
          onNone: (): Configured => ({ _tag: "unreadable" }),
          onSome: (hooks): Configured => {
            const hook = hooks[name];
            return hook === null ? { _tag: "off" } : { _tag: "on", hook };
          },
        }),
      ),
    );
  yield* configured("agentDispatch");

  const run = (name: "agentDispatch" | "assistantReply", hook: CommandHook, payload: object) =>
    processRunner
      .run({
        command: hook.command,
        args: hook.args,
        stdin: encodeJson({ version: 1, hook: name, ...payload }),
        allowUnreadStdin: true,
        timeout: Duration.millis(hook.timeoutMs),
        timeoutBehavior: "timedOutResult",
        maxOutputBytes: MAX_HOOK_OUTPUT_BYTES,
        outputMode: "truncate",
      })
      .pipe(
        Effect.map((result) => verdictForHookResult(result, hook.timeoutMs)),
        Effect.catch((error) =>
          Effect.succeed<Verdict>({
            _tag: "block",
            reason: `The hook could not run: ${error.message}`,
          }),
        ),
        Effect.tap((verdict) =>
          verdict._tag === "block"
            ? Effect.logInfo("command-hook.blocked", { hook: name, reason: verdict.reason })
            : verdict.warning === undefined
              ? Effect.void
              : Effect.logWarning("command-hook.warning", { hook: name, warning: verdict.warning }),
        ),
      );

  const checkAgentDispatch: CommandHooksShape["checkAgentDispatch"] = (commandId, input) =>
    Effect.gen(function* () {
      const hook = yield* configured("agentDispatch");
      if (hook._tag === "off") return;
      const resolved = yield* input;
      if (Option.isNone(resolved)) return;
      if (hook._tag === "unreadable") {
        return yield* new CommandHookBlockedError({ reason: UNREADABLE_SETTINGS });
      }
      // Keyed by the text too: a retry under the same id with other text is asked again.
      const key = `${commandId}\u0000${resolved.value.text}`;
      if (allowedDispatches.has(key)) return;
      const verdict = yield* run("agentDispatch", hook.hook, {
        ...resolved.value,
        commandId,
        command: encodeCommand(resolved.value.command),
      });
      if (verdict._tag === "block") {
        return yield* new CommandHookBlockedError({ reason: verdict.reason });
      }
      if (allowedDispatches.size >= MAX_REMEMBERED_ALLOWS) {
        const oldest = allowedDispatches.values().next().value;
        if (oldest !== undefined) allowedDispatches.delete(oldest);
      }
      allowedDispatches.add(key);
    });

  const checkAssistantReply: CommandHooksShape["checkAssistantReply"] = (input) =>
    Effect.gen(function* () {
      const hook = yield* configured("assistantReply");
      if (hook._tag === "off") return Option.none();
      if (hook._tag === "unreadable") return Option.some(UNREADABLE_SETTINGS);
      const verdict = yield* run("assistantReply", hook.hook, input);
      return verdict._tag === "block" ? Option.some(verdict.reason) : Option.none();
    });

  return CommandHooks.of({ checkAgentDispatch, checkAssistantReply });
});

export const layer = Layer.effect(CommandHooks, make()).pipe(Layer.provide(ProcessRunner.layer));

type ReplyEvent = ProviderAdapter.ProviderAdapterV2Event;

function assistantReply(event: ReplyEvent) {
  if (event.type === "message.updated" && event.message.role === "assistant") {
    return {
      messageId: event.message.id,
      threadId: event.message.threadId,
      runId: event.message.runId,
      text: event.message.text,
      streaming: event.message.streaming,
    };
  }
  if (event.type === "turn_item.updated" && event.turnItem.type === "assistant_message") {
    return {
      messageId: event.turnItem.messageId,
      threadId: event.turnItem.threadId,
      runId: event.turnItem.runId,
      text: event.turnItem.text,
      streaming: event.turnItem.streaming,
    };
  }
  return undefined;
}

export function withheldReplyText(reason: string): string {
  return `Reply withheld by the assistant reply hook: ${reason}`;
}

/**
 * Checks each assistant message once, when its final text arrives and before
 * it is written. Streamed paragraphs written earlier are already visible, so
 * replacing the final text hides them from then on but cannot unsend them.
 */
export function makeAssistantReplyGate(
  check: (reply: {
    readonly messageId: MessageId;
    readonly threadId: ThreadId;
    readonly runId: RunId | null;
    readonly text: string;
    readonly alreadyVisible: boolean;
  }) => Effect.Effect<Option.Option<string>>,
) {
  const streamed = new Set<MessageId>();
  const withheld = new Map<MessageId, Option.Option<string>>();
  return (event: ReplyEvent) =>
    Effect.gen(function* () {
      const reply = assistantReply(event);
      if (reply === undefined) return event;
      if (reply.streaming) {
        streamed.add(reply.messageId);
        return event;
      }
      if (reply.text.trim() === "" && !withheld.has(reply.messageId)) return event;
      let reason = withheld.get(reply.messageId);
      if (reason === undefined) {
        reason = yield* check({
          messageId: reply.messageId,
          threadId: reply.threadId,
          runId: reply.runId,
          text: reply.text,
          alreadyVisible: streamed.has(reply.messageId),
        });
        withheld.set(reply.messageId, reason);
      }
      if (Option.isNone(reason)) return event;
      const text = withheldReplyText(reason.value);
      if (event.type === "message.updated") {
        return { ...event, message: { ...event.message, text, attachments: [] } };
      }
      if (event.type === "turn_item.updated" && event.turnItem.type === "assistant_message") {
        const { attachments: _attachments, ...turnItem } = event.turnItem;
        return { ...event, turnItem: { ...turnItem, text } };
      }
      return event;
    });
}
