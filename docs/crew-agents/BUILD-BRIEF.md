# Crew agents pinned in T3 Code (T3 side only)

Authorized by Hamza, 19 Oct 2026, with full access for this run. You are Claude Opus 5.5 (high), lead for UI/UX and the T3 integration. Frontend quality is yours end to end; do not hand UI work to another model.

Repo: https://github.com/harsipsum/t3code (public fork of pingdotgg/t3code). Branch: `hars/crew-agents-20261019` (already pushed, based on `hars/cloud-base-20261018-3335` = upstream b727408, the nightly Hamza runs). Do not touch other branches, especially `claude/provider-cloud-threads-oucuyg` (another active writer). Final: draft PR into `hars/cloud-base-20261018-3335`. Never merge.

## Outcome

Hamza's crew agents (Light, who lives in the ChatGPT/Codex desktop app, and Groku, who lives in the Grok Bot desktop app) sit pinned at the TOP of T3's sidebar, above the project threads, and work like native T3 conversations. Sync is 1:1: the same conversation, not a copy. A message typed in the ChatGPT or Grok Bot app shows up in T3 live, and a message sent from T3 shows up in those apps. Each agent's cloud computer can be watched in a T3 right panel.

## Architecture (decided; do not redesign)

- Each agent connects as a **Local ACP command provider** (see docs/user/providers-acp.md). The connectors (`light-acp`, `groku-acp`) are built separately in a private repo. They are NOT in this repo, and no private API details of OpenAI/xAI go into this public fork.
- The connectors advertise ACP session listing/import, prompt and streaming `session/update`. T3's existing deterministic native-session import gives one T3 thread per remote conversation.
- This branch adds only what T3 lacks. Keep the diff small and generic (not hard-coded to Light/Groku) so nightly upstream rebases stay painless.

## Build

A. **Pinned agents section at the top of the sidebar.** Any provider-backed thread can be pinned as an agent, with avatar image, display name, role chip, last-message preview, unread dot and working/idle state. Reference: Grok Bot's left list (avatar, name, small role chip, one-line preview) but in T3's own visual language. Store pins in existing T3 settings/client state. Clicking opens the normal ChatView. Reorder by drag if the existing sidebar drag logic makes that cheap; otherwise skip it. Collapsed-sidebar and phone layouts must work.

B. **Out-of-turn live sync.** When the user talks to the agent in its own app, the connector emits ACP `session/update` notifications while no T3 turn is running (user message chunks and agent message chunks, with stable message IDs in `_meta`). Find how the ACP adapter in apps/server (orchestration-v2) currently treats notifications outside an active prompt, and make T3 append them to the thread live, streaming text included. Dedupe by message ID so a T3-sent message echoed back by the remote is not shown twice. On thread open or reconnect, re-sync through `session/load` when advertised, idempotently. Keep T3 queue/steer behavior intact for T3-originated turns.

C. **Agent computer panel.** If the agent advertises a computer viewer through ACP `_meta["t3/computer"] = { url, title, state: "asleep" | "connecting" | "live" | "error", message? }` (on session/new or session/load results, or in a `session/update`), show a "Computer" tab in the existing right-panel system (where the Device/Preview panels live). Render the URL in the existing preview/webview mechanism. Asleep/connecting/error states get calm T3-style empty states (Grok Bot's "Computer is asleep" card is the reference for tone). No URL means no tab.

D. **Turn origin labels.** Agents also get invoked from elsewhere (e.g. Groku answering a public X @mention, Light running scheduled sub-agent tasks). If a user-role update carries `_meta["t3/origin"] = { label, url? }`, render a small origin label on that turn instead of presenting it as Hamza typing.

E. **Fake ACP agent fixture.** Add a tiny Node ACP agent under the existing test fixtures that emulates: session list/load with history, out-of-turn user + agent updates, echo dedupe, `t3/computer` states and `t3/origin`. Use it for focused tests and rendered screenshots. No real provider calls.

## Quality bar

- Reuse existing components, tokens and motion. Smooth scrolling and streaming, no layout jank. Check desktop and phone renders (390x844) in the cloud browser, including empty, asleep, error and signed-out states. Make the screenshots part of the PR.
- Run typecheck, lint and the focused tests for what changed. No mirrored or redundant test suites.
- Read the repo AGENTS.md first and follow it. No secrets, no workstation data, no Hamza personal content in the public repo. Avatars come from the user's pin settings, not committed images of his bots.
- Commit checkpoints to the branch as you go. Finish with a draft PR: base/head SHAs, before/after, check output, screenshots and a short "how a connector plugs in" note (the exact ACP `_meta` keys and notification shapes) so the private connectors can target it.
