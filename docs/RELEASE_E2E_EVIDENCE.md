# Release candidate E2E evidence

Date: 2026-09-03  
Candidate: `v0.14.0`
Source: `ruvora/codex-threadhub`, merge commit `b24e188afb18a69a03e9d22daaa6ba0d2ba70a72`

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

The merged source was revalidated for the release branch with a frozen dependency install, all syntax checks, and the same full result of **262 tests passed, 0 failed**.

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

## Complex real Codex orchestration gate

A second isolated fixture exercised a high-complexity graph through the source control plane:

```text
Orchestrator
  ├─ slug implementation ─────┐
  ├─ word-count implementation ├─ integrated verification
  └─ final synthesis ◀─────────┘
```

Successful Run: `run_7a5b00ac-d080-472b-b6c7-b12c82824b4a`

| Gate | Result | Evidence |
|---|---|---|
| Dispatch classification | Pass | `orchestrated`, high complexity, 3 Tasks, 2 parallel roots, 2 dependencies, 3 roles |
| Master thread | Pass | Orchestrator `01a064da-dee4-7c41-a1c3-b44ee437a1e7` recorded kickoff and final synthesis as normal Codex turns |
| Parallel workers | Pass | Separate slug and word-count Codex threads ran concurrently in separate managed worktrees |
| Independent validation | Pass | Both implementation Tasks and the downstream verification received separate validator acceptance |
| Serialized integration | Pass | Both independent patches were integrated without losing either change |
| A2A handoff | Pass | The downstream worker received both upstream outputs, validation, artifacts, and integration evidence |
| Downstream verification | Pass | Integrated suite: 7 passed, 0 failed; no workspace mutation |
| Final synthesis | Pass | Orchestrator reported the durable Run verdict and named every Data Plane thread |
| Attempt discipline | Pass | All three Tasks completed on attempt 1 |
| Restart persistence | Pass | Reopened Registry retained completed Run, synthesis, Tasks, and released claims |
| Thread navigation surface | Pass | Both Orchestrator and downstream worker were readable as ordinary Codex threads |

The gate exposed one product defect: a newly created Orchestrator had no durable rollout before its first final-synthesis resume. Thread identity alone was insufficient. Provisioning now records a bounded kickoff turn through the durable Turn dispatcher; final synthesis becomes the next orchestration revision in the same native thread.

The gate also confirmed two intended safety behaviors before its successful run:

- a contradictory read-only test contract was rejected before Agent creation or attempt consumption;
- a worker that reported passing tests was still rejected when command evidence or workspace-integrity evidence conflicted with that report.

The repeatable command is `pnpm test:app-server-complex-e2e`. Registry state is kept outside the Git fixture so control-plane persistence cannot be mistaken for a worker workspace mutation.

The first harness invocation ran package commands from `/tmp` instead of the cloned repository and failed to locate `package.json`. This was a test-command working-directory error, not a product failure. The same untouched clone passed after the command was run from its repository root.

## Covered product paths

The full suite covers strict contracts, pre-claim rejection, state transitions, retry and repair, Context Snapshots, durable Turn dispatch, dashboard authorization and navigation, managed worktrees, serialized integration, restart recovery, Global Runs, cross-project handoffs, and evidence-based completion.

## Remaining release boundary

The source-level real Codex gate is complete. Installing the candidate plugin runtime remains an intentional post-merge release action; this evidence does not mutate the user's active runtime. Embedded dashboard navigation and packaged-daemon parity must be rechecked after that controlled deployment.

For the `v0.14.0` release decision, reinstall-dependent verification was explicitly deferred because two live Codex MCP proxy processes still owned the installed plugin cache. The deployment preflight refused removal as designed. The personal plugin source was staged and validated separately, but the installed cache was not replaced; no packaged-runtime result is claimed by this release evidence.
