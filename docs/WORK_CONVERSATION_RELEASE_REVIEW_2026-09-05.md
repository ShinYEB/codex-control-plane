# Work conversation release review — 2026-09-05

## Evidence and root causes

Inspected the persisted records for `run_eab5f14b-a2a4-4db7-a862-4d4fd1282f8d` read-only. Its terminal result remains failed; this patch does not rewrite history or silently replay it.

1. **Active execution mislabeled failed.** `TurnDispatcher.execute()` throws `TURN_DISPATCH_ACTIVE` after observing an existing running Turn, then its generic catch writes failed. A new regression reproduced exactly `failed` instead of `turn_running`, with zero new submissions. Active observation now preserves dispatch state and is explicitly non-retryable; the task caller defers to reconciliation instead of releasing its execution claim as a failure.
2. **Unclear user contract and undisclosed acceptance requirements.** README described the high-level flow but not the boundaries of acceptance, automatic release, local notification and native navigation confirmation. More importantly, `workContext()` omitted the assigned acceptance criteria while validation still required them. These are now supplied during execution, and README defines the UI and notification boundaries without promising cross-chat delivery.
3. **Evidence lost or misattributed during rework and synthesis.** The document review's final output was only a Git addendum. Downstream consumers received that last output, not its complete revision history. Validators received worker prose and current commands but not the upstream snapshot. The stored synthesis context actually contained all three upstream IDs and terminal states in both revisions (9,082 characters); there is no evidence that the producer omitted those IDs. The synthesis report nevertheless claimed they were absent. The designated test worker reported 8 passing tests; the synthesis worker's different 10-test command must not replace that evidence.

## Changes

- Preserve full task-scoped revision reports and native command evidence in dependency and final synthesis inputs; never consult unrelated historical work.
- Give workers their assigned criteria and a compact registry-derived dependency receipt. Rework must return a complete report, with old and new evidence distinguished.
- Give validators the upstream snapshot persisted with the execution submission, including rejected task identities. Passing commands do not automatically imply an accepted report.
- Document exact automatic start, result destination, notification, structured-output and diagnostic-view limitations.

## Verification and limits

Focused regressions cover active observation without resubmission, full revision retention, explicit criteria, and validator access to upstream evidence. The three requested test files are executed again against the updated tree; this adds a handoff regression to work-conversation tests, so its count differs from the original eight-test run.

Local results: `work-conversation.test.js` 5/5, `user-language.test.js` 2/2, `navigation.test.js` 2/2; each separate command exited 0. The full `node --test` run passed 314/314 with no failures, cancellations or skips. These are local regression results, not a new successful live orchestration claim.

This is not a replay of the live release review. Actual App Server restart/lease races, native panel display and model adherence to the complete synthesis evidence still require live release verification. The previously reported commentary-only output fallback and heuristic synthesis consistency check are separate remaining limitations; this patch does not claim to solve them. Keep release approval separate from regression-test success.
