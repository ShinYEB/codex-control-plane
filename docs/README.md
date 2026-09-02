# Design documentation index

This directory is the design baseline for the **current implementation** of RUVORA `0.14.0`. Behavior that is not implemented must be marked explicitly as `Proposed` or `Needs review`.

## Suggested reading order

1. [Product Direction](./PRODUCT_DIRECTION.md) — origin, product definition, current direction, and target structure
2. [Architecture](./ARCHITECTURE.md) — system boundaries, three-plane ownership, and core invariants
3. [Terminology](./TERMINOLOGY.md) — canonical terms for threads, sessions, Runs, and Tasks
4. [ADR-001](./adr/ADR-001-CONTEXT-SOURCE-OF-TRUTH.md) — context authority and provenance
5. [ADR-002](./adr/ADR-002-GLOBAL-RUN-HIERARCHY.md) — multi-project execution hierarchy
6. [ADR-003](./adr/ADR-003-THREAD-LIFECYCLE.md) — thread creation, reuse, compaction, and archive policy
7. [ADR-004](./adr/ADR-004-RESULT-AUTHORITY.md) — Orchestrator, Synthesizer, and visible result authority
8. [ADR-005](./adr/ADR-005-AUTOMATIC-RUN-START.md) — one user authorization and automatic start after graph validation
9. [ADR-007](./adr/ADR-007-DURABLE-TURN-DISPATCH.md) — durable thread acquisition, command submission, and recovery
10. [ADR-008](./adr/ADR-008-EVIDENCE-BASED-COMPLETION.md) — success based on execution evidence rather than Agent prose
11. [Execution Flow](./contracts/EXECUTION_FLOW_CONTRACT.md) — stage gates and evidence from request to result access
12. [Turn Dispatch](./contracts/TURN_DISPATCH.md) — TurnDispatch state, durable fields, cancellation, and restart decisions
13. [Completion Gate](./contracts/COMPLETION_GATE.md) — one decision over Turn, command, output, workspace, validation, and integration evidence
14. [Context Resolution](./contracts/CONTEXT_RESOLUTION.md) — knowledge collection, authority, conflicts, and snapshots
15. [Contract Authority](./contracts/CONTRACT_AUTHORITY.md) — manifests, authority, revisions, and pre-execution conflict rejection
16. [Global Runs](./contracts/GLOBAL_RUNS.md) — Global Run state, authority, and cross-project dependencies
17. [Target Persistence](./contracts/TARGET_PERSISTENCE.md) — goal schemas, atomicity, migration, and compatibility
18. [State Machines](./contracts/STATE_MACHINES.md) — Run, Task, Agent, and Lease states and transitions
19. [Execution Contract](./contracts/EXECUTION_CONTRACT.md) — authority, sandbox, workspace, and side-effect contracts
20. [Persistence](./contracts/PERSISTENCE.md) — SQLite ownership, atomicity, idempotency, and storage model
21. [Result Delivery](./contracts/RESULT_DELIVERY.md) — result projection, notifications, and work-thread access
22. [Failure Recovery](./operations/FAILURE_RECOVERY.md) — failure classes, retry, restart recovery, and worktree recovery
23. [Runtime Lifecycle](./operations/RUNTIME_LIFECYCLE.md) — runtime identity, daemon handover, deployment, and reinstall
24. [Stabilization Gate](./STABILIZATION_GATE.md) — final E2E evidence for stabilization stages 1–8
25. [Global Orchestration Gate](./GLOBAL_ORCHESTRATION_GATE.md) — implementation order and final E2E gate
26. [G7 E2E Evidence](./G7_E2E_EVIDENCE.md) — automated evidence for the final twelve scenarios
27. [Review Checklist](./REVIEW_CHECKLIST.md) — decisions required at the next design review

## Authority and change rules

- These documents provide a human-reviewable baseline for current behavior.
- Code is evidence of current behavior when code and documentation disagree, but the discrepancy is a defect that must be resolved explicitly.
- Changes to authority or state transitions must update the relevant contract document and tests in the same change.
- Compatibility fields use canonical terms in prose; persisted and public API names are not renamed casually.
- The root `README.md` owns product introduction and usage. This directory owns detailed design.
- `PRODUCT_DIRECTION.md` is authoritative for product purpose and priorities. Accepted decisions live under `adr/`.

## Implementation traceability

| Design area | Primary implementation | Primary verification |
|---|---|---|
| Request intake and graph preparation | `src/mcp-server.js`, `src/planner-engine.js` | MCP and Planner tests |
| Execution contracts | `src/execution-contracts.js` | execution-contract tests |
| State and atomic claims | `src/registry.js`, `src/run-controller.js` | Registry and Run Controller tests |
| Routing and Agent leases | `src/router.js`, `src/mcp-server.js` | routing, Registry, and MCP tests |
| Durable Turn Dispatch | Turn dispatcher, domain states, Registry schema v8 | dispatch, migration, MCP, and dashboard tests |
| Validation and completion | result validator and completion evaluator | validation, evidence, and integration tests |
| Worktrees and integration | `src/worktree-manager.js` | worktree and recovery tests |
| Result access and notification | dashboard model, MCP server, notification policy | dashboard, MCP, and notification tests |
| Daemon and runtime generation | daemon, client, and build identity | daemon and reinstall-preflight tests |
| Context Resolution | context claims, snapshots, resolver, and thread knowledge | context and routing tests |
| Global Run core | global state, project graph, dependencies, cancellation, recovery | global-run and MCP tests |
| Cross-project handoff | authorization manifests, evidence hashes, and receipts | global-run, Registry, and MCP tests |
| Thread lifecycle | lifecycle projection, versioned budgets, routing, archive fencing | lifecycle and routing tests |

Record untraced or inconsistent behavior in [Review Checklist](./REVIEW_CHECKLIST.md).
