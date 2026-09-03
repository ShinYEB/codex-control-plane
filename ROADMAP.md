# RUVORA Codex ThreadHub roadmap

This roadmap communicates direction, not a promise of dates. Contract safety, durable recovery, and evidence-based completion take priority over feature count.

## Current baseline — `0.14.x`

- Durable Run, Task, Agent, Lease, TurnDispatch, and integration state
- Strict versioned execution contracts with pre-claim validation
- Fingerprinted retry and repair rules
- Context Claims and immutable Context Snapshots
- Master Worker navigation and Master Orchestrator → Slave Worker graphs
- Multi-project Global Runs and validated artifact handoffs
- Crash-safe worktree integration and daemon recovery
- Node.js 22 and 24 CI coverage

## First public release readiness

- [x] Public organization repository and stable project identity
- [x] Apache-2.0 license
- [x] Contribution, governance, security, and support policies
- [x] Pull-request and required-check protection for `main`
- [ ] English source-of-truth contract and operations documentation
- [x] Clean-install verification from a fresh clone
- [ ] First-run and dashboard navigation E2E on the packaged runtime
- [ ] Versioned GitHub release with checksums and release notes

## After the first public release

- Publish a release-matched Korean localization in `ruvora/codex-threadhub-ko`
- Stabilize the public execution-contract and dashboard schemas
- Document a supported compatibility matrix for Codex Desktop and App Server generations
- Add contributor-focused fixtures for routing, recovery, and multi-project handoff scenarios
- Evaluate package distribution only after install, upgrade, and rollback contracts are stable

## Non-goals

- Replacing Codex Desktop or Codex App Server
- Treating Planner prose or role names as execution authority
- Automatic merge or destructive external actions without explicit user authority
- Allowing localization repositories to diverge into independent implementations

Track concrete work in GitHub Issues. Any roadmap item that changes authority, state transitions, persistence, retry, recovery, or integration must include the corresponding contract and test changes.
