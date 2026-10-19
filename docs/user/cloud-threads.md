# Cloud threads

A cloud thread is a T3 Code thread whose agent runs on the provider's computers instead of your
environment: a [Claude Code cloud session](https://code.claude.com/docs/en/claude-code-on-the-web)
or a Codex Cloud task. The work keeps running when you close T3 Code or your laptop, and you can
open the same session on claude.ai or chatgpt.com. This is different from
[remote access](./remote-access.md), where agents run on a T3 Code server you host.

## Set up

1. Install the provider's CLI on the environment and keep it signed in with the account that owns
   the cloud sessions: Claude Code with a claude.ai login, or the Codex CLI with ChatGPT.
2. Open **Settings → Providers → Add provider → Local ACP command**.
3. Set **Executable** to `t3` and add the arguments `cloud-acp` and `claude` (or `codex`). The
   desktop app installs `t3` from **Settings → General → About**.
4. Use the provider's **Sign in** button if it reports that it is not signed in. Sign-in runs
   `claude auth login` or `codex login --device-auth` in a terminal on the environment; T3 Code
   never stores the login. Claude needs a claude.ai login with cloud sessions; a token from
   `claude setup-token` cannot reach them.

## Use

- **Start:** a new thread on the provider sends its first message as a new cloud task for the
  project's GitHub `origin` at the current branch. Push local commits first; the cloud clones
  GitHub, not your checkout.
- **Import:** expand the provider's card in **Settings → Providers**, choose the project, and
  select **List sessions**. Claude sessions are listed for the project's repository. Importing
  one again opens the same thread.
- **Catch up:** an imported thread shows the cloud history before its first reply. Send `/sync`
  at any time to see what the cloud session did since T3 Code last showed it, without sending it
  anything. After T3 Code restarts, its automatic "Continue where you left off" message does the
  same instead of starting new cloud work.
- **Delegate:** a lead thread can hand a task to the cloud provider with T3 Code's delegation
  tools. The child thread waits on the cloud task, and the lead hears back when it ends.
- **Result:** when a turn ends, the thread shows the diff of the branch the cloud session pushed,
  or the Codex task's diff. Create the pull request or apply the task from the provider's page,
  which every thread links to.

## Provider differences

|                         | Claude Code cloud                                                                        | Codex Cloud                                                                     |
| ----------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Streaming               | Live text, tool calls and results                                                        | Status checked every 10 seconds                                                 |
| Follow-ups              | Sent to the same session; queued while a turn runs                                       | Not available: continue on chatgpt.com                                          |
| Stop                    | Interrupts the cloud turn                                                                | Stops T3 Code's wait only; the task keeps running                               |
| Approvals and questions | Answer them on claude.ai                                                                 | Not applicable                                                                  |
| Environment             | Claude Code's `remote.defaultEnvironmentId` setting, else your default cloud environment | Set `CODEX_CLOUD_ENV` in the provider's variables to an environment id or label |

Codex Cloud is reached through the `codex cloud` commands, which have no follow-up, cancel, or
transcript command. They resolve `CODEX_CLOUD_ENV` against the environments the CLI lists, which
may not include environments created in the newer ChatGPT environment settings.

Cloud sessions cannot use T3 Code's MCP tools, image attachments, or your environment's files,
and checkpoint rollback does not rewind them.
