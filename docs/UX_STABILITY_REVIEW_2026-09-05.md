# UX and stability improvements — 2026-09-05

## Implemented boundaries

- Test evidence is checked using a shared command interpreter: direct executables, supported Node flags and App Server's single-command shell transport. Echoed text and arbitrary script wrappers do not prove child test execution. Unknown exit codes or unavailable test receipts require inspection, not automatic replay.
- A later successful identical test command in the same explicit working directory may supersede an earlier failed test in the same Turn. Other targets and side-effect commands remain failures; native history is never rewritten.
- Explicit commentary cannot replace a final answer. Unphased legacy responses retain compatibility.
- Uncertain dispatches can record matching terminal read receipts with evidence and cancellation fencing. Previous failures remain in evidence. Bounded background probes never resubmit work or reopen already terminal Tasks/Runs without their acceptance/integration gates.
- Execution-stage attention verdicts remain `recovery_attention` in both live and recovery paths. Their worktrees are retained and claims released.
- The compact panel exposes the representative result link, brief descriptions, named dependency arrows and next-step guidance. Diagnostics are collapsed, invalid task links hidden, and refresh preserves task/link nodes and expanded sections.
- Restart/expiry instructions explain how to request a fresh scoped panel. Read tokens cannot renew privileges themselves.

## Verification

- Initial boundary tests reproduced four failures before implementation.
- Full local suite: 323 passed, zero failures/skips/cancellations.
- Real scheduled App Server E2E passed: implementation, test, validation, worktree integration, natural conversation transport, one attempt and released claim after DB reopen.
- The first complex E2E exposed the native `/bin/zsh -lc` serialization boundary. Its tests actually passed 10/10, but execution evidence was not recognized. A regression now covers the observed shell format; reevaluation of the retained receipt accepts it without modifying history.
- Fresh complex App Server E2E passed after the correction: three tasks, one attempt each, two integrated worktrees, dependency handoff, completed synthesis and durable state after DB reopen. Run: `run_590ddfd9-dab2-4043-8895-f2a62c7259ab`.
- Plugin manifest validation passed using an isolated temporary PyYAML dependency; no project or global Python environment was changed.
- In-app browser UI fixture verified the top result link, ordinary action guidance and collapsed diagnostics. Expanded diagnostics and focus remain present after refresh. Dependency projection and stable link identity are also covered by automated tests.

## Deliberate limits

- Arbitrary Python/JavaScript wrappers require separately observed native child receipts. Do not infer success from their output prose.
- Late execution completion is not Task acceptance or integration approval. Already terminal Tasks/Runs remain available for explicit review instead of silent resurrection.
- Host sidebar pinning was reported unsupported by the tested App Server build. It does not block execution.
- Task link rendering/click submission is not proof of native navigation; host-specific navigation still needs confirmation.
- These checks do not establish long-duration service availability or exhaustive real-process crash coverage. Existing integration crash-boundary regressions remain part of the suite.
