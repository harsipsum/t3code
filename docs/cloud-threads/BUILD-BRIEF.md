# Provider cloud threads for T3 Code

Authorized 19 Oct 2026. Build in Claude Code's provider-hosted cloud. This checkout is a fork of pingdotgg/t3code. Keep the laptop out of builds, dependency installation, renders and browser fleets until the finished result is ready for a separate local acceptance run.

## User outcome

Use T3's familiar conversation interface to work with existing Anthropic-hosted Claude Code cloud sessions and OpenAI-hosted Codex Cloud tasks. Work and heavy child jobs stay on provider computers. A remote T3 server on a rented VPS is a different feature and does not satisfy this request.

Keep the things that make T3 useful: smooth text streaming, clear status, queued follow-ups, steering where the provider actually supports it, parent/child context and results, diffs and useful proof. A browser bookmark, a local CLI pretending to be cloud, or mocked task cards alone do not satisfy the goal.

## Starting point and repository safety

- Existing public fork: https://github.com/harsipsum/t3code . Reuse it; do not replace or reset its existing main or branches.
- Base: released nightly v0.1.1-nightly.20261018.3335, upstream commit b72740852ffb5ab727e1ae7c042d9e89533bc341. Base branch in the fork: hars/cloud-base-20261018-3335.
- Work branch: hars/cloud-threads-20261019, or one cloud-generated branch descended from it if the host requires that. Open the final draft PR against the named cloud-base branch so the diff contains our changes, not a week's upstream history.
- Keep the existing native Codex, Claude and ACP integrations intact. Use their extension points. Prefer a separate adapter/package and small registration changes. Do not rebuild T3, rewrite its orchestration, or fork unrelated features. If ACP can deliver the complete experience, use that and document how to install it. If native changes are needed, keep them specific and explain why.
- Read this repository's AGENTS.md and applicable nested instructions first. Do not copy private workstation histories, credentials or client context into this public fork.

## Research before implementation

Reuse the current T3 architecture and inspect complete source with ordinary source tools first. Useful paths at the base revision:

- docs/user/providers-acp.md: local ACP commands and native session listing/import are supported when an agent advertises them.
- docs/user/remote-access.md: remote T3 hosts run agents on that host. This does not automatically enumerate provider cloud sessions.
- docs/internals/adding-a-provider.md and packages/provider-core: integration contracts and honest capability reporting.
- apps/server/src/project/AgentSessionScanner.ts: currently scans local Claude projects JSONL and Codex sessions JSONL.
- apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts: native Codex app-server.
- apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts: Claude Agent SDK.

Study the mechanisms that solve this exact workflow, not every vaguely related tool:

- https://www.cloudroom.dev/docs/cloud-threads
- https://www.cloudroom.dev/docs/subagents
- https://www.cloudroom.dev/docs/teleport
- https://www.cloudroom.dev/docs/harnesses
- https://www.cloudroom.dev/changelog
- https://code.claude.com/docs/en/claude-code-on-the-web
- https://code.claude.com/docs/en/goal
- https://learn.chatgpt.com/docs/developer-commands#codex-cloud
- https://github.com/openai/codex

Cloudroom's older T3 comparison is stale: current T3 already has app-owned nested/cross-provider tasks. Cloudroom's docs disagree about shared versus separate child sandboxes; verify before copying the mechanism. Study queueing, completion delivery, cloud session identity and reconnect, rather than copying its whole infrastructure.

Ship-source REA is useful when public source/docs do not settle a behavior. All REA belongs to GPT-6.1 Sol High if an already-authorized cloud Codex execution route is available. Inspect only the relevant shipped package in the cloud using the REA skill/CLI, retain evidence and release heavy REA servers afterward. Ordinary complete-source inspection does not need REA. Do not start a local Sol worker or request a new subscription just to tick a research box. Record unavailable live targets and continue independent work.

## Critical provider distinction

The user's Codex UI has five newer reusable cloud environments. The installed CLI cloud picker/list exposed only older Legacy environments and one old ready task. Do not silently substitute those older environments or declare the integration complete because codex cloud list returns something. Investigate current documented commands/source and actual environment identity. Preserve both generation paths where needed, or report precisely what the provider does not expose.

Claude --cloud starts provider-hosted work. --remote-control is local work controlled remotely. --teleport makes a local copy and changes the execution location; it does not satisfy cloud persistence.

## Build and acceptance

1. Implement genuine provider-backed list/import/create as exposed by each provider, stable task/session IDs, real remote state and output, and links to the provider's original session. Retrying an import must not create duplicate T3 threads or remote jobs.
2. Follow-ups reach the correct existing hosted session. Stream output where the provider supports it; otherwise show a truthful progress/refresh experience. Mark unsupported live steering, cancel, rewind, fork, local filesystem or approval operations unavailable. Never claim native parity without demonstrating it.
3. Keep cloud authentication in the provider's supported login/credential mechanism. Show actionable signed-out/expired/denied states. Never embed tokens, copy workstation auth files, scrape private browser sessions, expand app grants to all repositories, or run /web-setup. No paid subscriptions, VMs, provider-limit changes or account billing changes.
4. Disconnecting T3 or closing the client must not cancel real cloud work. Reconnect resumes the right conversation, state, result and diff. Do not double-deliver completions or have two writers on the same remote branch.
5. A T3 lead can dispatch an authorized bounded cloud child and receive its completion without a permanent bot or a separate polling daemon per task. Reuse the existing scheduling/event mechanisms. Advertise only capabilities each provider actually has.
6. Use existing T3 visual and interaction patterns for new settings and cloud-task controls. Keep desktop/phone usability, smooth scrolling and existing text-input/queue behavior. Inspect actual rendered views in the cloud, including sign-in and provider-error states. Do not redesign unrelated screens.
7. Run the relevant checks for changed behavior, plus existing required type/build checks. Use existing real-transcript replay tooling where it earns its place. Avoid mirrored tests, broad unchanged-suite repeats and speculative abstractions. Review the diff independently in a fresh cloud context, fix reproduced findings and preserve the proof at the final head.
8. Prove at least one real hosted task/session through list or create, read, follow-up, disconnect/reconnect and actual completion/diff. Report exact provider/version/account access limits. Fixtures are useful regression proof, not a substitute for this live flow. Do not touch unrelated user tasks or run destructive test jobs.

## Finish line

Return a draft PR in the fork with base/head SHAs, concise before/after explanation, relevant check output, real cloud proof, independent review verdict and a reproducible local acceptance checklist. Keep implementation code and claims tied to that head. Do not merge, release or replace the user's running T3. The user will test the separate local build after the cloud work is reviewable.

If a provider credential or missing supported API prevents a live check, finish all independent authorized implementation and checks, then give the exact attempted operation, provider error and remaining action. Never manufacture a successful backend or call a fixture-only build end-to-end complete. Keep a checkpoint on the branch so work can resume without another extraction.

Use one Opus 5.5 High lead. Delegate bounded implementation or REA to Sol High only through a genuine existing cloud route. Do not spawn laptop workers or a broad research fleet. Continue until the verifiable finish line or a concrete exhausted access/provider blocker, rather than returning only a plan.
