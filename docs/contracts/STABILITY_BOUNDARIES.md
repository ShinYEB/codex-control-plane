# Execution stability boundaries

## Allocation and capacity

Imported personal threads are observations, not reservations in the managed worker
pool. Planner, control, and Run-orchestrator sessions do not consume the worker
budget. Explicitly managed workers and manually registered specialists do count;
their history is never deleted to manufacture capacity.

Allocation holds a durable, renewable per-workspace lease across selection and
thread registration. Another allocation waits and re-evaluates capacity after the
lease is released. A restart can recover the reservation through lease expiry.
An allocation losing ownership cannot proceed as a successful assignment.

The Router distinguishes a temporarily busy reusable candidate (`wait`) from an
unsatisfiable request (`blocked`). `queueWhenBusy=false` blocks instead of waiting.
Blocked routing is a non-retryable configuration failure with `repair_routing` as
the next action. It does not increase limits, discard history, or silently weaken
requirements. Lease waits retain their initial timestamp and have a bounded
deadline (the task execution timeout, default 30 minutes).

Candidate selection does not truncate at the former 100-thread boundary. Shared
budget state is computed once per routing decision rather than per candidate.
Provider incompatibility is a hard exclusion. An eligible idle candidate may be
used when the highest-scoring candidate is busy and no fork capacity exists.

## Planner and dependency contract

Planner output tool identifiers are `shell` and `filesystem`, not host-specific
API aliases or prose. A2A is daemon-managed context delivery, not a worker plugin
capability. This baseline does not authorize browser or external connector tools;
those require an explicitly implemented and verified capability extension.

Every terminal Task status comes from the central state definition, including SQL
eligibility, claim eligibility, and upstream handoff selection. A policy-blocked,
integration-blocked, or recovery-attention producer must not strand an
`all_terminal` report or `on_failure` consumer.

## Completion evidence

`taskKind=test` requires actual test-command evidence. Mentioning tests in review
criteria does not change execution intent. Implementation/review acceptance still
passes through validation; a test task should be explicit when execution is a
mandatory machine-checked gate.

Named report outputs are substantive nonempty strings or objects in the final
JSON `outputs` map. Empty containers, booleans, and numbers are not reports.
File/artifact output names cannot be satisfied by agent assertions: they require
verified output evidence with source and content hash. Until a particular artifact
producer supplies this evidence, rejection is intentional, not inferred success.
Workspace-change/patch/commit outputs continue to use integration evidence.

A shared workspace diff alone does not identify its author. Unexpected changes
therefore produce non-retryable attention and `inspect_side_effects`, not automatic
rework attributed to the worker. This does not approve or revert the change.

## Recovery and presentation

Live execution and recovery use the same final-answer extractor. Progress
commentary is not concatenated into the machine-readable final output. Validators
receive daemon-captured command items and distinguish executable path spelling
from changes to arguments or working directory.

Lease-renewal loss requests interruption of the owned turn. Failure to interrupt
must remain observable; no automatic safe-replay assumption is made. Expired
recovered dispatches enter recovery attention. Terminal records retain provenance.

Routing wait reason, capacity, and next action are projected into both graph and
dashboard records. A Run's `running` status is its lifecycle, not proof that a
Worker is executing: active/waiting counts and node state are authoritative.

## Release gates

- `node --test`: deterministic state, schema, routing, completion and recovery tests.
- `node scripts/release-complex-app-server-e2e.mjs`: real worktree/integration gate.
- `node scripts/release-control-request-e2e.mjs`: real natural-language public-entry
  gate with 120 imported threads, three independent workers, dependent synthesis,
  unchanged fixture checkout and durable reopen checks.

The public-entry gate uses a separate temporary project and registry, and retains
its evidence. A unit-test pass must never be reported as a live release-gate pass.
Existing production Runs with old contracts are not rewritten or replayed by an
upgrade; they need explicit, scope-preserving repair or a new verification request.

### Verified run (2026-09-05)

The public-entry gate completed Run `run_c9172927-0f74-43d7-9166-1701a68f6710`:
four tasks completed, including real test-command evidence and dependent report
synthesis; checkout stayed unchanged and the completed Run survived DB reopen.
An earlier attempt exposed commentary contamination and executable-path validation
errors; those failures were retained, fixed, and covered by the final-answer
regression test. This gate does not claim that every historical production contract
or host UI behavior has been revalidated.
