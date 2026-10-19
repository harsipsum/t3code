# Command hooks

A command hook is a program on the environment that T3 Code asks before an agent's message
leaves its thread, or before an agent's reply is saved. Use one to keep agents from sending
certain text to other threads, or to withhold replies that match a rule. Hooks are off until you
configure one.

## Set up

Hooks are set in the server's `settings.json`, in its `userdata` directory. Clients cannot
change them, because a hook runs a command on the environment. Changes apply without a restart.

```json
{
  "hooks": {
    "agentDispatch": {
      "command": "/usr/local/bin/check-agent-send",
      "args": [],
      "timeoutMs": 10000
    },
    "assistantReply": { "command": "/usr/local/bin/check-agent-reply" }
  }
}
```

`timeoutMs` defaults to 10 seconds and can be up to 120 seconds. Set a hook to `null`, or remove
it, to turn it off.

T3 Code runs the command without a shell and writes one JSON object to its standard input. The
exit code decides what happens:

| Hook result                                                    | What happens                                                                             |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Exit 0 with nothing on stderr                                  | Allowed.                                                                                 |
| Exit 0 with text on stderr                                     | Allowed. The text is written to the server log as a warning.                             |
| Exit 2                                                         | Blocked. The hook's stderr, or its stdout if stderr is empty, is the reason.             |
| Any other exit, a timeout, or a command that cannot be started | Blocked, with the failure as the reason, so a broken hook never lets everything through. |

This example blocks any message or reply that mentions a fictional client:

```js
#!/usr/bin/env node
const event = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
if (/\bExample Corp\b/i.test(event.text)) {
  process.stderr.write("Mentions Example Corp.");
  process.exit(2);
}
```

## Agent dispatch hook

`agentDispatch` checks what an agent sends through T3 Code's tools, before anything is created.
A blocked action creates no message, thread, or delegated task, and the agent's tool call fails
with the hook's reason.

| Agent action                                                 | `action`        |
| ------------------------------------------------------------ | --------------- |
| Send to a thread, in any mode (start, queue, steer, restart) | `thread_send`   |
| Delegate a task                                              | `delegate_task` |
| Create threads or launch a thread with a first message       | `thread_create` |
| Edit a queued message                                        | `queue_edit`    |

The input has `version`, `hook`, `action`, `commandId`, and `text`. It also has `sender` and
`recipients`, the threads involved with their ids, project, title, and provider. `command` is
the exact command T3 Code commits if the hook allows it. With several threads in one
`create_threads` call, each one is checked just before it is created.

These are not checked:

- Messages you send, and the ones T3 Code sends for itself, such as restart continuations and
  delegated task results.
- Anything an agent does outside T3 Code's tools: shell commands, its own MCP connectors and
  subagents, and, for [cloud threads](./cloud-threads.md), the provider's own tools.
- Creating a scheduled task. Each time a scheduled task an agent created runs, its message is
  checked.
- Answers to another thread's questions and moving a queued message into the running turn.

## Assistant reply hook

`assistantReply` checks each assistant message when its final text arrives, before T3 Code saves
it. A blocked reply is saved as "Reply withheld by the assistant reply hook", followed by the
reason, and that is also what a parent thread receives as a delegated task's result. The input
has the thread, project, run, message id, provider, model, and `text`.

With **Response streaming** set to "Wait for the full response", nothing of the reply is shown
before the hook decides. With "Show finished paragraphs", earlier paragraphs are already on
screen; the input's `alreadyVisible` is `true` then, and blocking replaces them only from that
point on. The reply always stays in the provider's own history, so the agent can see it in later
turns, and a cloud thread's reply is already visible on the provider's site.

A reply hook runs once for each assistant message, so a slow hook delays the rest of that turn.
