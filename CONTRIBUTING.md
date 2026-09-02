# Contributing to RUVORA

Thank you for helping improve RUVORA.

## Before opening a change

- Search existing issues and pull requests.
- Open an issue before making a large behavioral or architectural change.
- Treat the documents under `docs/contracts/` as executable product contracts.
- Do not weaken authorization, state-transition, evidence, retry, recovery, or integration invariants without an explicit design decision.

## Development

Requirements:

- Node.js 22 or later
- pnpm 10

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm test
```

## Pull requests

- Create a focused branch from `main`.
- Include tests for behavioral changes and failure paths.
- Update contracts or ADRs when externally observable behavior changes.
- Describe verification evidence in the pull request.
- Do not commit credentials, runtime state, worktrees, or private Codex transcripts.
- Write source-of-truth documentation and user-facing defaults in English. Korean localization belongs in the release-matched `ruvora-ko` repository after it is created.

Maintainers merge changes only after the required checks pass. A pull request is not authority to widen filesystem, network, side-effect, or integration scope.
