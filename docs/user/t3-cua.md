# Open Harness CUA in T3 Code

Open Harness CUA connects Chrome and Windows tools to any MCP-capable harness.
This page covers its optional T3 Code integration. For standalone clients and Hermes,
use [the package README](../../packages/computer-use/README.md).

This fork starts from T3 Code nightly `v0.0.46-nightly.20261011.2994`.
Build with `vp i` and `vp run build:desktop`, then run `node scripts/start-t3-cua.mjs`.
On Windows, `scripts/start-t3-cua.ps1` opens the app without a terminal window.
The fork keeps its T3 state, Codex account and Electron browser profile in this checkout's ignored `.t3` directory.

Install this fork's supported Codex runtime with `node scripts/install-cua-codex.mjs`.
It pins Codex 0.162.1 in `.t3/codex-runtime`, without upgrading the global CLI.
For the GPT-5.6 Luna Low benchmark, run `node scripts/t3-cua-profile.mjs --luna` once.
It checks your signed-in Codex catalog, copies the account into this fork's local home and adds
**GPT-5.6 Luna Low** in the app. It does not change your normal Codex configuration.

## DeepSeek Flash

Open **Settings > Providers > DeepSeek Flash**. Under **Environment variables**, enter your
`DEEPSEEK_API_KEY`, keep it marked sensitive, save and refresh the provider.
Select **DeepSeek Flash** for a new thread. Reasoning choices are Low, High and Max.
The current API ID is `deepseek-flash`, which DeepSeek routes to V4.1 Flash.
This uses [DeepSeek's Responses integration](https://api-docs.deepseek.com/quick_start/agent_integrations/codex/)
through Codex's agent runtime; your normal Codex account and configuration stay separate.

T3's in-app browser tools and this fork's Chrome and Windows tools use MCP.
GPT-5.6 Luna Low has completed a live call through the computer bridge.
The DeepSeek account setup is experimental: its model transport is configured, but a live
DeepSeek tool call has not been verified. Codex 0.155 can send namespaced tool definitions,
so API function-call support alone does not prove this route works.

## Chrome and saved sessions

In **chrome://extensions**, turn on Developer mode, select **Load unpacked** and choose
this checkout's `apps/chrome-extension` folder. Open PowerShell in the checkout folder and
install the extension's local connector once:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File packages/computer-use/install-host.ps1 -ExtensionId imnnjncafjnhhebhjkaoiobegpjahnhb
```

Start a T3 thread with Open Harness CUA enabled, reopen the **Open Harness CUA** popup,
and choose **Allow this tab** on the site you want to use. The agent can inspect and
operate only allowed Chrome tabs. The popup's **First-time setup (Windows)** repeats
the install command; [the package README](../../packages/computer-use/README.md) has
copyable setup examples for other MCP clients and Hermes.

Choose **Save this site's session locally** in the extension to copy that site's cookies. In T3, open
**Settings > Integrations > Browser profiles > Add profile > Chrome (extension snapshot)**.
Review the named source, domains and capture time, then import into a new or existing profile.
Open T3's in-app browser with that profile to use its cookie-based sign-ins.
Chrome remains signed in. Passwords, localStorage and IndexedDB are not copied; sites relying
on those stores may require signing in again. Partitioned and expired cookies are reported as skipped.

The imported cookies belong to the desktop browser profile. Keep the desktop app open with
the matching profile. A tab that falls back to T3's separate server browser does not inherit
the desktop's cookies. The controlled import and a fresh agent-created tab have passed with
the desktop visible, including a saved screenshot and a live Luna Low tool call.

Session export files contain sign-in credentials and stay in `.t3/computer-use`.
Delete `chrome-session.json` after import when you no longer need the export.

## Windows apps

The computer tools list windows, inspect an explicitly selected window and return a screenshot
with accessibility text where available. Select the app before sending mouse or keyboard input.
The tools act on your desktop, so keep the target app visible while the agent works.
