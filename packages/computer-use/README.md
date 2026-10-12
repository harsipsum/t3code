# Open Harness CUA

Open Harness CUA is a local stdio MCP server, an original Chrome extension/native
host, and Windows window-targeted input. It connects to any MCP-capable harness.
Its optional T3 integration uses T3's separate `preview_*` in-app browser tools.

No npm dependency or new system runtime is required. Node 24 and Windows'
existing PowerShell/.NET Framework provide the local host. Other operating
systems can use the Chrome extension after supplying an equivalent native host
launcher; native desktop tools currently require Windows.

## Run

Add the MCP server to your client, then start that client. For clients that use
`mcpServers` JSON, copy this and replace `C:/path/to/checkout` with the absolute
checkout path. If Node is installed elsewhere, replace its command path too:

```json
{
  "mcpServers": {
    "open_harness_cua": {
      "command": "C:/Program Files/nodejs/node.exe",
      "args": ["C:/path/to/checkout/packages/computer-use/src/server.mjs"],
      "env": {
        "OPEN_HARNESS_CUA_HOME": "C:/path/to/checkout/.t3/computer-use"
      }
    }
  }
}
```

Use the same absolute `OPEN_HARNESS_CUA_HOME` for the client and native host, and
for the desktop instance when using T3's importer. The fork's launcher configures this server in its isolated
Codex home automatically. The standalone MCP server can also be run from the
checkout root with `node packages/computer-use/src/server.mjs`; a plain terminal
launch waits for MCP input and does not provide an interactive command prompt.

For Chrome, first open `chrome://extensions`, enable Developer mode, choose
**Load unpacked**, and select the checkout's `apps/chrome-extension` folder.
Its committed public key gives the stable ID `imnnjncafjnhhebhjkaoiobegpjahnhb`.

Next, open PowerShell in the checkout root and install its native host once:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File packages/computer-use/install-host.ps1 -ExtensionId imnnjncafjnhhebhjkaoiobegpjahnhb
```

The installer uses `OPEN_HARNESS_CUA_HOME` from PowerShell, or the checkout's
existing `.t3/computer-use` default. For a custom client home, pass the same absolute
folder with `-HomeDir`; an explicit argument takes precedence.

The installer writes only the selected home and
`HKCU\Software\Google\Chrome\NativeMessagingHosts\dev.t3code.cua`. It refuses to
overwrite a registration pointing to another installation's home. `-SkipRegistration`
compiles the launcher and manifest without changing Chrome's registry.

Start your configured MCP client so the local bridge is running.
Open an HTTP(S) page, reopen **Open Harness CUA**, and choose **Allow this tab**. Its
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

## Saved sessions and optional T3 import

Use **Save this site's session locally**. Chrome asks for cookie access for the
current site. The extension saves applicable host and parent-domain cookies to
`OPEN_HARNESS_CUA_HOME/chrome-session.json`, retaining Chrome's exact cookie fields.
T3's browser-profile importer can read that file. Cookie values never enter MCP tool
results or diagnostic logs. Once the popup grants permission, the current-site
`chrome_export_session` tool can refresh the same export. All-sites export is a
separate explicit popup action and permission request. Local storage is not
included in this first version; a site relying on it may need a fresh login.

Session JSON, bridge credentials and screenshots stay in the ignored `.t3`
directory. Export replaces the latest session snapshot in that selected home.
Keep it private; do not commit it, print it or send it to a model.

## Text-only models and Windows

`chrome_snapshot` reads the whole document rather than just the scrolled viewport.
On long pages, provide `query` to search current accessible names before the output
limit. Matches include their complete containing row, form or dialog. Search reports
multiple contexts and omitted whole contexts explicitly; refine the query or increase
`maxNodes` when needed. Returned refs always belong to the new snapshot.

Snapshots return text by default. Ordinary form fields include their current
values when the DOM confirms a non-password type; password and unidentified
field values are omitted/redacted. Screenshots save a local PNG path. Set
`includeImage: true` only for an image-capable model.

Call `computer_windows` first, then pass its exact identity-bound `windowId` to
native snapshot/click/type/key/scroll tools. `computer_click` and `computer_scroll` default to absolute
desktop pixels. Pass `coordinateSpace: "window"` when x/y come from the window
screenshot, whose top-left is (0, 0). The helper translates these using the selected
window's fresh bounds and rejects points outside it. Scroll without x/y uses the window
center. Other windows and the clipboard
are not implicit targets.

Set `OPEN_HARNESS_CUA_BROWSER_ONLY=1` to remove all native computer tools from
the MCP catalog and dispatch. This lets a browser agent run while someone is
using the laptop.

## Hermes

This stdio server also works in Hermes's own model/tool loop. In an isolated
Hermes profile with its account/model already configured, add this to `config.yaml`.
Replace `C:/path/to/checkout` with your absolute checkout path and keep your existing
account settings:

```yaml
mcp_servers:
  open_harness_cua:
    command: C:/Program Files/nodejs/node.exe
    args:
      - C:/path/to/checkout/packages/computer-use/src/server.mjs
    env:
      OPEN_HARNESS_CUA_HOME: C:/path/to/checkout/.t3/computer-use
    timeout: 45
