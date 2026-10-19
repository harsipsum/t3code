import {
  type CommandHook,
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
  /** The child thread is created with the task; its id is not known before. */
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
  readonly runId: RunId;
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

const MAX_HOOK_OUTPUT_BYTES = 64 * 1024;
const MAX_REMEMBERED_DISPATCHES = 512;

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
   * Runs the configured agent dispatch hook once per command id, so a check made
   * before an action's first write covers the dispatch that follows it. The
   * input is only built when a hook is configured.
   */
  readonly checkAgentDispatch: <E>(
    commandId: CommandId,
    input: Effect.Effect<AgentDispatchHookInput, E>,
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
  const dispatchVerdicts = new Map<CommandId, Verdict>();

  const configured = (name: "agentDispatch" | "assistantReply") =>
    serverSettings.getSettings.pipe(
      Effect.map((settings) => Option.fromNullishOr(settings.hooks[name])),
      Effect.orElseSucceed(() => Option.none<CommandHook>()),
    );

  const run = (name: "agentDispatch" | "assistantReply", hook: CommandHook, payload: object) =>
    processRunner
      .run({
        command: hook.command,
        args: hook.args,
        stdin: encodeJson({ version: 1, hook: name, ...payload }),
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
      if (Option.isNone(hook)) return;
      let verdict = dispatchVerdicts.get(commandId);
      if (verdict === undefined) {
        const resolved = yield* input;
        verdict = yield* run("agentDispatch", hook.value, {
          ...resolved,
          commandId,
          command: encodeCommand(resolved.command),
        });
        if (dispatchVerdicts.size >= MAX_REMEMBERED_DISPATCHES) {
          const oldest = dispatchVerdicts.keys().next().value;
          if (oldest !== undefined) dispatchVerdicts.delete(oldest);
        }
        dispatchVerdicts.set(commandId, verdict);
      }
      if (verdict._tag === "block") {
        return yield* new CommandHookBlockedError({ reason: verdict.reason });
      }
    });

  const checkAssistantReply: CommandHooksShape["checkAssistantReply"] = (input) =>
    Effect.gen(function* () {
      const hook = yield* configured("assistantReply");
      if (Option.isNone(hook)) return Option.none();
      const verdict = yield* run("assistantReply", hook.value, input);
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
      text: event.message.text,
      streaming: event.message.streaming,
    };
  }
  if (event.type === "turn_item.updated" && event.turnItem.type === "assistant_message") {
    return {
      messageId: event.turnItem.messageId,
      threadId: event.turnItem.threadId,
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
