# T3 computer use

This fork adds a local stdio MCP server, an original Chrome extension/native host,
and Windows window-targeted input. T3's existing `preview_*` tools provide the
in-app browser; this package does not replace that browser.

No npm dependency or new system runtime is required. Node 24 and Windows'
existing PowerShell/.NET Framework provide the local host. Other operating
systems can use the Chrome extension after supplying an equivalent native host
launcher; native desktop tools currently require Windows.

## Run

Add the MCP server to your client, then start that client. For clients that use
`mcpServers` JSON, copy this and replace `C:/path/to/t3code` with the absolute
checkout path. If Node is installed elsewhere, replace its command path too:

```json
{
  "mcpServers": {
    "t3_computer_use": {
      "command": "C:/Program Files/nodejs/node.exe",
      "args": ["C:/path/to/t3code/packages/computer-use/src/server.mjs"],
      "env": {
        "T3_COMPUTER_USE_HOME": "C:/path/to/t3code/.t3/computer-use"
      }
    }
  }
}
```

Use the same absolute `T3_COMPUTER_USE_HOME` for the client, native host and T3
desktop instance. The fork's launcher configures this server in its isolated
Codex home automatically. The standalone MCP server can also be run from the
checkout root with `node packages/computer-use/src/server.mjs`; a plain terminal
launch waits for MCP input and does not provide an interactive command prompt.

For Chrome, first open `chrome://extensions`, enable Developer mode, choose
**Load unpacked**, and select the checkout's `apps/chrome-extension` folder.
Its committed public key gives the stable ID `imnnjncafjnhhebhjkaoiobegpjahnhb`.

Next, open PowerShell in the checkout root and install its native host once:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File packages/computer-use/install-host.ps1 -ExtensionId imnnjncafjnhhebhjkaoiobegpjahnhb -HomeDir "$PWD\.t3\computer-use"
```

The installer writes only the selected home and
`HKCU\Software\Google\Chrome\NativeMessagingHosts\dev.t3code.cua`. It refuses to
overwrite a registration pointing to another T3 home. `-SkipRegistration`
compiles the launcher and manifest without changing Chrome's registry.

Start a T3 thread or your configured MCP client so the local bridge is running.
Open an HTTP(S) page, reopen **T3 Browser**, and choose **Allow this tab**. Its
**First-time setup (Windows)** shows the same install command. If it still reports
disconnected, check that the client and installer use the same computer-use home.
The Chrome debugging banner remains visible. Access ends when the tab leaves its
approved origin. **Revoke this tab**, closing the banner, or disconnecting the
native host removes control. The agent gets accessibility text and element refs
from `chrome_snapshot`, then uses those refs for trusted click/type actions.
Expired queued commands are discarded, and old snapshot refs are refused.
Snapshots keep table/form hierarchy and omit repeated text. Native HTML selects
use `chrome_select` with one exact value or label. Custom comboboxes still use
click/key actions. Screenshots capture a viewport clip without selecting another
tab and fail after five seconds, releasing that tab's command queue.

Cancellation removes queued actions and stops before the next input when a
command has already been delivered. It cannot undo an input already applied.
The Windows helper stops its captured PowerShell process on cancellation.

## Signed-in session import

Use **Save this site's session for T3**. Chrome asks for cookie access for the
current site. The extension saves applicable host and parent-domain cookies to
`T3_COMPUTER_USE_HOME/chrome-session.json`, retaining Chrome's exact cookie fields.
T3's browser-profile import reads that file. Cookie values never enter MCP tool
results or diagnostic logs. Once the popup grants permission, the current-site
`chrome_export_session` tool can refresh the same export. All-sites export is a
separate explicit popup action and permission request. Local storage is not
included in this first version; a site relying on it may need a fresh login.

Session JSON, bridge credentials and screenshots stay in the ignored `.t3`
directory. Export replaces the latest session snapshot in that selected home.
Keep it private; do not commit it, print it or send it to a model.

## Text-only models and Windows

Snapshots return text by default. Ordinary form fields include their current
values when the DOM confirms a non-password type; password and unidentified
field values are omitted/redacted. Screenshots save a local PNG path. Set
`includeImage: true` only for an image-capable model.

Call `computer_windows` first, then pass its exact identity-bound `windowId` to
native snapshot/click/type/key/scroll tools. Absolute desktop coordinates must
lie within that selected window. Other windows and the clipboard are not
implicit targets.

Set `T3_COMPUTER_USE_BROWSER_ONLY=1` to remove all native computer tools from
the MCP catalog and dispatch. This lets a browser agent run while someone is
using the laptop.

## Hermes

This stdio server also works in Hermes's own model/tool loop. In an isolated
Hermes profile with its account/model already configured, add this to `config.yaml`.
Replace `C:/path/to/t3code` with your absolute checkout path and keep your existing
account settings:

```yaml
mcp_servers:
  t3_computer_use:
    command: C:/Program Files/nodejs/node.exe
    args:
      - C:/path/to/t3code/packages/computer-use/src/server.mjs
    env:
      T3_COMPUTER_USE_HOME: C:/path/to/t3code/.t3/computer-use
    timeout: 45