```

Start Hermes using that isolated profile. On Windows, for example:

```powershell
$env:HERMES_HOME = "C:/path/to/isolated-hermes-profile"
hermes.cmd chat -t open_harness_cua -m gpt-5.6-luna --reasoning low --ignore-rules
```

For browser-only tasks, add `OPEN_HARNESS_CUA_BROWSER_ONLY: '1'` under that server's
`env` block. Leave it unset to include the Windows tools as well.

Use `-t open_harness_cua`, the configured server name, on the Hermes CLI. Its
startup filter matches that name before discovery registers the
`mcp-open_harness_cua` alias. A prefixed selector can therefore prevent startup.
`--ignore-rules` excludes local instructions without removing the MCP config.
Select the model and effort explicitly, such as `-m gpt-5.6-luna --reasoning low`.

## Existing installations

The product and MCP server are now `Open Harness CUA` / `open-harness-cua`.
New examples use the client configuration key `open_harness_cua`; remove the old
entry when renaming that key so the client does not start duplicate servers.
Old client keys can continue pointing to the same server.

`OPEN_HARNESS_CUA_HOME` and `OPEN_HARNESS_CUA_BROWSER_ONLY` take precedence over
`T3_COMPUTER_USE_HOME` and `T3_COMPUTER_USE_BROWSER_ONLY` when defined. Likewise,
each `OPEN_HARNESS_CUA_DECISION_*` setting falls back to its matching
`T3_DECISION_MODEL_*` name. Explicit new `0` disables a flag even if the old name
is `1`. An empty new home uses the unchanged checkout default.

The stable extension ID, native-host wire name `dev.t3code.cua`, launcher filename
and `.t3/computer-use` state path are historical compatibility identifiers. The
rename does not move saved sessions or require a second native-host registration.

## Optional local action chooser

This experiment is disabled by default. It requires a separately running local
decision model exposing the typed `/v1/systemone` API, such as a compatible
llama.cpp build with Clef. Add these values to the MCP server's environment:

```yaml
OPEN_HARNESS_CUA_DECISION_ENABLED: "1"
OPEN_HARNESS_CUA_DECISION_URL: http://127.0.0.1:8767/v1/systemone
OPEN_HARNESS_CUA_DECISION_ID: clef-flash
```

The measured Windows runtime uses the official [llama.cpp b11429 release](https://github.com/ggml-org/llama.cpp/releases/tag/b11429)
with its matching CUDA 13.4 runtime DLL archive, and [Clef-Flash Q4_K_M weights](https://huggingface.co/ggml-org/Clef-Flash-GGUF/tree/6b4fe4c59098479652d94f0fe11a40facbebd1ec).
Verify the published download hashes and extract the server and matching DLLs together.
For a compatible NVIDIA GPU, replace these absolute paths and keep the server running:

```powershell
& 'C:/path/to/llama-server.exe' -m 'C:/path/to/Clef-Flash-Q4_K_M.gguf' -ngl all -c 2048 -b 2048 -ub 2048 -np 1 --load-mode none --cache-ram 0 --ctx-checkpoints 0 --host 127.0.0.1 --port 8767 --alias clef-flash
```

This is a text-only decision runtime with the genuine Clef head. Its context and
physical batch must fit the complete prompt; a character budget does not guarantee
token fit. Loading it successfully does not establish faster end-to-end computer use.
Keep it resident only when its measured memory and latency suit the machine.

This exposes `chrome_act`. Give it the approved `tabId`, a precise subtask `intent`,
and optional `textSlots` containing `{id, field, text}`. The planner supplies exact
text; the local chooser selects only actions and current targets. It observes after
each action and returns to the planner after four steps by default (`maxSteps`, up
to eight), uncertainty, stale state, timeout or a context budget limit. The planner
must verify the final saved outcome. Existing direct tools remain available.

For a larger page, first read `chrome_snapshot`, then provide `scope: {ref, snapshotId}`
for one row, dialog, form, listitem, menu, group or region. The chooser receives the
complete current contents of that container and explicitly excludes outside content.
The container must retain its original DOM identity and role on the approved site.
An internal continuation survives the routine's own public-ref invalidation and child
value changes; a detached or replaced container returns control rather than widening
to the page. Whole-page observation is still the default.

Only click, exact supplied text and existing native-select options are currently
delegated. Password fields are excluded. Large/partial observations return control
instead of silently dropping candidate actions. The endpoint accepts loopback HTTP
only; there is no remote-model fallback. The routine has a 30-second deadline by
default (`deadlineMs`, at most 60 seconds). Cancellation removes queued input.

`OPEN_HARNESS_CUA_DECISION_MAX_STATE_CHARS` bounds the entire decision payload (default
6000), `OPEN_HARNESS_CUA_DECISION_MAX_CANDIDATES` bounds its action menu (default 24), and
`OPEN_HARNESS_CUA_DECISION_MIN_CONFIDENCE` sets the abstention threshold (default 0.6).
The response records decision/action timings, supplied model token usage and the
fresh final observation. These controls do not claim a speed or quality advantage;
measure model memory, latency and real task outcomes before enabling it routinely.

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
