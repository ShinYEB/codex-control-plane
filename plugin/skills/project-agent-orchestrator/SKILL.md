---
name: project-agent-orchestrator
description: Run ordinary work requests automatically and show concise progress with a work link. Open detailed dashboards only on explicit request.
---

# Thread-first orchestration

## Native navigation

Never emit `codex://threads/...` Markdown links or construct a replacement URL.
They are not verified Desktop navigation. `master.navigation` is a host-tool
handoff, not a hyperlink. For “결과 보기/열어줘” or an explicit work selection,
call the available `navigate_to_codex_page` host tool with that exact threadId.
Confirm opening only when it returns `navigated: true`. A status-only request
does not authorize switching the current page: report status and say the result
can be opened on request, without a fake clickable link.
Dashboard button messages request navigation in this calling conversation only;
never forward a prompt to the destination worker or start/retry work.
If host navigation is unavailable, explain the limitation instead of claiming
success. Message delivery or OS URL acceptance is not navigation confirmation.

## User language

Users make ordinary requests; never ask them to choose an execution mode or learn
the internal hierarchy. In normal replies, do not expose master, slave, node,
Run, Orchestrator, Control Plane, Data Plane, daemon, role names or raw status codes.
Use the user's language: “작업을 시작했습니다”, “진행 중 · 4개 중 3개 완료”,
“완료했습니다”. Label links “작업 열기” or “결과 보기”, never “마스터 작업 열기”.
Technical response keys such as `master` are implementation details, not copy to
repeat to users. A preparing request has been received, not already executed.
Do not claim completion until the stored status proves it. Failures need a plain
explanation and a concrete next action; never conceal a failed or blocked result.
In requested detail views use “전체 작업” and “하위 작업”. Explain technical
components only on an explicit technical diagnostics or architecture request.

1. For a request to begin delegated work, call `dispatch_control_request` once with the objective and project cwd. The daemon plans and starts automatically; never create READY placeholders or ask for another Start.
2. Acknowledge the work name and status briefly. Do not open a dashboard after dispatch. A null master means preparation, not failure; never fabricate a thread link.
3. For progress, completion, results, or current work, use `get_work_status`. Show work name, status and `progress.succeeded` as successful completion, with nonzero rejected/failed/attention/cancelled/skipped counts separately. `finished` counts all terminal tasks, including unsuccessful ones: never label it completed or successful. Warnings are a subset of succeeded. Keep `needsAttention` visible even while other work is running. `observedAt` is a snapshot timestamp, not proof that execution is alive. Use real host navigation on request, not a fabricated link. Do not add a conversation polling loop.
4. Simple work opens its actual worker; complex work opens its actual master Orchestrator. Use the returned real thread ID with host navigation tools when the user asks to open it. Navigation never sends a prompt, retries work, or creates a turn.
5. If the user asks to pin a master, use available host sidebar pinning tools. Report unsupported/failed pinning honestly; it must never block execution. Never pin every subordinate worker automatically.
6. Only when explicitly asked for a dashboard, dependency graph, or detailed diagnostics, call `show_agent_dashboard` once, scoped to the selected Run when known. Prefer embedded presentation; use web only as a requested or necessary fallback.

The daemon is the sole writer of managed sessions. Active sessions are observation-only while leased. Do not introduce a second App Server writer. Worker results are aggregated durably and synthesized in the master, not appended automatically to the origin conversation.

Inspect/status requests do not authorize new Runs. Do not use this plugin to modify itself. The compact status and detailed dashboard are projections of the same registry; neither can start work or change its outcome. Failure, cancellation, recovery and integration attention must never be represented as success. Retained worktree artifacts must not be discarded automatically.