```

Start Hermes using that isolated profile. On Windows, for example:

```powershell
$env:HERMES_HOME = "C:/path/to/isolated-hermes-profile"
hermes.cmd chat -t t3_computer_use -m gpt-5.6-luna --reasoning low --ignore-rules
```

For browser-only tasks, add `T3_COMPUTER_USE_BROWSER_ONLY: '1'` under that server's
`env` block. Leave it unset to include the Windows tools as well.

Use `-t t3_computer_use`, the configured server name, on the Hermes CLI. Its
startup filter matches that name before discovery registers the
`mcp-t3_computer_use` alias. A prefixed selector can therefore prevent startup.
`--ignore-rules` excludes local instructions without removing the MCP config.
Select the model and effort explicitly, such as `-m gpt-5.6-luna --reasoning low`.

## Proof and provenance

```powershell
node --test packages/computer-use/test/bridge.test.mjs
```

The focused checks use the actual framed native host and broker, verify private
session export, stale disconnects and expired queued mutations, and check
password redaction. They do not claim a live Chrome connection.

REA 6.4.0 static analysis of the shipped Chrome installer exposed the useful
mechanism: a stdio native host, an extension-origin allow list, local runtime
configuration, and a Windows native-host registry entry. Evidence ID:
`ev_66afc0f01fd91ba2d362a2ad87365ee51b57d97e662a27934727b0fc627157e0`.
This package implements that pattern in original code using documented
[Chrome native messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)
and the [Chrome debugger API](https://developer.chrome.com/docs/extensions/reference/api/debugger).
It does not redistribute the inspected code. A further REA browser-client
analysis was partial due to its semantic worker's heap limit and is not used
as proof of the current proprietary runtime.

REA also analyzed this package's native host and Chrome worker as inert code.
Following its function/queue map exposed an initial-connect failure that never
entered the reconnect loop, and a screenshot await that could block later tab
commands after the caller timed out. The host now recovers when started before
its broker; screenshot waits are bounded. Evidence IDs:
`ev_ec9d3952da9a91c57dc4f0112ec2a6e838b5b5a22b4a354deb086092a041dfcc`
and `ev_090c0c31edb96365fdad7da0ac8c51afb06a94f60e3bc6051e06cac771db6c9a`.
Those findings combine REA's static observations with source reasoning and
focused runtime checks.

This first bridge has no Chrome tab creation/switching, cross-origin task grant,
coordinate click, upload/download or local-storage session transfer tool. The
existing T3 preview browser has its own separate tools. Successful local tasks
do not establish complete parity with Codex's browser or Windows tools.
