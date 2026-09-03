# RUVORA Governance

## Source of truth

The `main` branch of `github.com/ruvora/codex-threadhub` is the source of truth for code, contracts, documentation, and releases.

English is the authoritative project language. The future `github.com/ruvora/codex-threadhub-ko` repository will be a Korean localization of completed RUVORA Codex ThreadHub releases, not an independent code or design fork. Its release commits must identify the exact upstream commit they translate.

## Roles

- Maintainers set project direction, review contracts, manage releases, and hold merge authority.
- Contributors propose changes through issues and pull requests.
- Automated agents may create branches, commits, checks, and pull requests, but they do not hold merge authority.

## Decision process

Small, reversible changes are decided through pull-request review. Changes to public contracts, authorization, persistence, state machines, recovery, integration, or compatibility require an ADR or an explicit contract update in the same pull request.

The repository owner currently makes the final merge decision. Passing automation is necessary evidence, not permission to merge.

## Compatibility

RUVORA is pre-1.0. Breaking changes may occur, but they must be documented with migration and rollback guidance. Existing external identifiers should remain as compatibility aliases for at least one release unless retaining them would violate a security boundary.
