# Release candidate E2E evidence

Date: 2026-09-03  
Candidate: PR #3 (`chore/open-source-release-readiness`)
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

The suite was rerun after the App Server compatibility fixes: **262 tests passed, 0 failed**.

## Real Codex App Server gate

The candidate source was exercised directly against the Codex binary bundled with the desktop app (`codex-cli 0.151.0-alpha.7.2`). The installed ThreadHub plugin runtime was neither invoked nor modified.

| Gate | Result | Evidence |
|---|---|---|
| Real read-only Codex turn | Pass | Native thread `01a064bd-4f67-74a0-b8d1-66c2435e2c87` completed with hydrated terminal evidence |
| Real managed-worktree mutation | Pass | Task `task_48fa9cf3-ebdf-473e-9b22-69066b5854b0` changed only `math.js` |
| Real command evidence | Pass | Native worker ran Node test: 1 passed, 0 failed |
| Independent validation | Pass | Validator decision `accept` for both acceptance criteria |
| Patch integration | Pass | Artifact integrated into the destination fixture and its postcondition test passed |
| Completion Gate | Pass | Decision `accept`; no missing or conflicting evidence |
| Retry discipline | Pass | Completed in attempt 1 |
| Restart persistence | Pass | Registry reopened with Task still `completed` and all completion evidence intact |
| Claim cleanup | Pass | Reopened terminal Task had null worker, claim token, and heartbeat ownership fields |
| Native thread history | Pass | Worker thread `01a064c9-e116-7122-a5e8-716b95e88ffb` is readable as a normal Codex thread with commentary, commands, file change, test result, and final answer |

The repeatable manual gate is `pnpm test:app-server-e2e`. It creates an isolated failing Git fixture, dispatches a real Codex worker and validator through the source control plane, checks integration and completion evidence, reopens the Registry, and removes the fixture only after success.

### Defects discovered by the real gate

1. Current App Server thread status uses `active` and `activeFlags`; the domain boundary previously rejected it. Status normalization now maps the current protocol into the internal state machine.
2. A validator can start after the shared validation Agent has returned to `idle`; the legitimate `idle -> validating` transition is now explicit.
3. Successful terminal paths retained claim ownership even though failure paths released it. Every direct terminal claim transition now clears worker, token, and heartbeat atomically.

All three defects have regression coverage and the same real managed-worktree scenario passed after the fixes.

The first harness invocation ran package commands from `/tmp` instead of the cloned repository and failed to locate `package.json`. This was a test-command working-directory error, not a product failure. The same untouched clone passed after the command was run from its repository root.

## Covered product paths

The full suite covers strict contracts, pre-claim rejection, state transitions, retry and repair, Context Snapshots, durable Turn dispatch, dashboard authorization and navigation, managed worktrees, serialized integration, restart recovery, Global Runs, cross-project handoffs, and evidence-based completion.

## Remaining release boundary

The source-level real Codex gate is complete. Installing the candidate plugin runtime remains an intentional post-merge release action; this evidence does not mutate the user's active runtime. Embedded dashboard navigation and packaged-daemon parity must be rechecked after that controlled deployment.
