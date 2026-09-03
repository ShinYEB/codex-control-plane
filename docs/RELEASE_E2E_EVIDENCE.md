# Release candidate E2E evidence

Date: 2026-09-03  
Candidate commit: `04447e62845e7119f4746f8a3a1a2dbcfb00f608`  
Source: `ruvora/codex-threadhub`, branch `chore/open-source-release-readiness`

## Environment

- Fresh clone under an isolated temporary directory
- Node.js `v24.19.0`
- pnpm `11.19.0`
- Isolated SQLite Registry and Unix socket for daemon smoke verification
- Installed Codex plugin runtime left unchanged

## Results

| Gate | Result | Evidence |
|---|---|---|
| Remote fresh clone | Pass | Candidate branch cloned over HTTPS |
| Reproducible dependency install | Pass | `pnpm install --frozen-lockfile` |
| Syntax and module checks | Pass | `pnpm check` |
| Full automated suite | Pass | 260 tests, 260 passed, 0 failed |
| Daemon startup and health | Pass | health `ok=true`, protocol version `2`, zero active Tasks |
| MCP initialization | Pass | negotiated protocol `2025-06-18` |
| Unauthorized shutdown fence | Pass | rejected with `HANDOVER_AUTHORITY_REQUIRED` |
| Authorized idle shutdown | Pass | daemon stopped and removed socket and lock |
| State isolation | Pass | temporary Registry created; user Registry was not used |

The first harness invocation ran package commands from `/tmp` instead of the cloned repository and failed to locate `package.json`. This was a test-command working-directory error, not a product failure. The same untouched clone passed after the command was run from its repository root.

## Covered product paths

The full suite covers strict contracts, pre-claim rejection, state transitions, retry and repair, Context Snapshots, durable Turn dispatch, dashboard authorization and navigation, managed worktrees, serialized integration, restart recovery, Global Runs, cross-project handoffs, and evidence-based completion.

## Remaining release gate

This run did not reinstall or mutate the active Codex plugin runtime. A packaged-runtime E2E must still verify one real read-only Run, one real managed-worktree Run, embedded dashboard thread navigation, and daemon restart recovery after the release candidate is deployed intentionally.
