---
name: project-agent-orchestrator
description: Orchestrate Codex work through the single daemon and show minimal master-thread links and progress. Open detailed dashboards only on explicit request.
---

# Thread-first orchestration

1. For a request to begin delegated work, call `dispatch_control_request` once with the objective and project cwd. The daemon plans and starts automatically; never create READY placeholders or ask for another Start.
2. Acknowledge the work name and status briefly. Do not open a dashboard after dispatch. A null master means preparation, not failure; never fabricate a thread link.
3. For progress, completion, results, or current work, use `get_work_status`. Show only work name, status, finished/total, and the returned master thread link. Show cause and next action only when attention is needed. Do not add a conversation polling loop.
4. Simple work opens its actual worker; complex work opens its actual master Orchestrator. Use the returned real thread ID with host navigation tools when the user asks to open it. Navigation never sends a prompt, retries work, or creates a turn.
5. If the user asks to pin a master, use available host sidebar pinning tools. Report unsupported/failed pinning honestly; it must never block execution. Never pin every subordinate worker automatically.
6. Only when explicitly asked for a dashboard, dependency graph, or detailed diagnostics, call `show_agent_dashboard` once, scoped to the selected Run when known. Prefer embedded presentation; use web only as a requested or necessary fallback.

The daemon is the sole writer of managed sessions. Active sessions are observation-only while leased. Do not introduce a second App Server writer. Worker results are aggregated durably and synthesized in the master, not appended automatically to the origin conversation.

Inspect/status requests do not authorize new Runs. Do not use this plugin to modify itself. The compact status and detailed dashboard are projections of the same registry; neither can start work or change its outcome. Failure, cancellation, recovery and integration attention must never be represented as success. Retained worktree artifacts must not be discarded automatically.
