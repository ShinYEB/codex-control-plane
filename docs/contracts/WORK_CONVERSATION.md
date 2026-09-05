# Work conversation

The user-facing work thread is an execution record, not a protocol console.

## Input boundary

- The native user message contains the assigned work request. Preserve explicit user constraints; never sanitize arbitrary user text with keyword removal.
- Planner-generated requests use the user's language and describe the goal, scope and deliverables. Acceptance criteria remain structured separately.
- App Server `turn/start.additionalContext` carries application policy, runtime information and project constraints outside the user message. Reference memories, dependency results and review feedback are explicitly untrusted data.
- Historical task-result memories and reusable-agent summaries are not injected into execution context. Current dependencies are supplied from the durable graph, not from a general memory search. This does not erase existing thread history.
- The dispatch stores the complete additional context and its fingerprint. Changing context cannot reuse the same explicit dispatch revision. Context-bearing submissions use `clientUserMessageId` for uncertain-submission recovery; matching the same visible prose alone is insufficient.
- Context transport errors remain execution errors. Never retry without the policy or silently append it to the user message. Compatibility was checked against the installed App Server; older versions require their own compatibility gate.

## Output boundary

- Ordinary `report` and workspace outputs use a natural-language final answer: outcome, files, actual verification and remaining limitations. They do not require a JSON `outputs` envelope.
- Native commands, exit codes, workspace artifacts, acceptance validation and integration receipts retain their existing completion gates. Fluent prose alone is not proof that tests ran or files changed.
- Compatibility exception: custom named outputs still require their existing structured JSON response for downstream consumers. A separate structured-report transport is not implemented in this change. The planner should prefer `report` unless a named interface is actually needed.
- Complex work starts with the actual objective and a concise plan explanation. Aggregation inputs travel as reference context, and the final answer is readable prose consistent with durable status.
- Existing conversations are not rewritten. Per-turn context does not guarantee that every host conceals context in all diagnostic views. Native UI display must be tested separately from transport shape.

## Progress projection

`get_work_status.progress.succeeded` counts only completed and completed-with-warnings tasks. `warnings` is a subset of succeeded. `finished` is retained for compatibility and counts all terminal tasks, including rejection, failure, cancellation and skips; never label it successful completion. Rejected, failed, cancelled, skipped, attention, active, waiting and unknown counts remain separate. `needsAttention` can be true while the durable Run is still running.

`observedAt` records when the snapshot was read, not worker liveness. `lastUpdatedAt` is the latest stored Run/Task update, not proof that a command is making progress. Transport freshness and execution health must not be conflated.

This projection does not insert or refresh content inside an existing work conversation. The currently integrated MCP UI is associated with the calling tool result; an automatic cross-conversation inline surface has not been verified. Do not describe status projection alone as a live embedded work monitor, and do not start extra model turns merely to refresh a counter. A task-side panel is a different presentation requiring an explicit product choice.

## Verification gates

Regression tests cover natural reports versus strict named outputs, preserved execution evidence, upstream and rework transport, context fingerprints and native request separation. The App Server release E2E asserts the actual persisted user message, a non-envelope final answer, a real code fix, passing tests, acceptance validation and integration.

Run `npm run test:work-conversation-e2e` to exercise the scheduled worker path rather than only foreground execution. It creates an isolated fixture, never modifies the product repository, and retains failed fixtures for diagnosis.
