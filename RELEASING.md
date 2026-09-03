# Release process

Only a maintainer may publish a RUVORA Codex ThreadHub release. Automation produces evidence; it does not grant release authority.

## Release requirements

- The release commit is on protected `main`.
- Node.js 22 and 24 CI checks pass.
- `pnpm check` and the full `pnpm test` suite pass from a clean checkout.
- The package version and `CHANGELOG.md` agree.
- Public contract changes include migration and rollback guidance.
- No unresolved configuration, recovery, integration, or security blocker remains.
- Documentation describes the behavior of the release commit rather than an unimplemented target.

## Prepare a release

1. Create a focused release branch from current `main`.
2. Move relevant `Unreleased` changelog entries under the target version and release date.
3. Update the package version without publishing to npm.
4. Run:

   ```bash
   pnpm install --frozen-lockfile
   pnpm check
   pnpm test
   git diff --check
   ```

5. Verify a fresh clone, daemon startup, one read-only Run, one managed-worktree Run, dashboard navigation, and restart recovery.
   Run the real Codex App Server managed-worktree gate with `pnpm test:app-server-e2e`; this is a manual release gate and is not part of normal CI.
6. Open a pull request containing the exact evidence and known limitations.
7. Let the maintainer review and merge. Do not enable automatic merge.

## Publish

1. Create an annotated tag matching the package version, for example `v0.15.0`.
2. Push the tag only after the release commit is on `main`.
3. Create a GitHub Release from that tag using the matching changelog section.
4. Mark pre-1.0 releases as prereleases unless the maintainer explicitly promotes them.
5. Attach distributable artifacts only when their build and checksum process is reproducible.

## Localization

The Korean repository is created only after the first public release is complete. Each localized release must record its upstream repository, version, and exact commit SHA. Translation-only commits must not change runtime behavior.

## Rollback

If release verification fails after tagging, do not move or reuse the tag. Document the failed release, fix the defect through a new pull request, and publish a new patch version. Runtime deployment and rollback follow `docs/operations/RUNTIME_LIFECYCLE.md`.
