import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { canonicalizeProjectIdentity, PROJECT_IDENTITY_VERSION } from "../src/project-identity.js";

function git(args) {
  return execFileSync(process.env.CODEX_GIT_BIN ?? "git", args, { encoding: "utf8" }).trim();
}

function createRepository() {
  const directory = mkdtempSync(join(tmpdir(), "codex-project-identity-"));
  const repository = join(directory, "repository");
  mkdirSync(repository);
  git(["-C", repository, "init", "-q"]);
  git(["-C", repository, "config", "user.email", "control-plane@example.invalid"]);
  git(["-C", repository, "config", "user.name", "Control Plane Test"]);
  writeFileSync(join(repository, "README.md"), "identity\n");
  git(["-C", repository, "add", "README.md"]);
  git(["-C", repository, "commit", "-qm", "initial"]);
  return { directory, repository };
}

test("canonical project identity converges for a git root, nested cwd, symlink, and worktree", () => {
  const { directory, repository } = createRepository();
  try {
    const nested = join(repository, "packages", "app");
    mkdirSync(nested, { recursive: true });
    const symlink = join(directory, "repository-link");
    symlinkSync(repository, symlink, "dir");
    const worktree = join(directory, "worktree");
    git(["-C", repository, "worktree", "add", "-qb", "identity-worktree", worktree]);

    const identities = [repository, nested, symlink, worktree].map((cwd) => canonicalizeProjectIdentity(cwd));
    assert.equal(new Set(identities.map((identity) => identity.id)).size, 1);
    assert.equal(new Set(identities.map((identity) => identity.canonicalKey)).size, 1);
    assert.ok(identities.every((identity) => identity.kind === "git"));
    assert.ok(identities.every((identity) => identity.identityVersion === PROJECT_IDENTITY_VERSION));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("non-git directories remain separate canonical projects", () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-directory-identity-"));
  try {
    const first = join(directory, "first");
    const second = join(directory, "second");
    mkdirSync(first);
    mkdirSync(second);
    const firstIdentity = canonicalizeProjectIdentity(first);
    const repeated = canonicalizeProjectIdentity(first);
    const secondIdentity = canonicalizeProjectIdentity(second);
    assert.equal(firstIdentity.id, repeated.id);
    assert.notEqual(firstIdentity.id, secondIdentity.id);
    assert.equal(firstIdentity.kind, "directory");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("unresolvable project paths fail instead of inventing an identity", () => {
  const missing = join(tmpdir(), `missing-project-${Date.now()}`);
  assert.throws(
    () => canonicalizeProjectIdentity(missing),
    (error) => error.code === "PROJECT_PATH_UNRESOLVED",
  );
});

