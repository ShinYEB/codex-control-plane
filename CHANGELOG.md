# Changelog

All notable changes to RUVORA will be documented in this file.

The project follows Semantic Versioning while acknowledging that releases before 1.0 may change public interfaces. Breaking changes still require explicit migration and rollback notes.

## Unreleased

### Changed

- Adopted the RUVORA project identity and canonical GitHub organization.
- Added open-source contribution, governance, support, security, and CI foundations.
- Added `ruvora`, `ruvora-mcp`, and `ruvorad` command names while retaining the legacy command aliases for compatibility.
- Licensed the project under Apache-2.0 and documented release-readiness and roadmap policy.
- Aligned Agent state normalization with the current Codex App Server protocol and made every terminal Task transition release claim ownership atomically.
- Added a repeatable real Codex App Server managed-worktree release gate.
