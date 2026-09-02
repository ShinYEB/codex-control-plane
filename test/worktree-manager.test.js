import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ControlRegistry } from "../src/registry.js";
import { WorktreeManager } from "../src/worktree-manager.js";

test("managed worktree uses git add and retains dirty changes", async () => {
  const root = mkdtempSync(join(tmpdir(), "cp-worktrees-"));
  const calls = [];
  let dirty = true;
  const manager = new WorktreeManager(new ControlRegistry({ path: ":memory:" }), {
    root,
    execFile: async (_git, args) => {
      calls.push(args);
      if (args.includes("rev-parse")) return { stdout: "/repo\n" };
      if (args.includes("show-ref")) throw new Error("missing branch");
      if (args.includes("status")) return { stdout: dirty ? " M src/app.js\n" : "" };
      return { stdout: "" };
    },
  });
  try {
    const worktree = await manager.prepare({ taskId: "task_1", cwd: "/repo", baseRef: "main" });
    assert.equal(worktree.status, "active");
    assert.ok(calls.some((args) => args.includes("add") && args.includes("-b")));
    assert.equal((await manager.cleanup(worktree.id)).status, "retained");
    dirty = false;
    assert.equal((await manager.cleanup(worktree.id)).status, "removed");
    assert.ok(calls.some((args) => args.includes("remove")));
  } finally {
    manager.registry.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("managed worktree reattaches its deterministic branch after cleanup", async () => {
  const root = mkdtempSync(join(tmpdir(), "cp-worktrees-retry-"));
  const calls = [];
  let branchExists = false;
  const manager = new WorktreeManager(new ControlRegistry({ path: ":memory:" }), {
    root,
    execFile: async (_git, args) => {
      calls.push(args);
      if (args.includes("rev-parse")) return { stdout: "/repo\n" };
      if (args.includes("show-ref")) {
        if (!branchExists) throw new Error("missing branch");
        return { stdout: "" };
      }
      if (args.includes("status")) return { stdout: "" };
      if (args.includes("add")) branchExists = true;
      return { stdout: "" };
    },
  });
  try {
    const first = await manager.prepare({ taskId: "task_retry", cwd: "/repo", baseRef: "main" });
    assert.equal((await manager.cleanup(first.id)).status, "removed");
    const second = await manager.prepare({ taskId: "task_retry", cwd: "/repo", baseRef: "main" });
    assert.equal(second.status, "active");
    const addCalls = calls.filter((args) => args.includes("add"));
    assert.equal(addCalls.length, 2);
    assert.ok(addCalls[0].includes("-b"));
    assert.equal(addCalls[1].includes("-b"), false);
    assert.equal(addCalls[1].at(-1), "codex/task_retry");
  } finally {
    manager.registry.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("dirty project state is snapshotted and worker artifacts integrate back", async () => {
  const root = mkdtempSync(join(tmpdir(), "cp-worktree-real-"));
  const repo = join(root, "repo");
  const managed = join(root, "managed");
  execFileSync("git", ["init", repo]);
  execFileSync("git", ["-C", repo, "config", "user.email", "control-plane@example.invalid"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "Control Plane Test"]);
  writeFileSync(join(repo, "tracked.txt"), "committed\n");
  execFileSync("git", ["-C", repo, "add", "tracked.txt"]);
  execFileSync("git", ["-C", repo, "commit", "-m", "base"]);
  writeFileSync(join(repo, "tracked.txt"), "dirty baseline\n");
  writeFileSync(join(repo, "untracked.txt"), "keep me\n");
  const registry = new ControlRegistry({ path: ":memory:" });
  const manager = new WorktreeManager(registry, { root: managed });
  try {
    const worktree = await manager.prepare({ taskId: "task_dirty", cwd: repo });
    assert.equal(readFileSync(join(worktree.path, "tracked.txt"), "utf8"), "dirty baseline\n");
    assert.equal(readFileSync(join(worktree.path, "untracked.txt"), "utf8"), "keep me\n");
    assert.equal(worktree.metadata.baseline.dirty, true);

    writeFileSync(join(worktree.path, "tracked.txt"), "worker result\n");
    const artifact = await manager.finalize(worktree.id);
    assert.equal(artifact.changed, true);
    const integration = await manager.integrate(worktree.id);
    assert.equal(integration.status, "integrated");
    assert.equal(readFileSync(join(repo, "tracked.txt"), "utf8"), "worker result\n");
    assert.equal((await manager.cleanup(worktree.id)).status, "removed");
  } finally {
    registry.close();
    rmSync(root, { recursive: true, force: true });
  }
});

function initializeRepository(root, files) {
  const repo = join(root, "repo");
  execFileSync("git", ["init", repo]);
  execFileSync("git", ["-C", repo, "config", "user.email", "control-plane@example.invalid"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "Control Plane Test"]);
  for (const [name, content] of Object.entries(files)) writeFileSync(join(repo, name), content);
  execFileSync("git", ["-C", repo, "add", "."]);
  execFileSync("git", ["-C", repo, "commit", "-m", "base"]);
  return repo;
}

test("parallel worktree artifacts serialize integration without losing either change", async () => {
  const root = mkdtempSync(join(tmpdir(), "cp-worktree-parallel-"));
  const repo = initializeRepository(root, { "a.txt": "a0\n", "b.txt": "b0\n" });
  const registry = new ControlRegistry({ path: ":memory:" });
  const manager = new WorktreeManager(registry, { root: join(root, "managed") });
  try {
    const [first, second] = await Promise.all([
      manager.prepare({ taskId: "parallel_a", cwd: repo }),
      manager.prepare({ taskId: "parallel_b", cwd: repo }),
    ]);
    writeFileSync(join(first.path, "a.txt"), "a1\n");
    writeFileSync(join(second.path, "b.txt"), "b1\n");
    await Promise.all([manager.finalize(first.id), manager.finalize(second.id)]);
    await Promise.all([manager.integrate(first.id), manager.integrate(second.id)]);
    assert.equal(readFileSync(join(repo, "a.txt"), "utf8"), "a1\n");
    assert.equal(readFileSync(join(repo, "b.txt"), "utf8"), "b1\n");
  } finally {
    registry.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("integration conflict preserves the patch and leaves the worktree recoverable", async () => {
  const root = mkdtempSync(join(tmpdir(), "cp-worktree-conflict-"));
  const repo = initializeRepository(root, { "shared.txt": "base\n" });
  const registry = new ControlRegistry({ path: ":memory:" });
  const manager = new WorktreeManager(registry, { root: join(root, "managed") });
  try {
    const worktree = await manager.prepare({ taskId: "conflict", cwd: repo });
    writeFileSync(join(worktree.path, "shared.txt"), "worker\n");
    const artifact = await manager.finalize(worktree.id);
    writeFileSync(join(repo, "shared.txt"), "main changed\n");
    await assert.rejects(manager.integrate(worktree.id), (error) => error.code === "WORKSPACE_INTEGRATION_CONFLICT");
    assert.equal(registry.getManagedWorktree(worktree.id).status, "integration_blocked");
    assert.equal(existsSync(artifact.patchPath), true);
    assert.equal((await manager.recover(worktree.id, "inspect")).worktree.status, "integration_blocked");
    assert.equal((await manager.cleanup(worktree.id)).status, "retained");
  } finally {
    registry.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("commit integration cherry-picks a clean artifact and records the strategy", async () => {
  const root = mkdtempSync(join(tmpdir(), "cp-worktree-commit-"));
  const repo = initializeRepository(root, { "source.txt": "base\n" });
  const registry = new ControlRegistry({ path: ":memory:" });
  const manager = new WorktreeManager(registry, { root: join(root, "managed") });
  try {
    const worktree = await manager.prepare({ taskId: "commit_strategy", cwd: repo });
    writeFileSync(join(worktree.path, "source.txt"), "integrated\n");
    await manager.finalize(worktree.id);
    const result = await manager.integrate(worktree.id, { strategy: "commit" });
    assert.equal(result.strategy, "commit");
    assert.equal(readFileSync(join(repo, "source.txt"), "utf8"), "integrated\n");
    assert.equal(registry.getManagedWorktree(worktree.id).status, "integrated");
    const postcondition = await manager.verifyIntegration(worktree.id);
    assert.equal(postcondition.passed, true);
    assert.equal(postcondition.journalStatus, "recorded");
  } finally {
    registry.close();
    rmSync(root, { recursive: true, force: true });
  }
});

for (const crashStage of ["applying", "applied", "recording"]) {
  test(`integration journal recovers a forced stop at ${crashStage} without duplicate apply`, async () => {
    const root = mkdtempSync(join(tmpdir(), `cp-worktree-crash-${crashStage}-`));
    const repo = initializeRepository(root, { "journal.txt": "base\n" });
    const databasePath = join(root, "registry.sqlite");
    const registry = new ControlRegistry({ path: databasePath });
    let injected = false;
    const manager = new WorktreeManager(registry, {
      root: join(root, "managed"),
      integrationHook: async (stage) => {
        if (!injected && stage === crashStage) {
          injected = true;
          throw Object.assign(new Error(`forced stop at ${stage}`), { code: "INTEGRATION_CRASH_SIMULATED" });
        }
      },
    });
    try {
      const worktree = await manager.prepare({ taskId: `crash_${crashStage}`, cwd: repo });
      writeFileSync(join(worktree.path, "journal.txt"), `${crashStage}\n`);
      await manager.finalize(worktree.id);
      await assert.rejects(manager.integrate(worktree.id), { code: "INTEGRATION_CRASH_SIMULATED" });
      registry.close();

      const reopened = new ControlRegistry({ path: databasePath });
      const recoveredManager = new WorktreeManager(reopened, { root: join(root, "managed") });
      try {
        const results = await recoveredManager.recoverPendingIntegrations();
        assert.equal(results[0].status, "integrated");
        assert.equal(readFileSync(join(repo, "journal.txt"), "utf8"), `${crashStage}\n`);
        const journals = reopened.listIntegrationJournals({ worktreeId: worktree.id });
        assert.equal(journals.length, 1);
        assert.equal(journals[0].status, "recorded");
      } finally {
        reopened.close();
      }
    } finally {
      if (!registry.closed) registry.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("an orphaned managed worktree is quarantined instead of deleted", async () => {
  const root = mkdtempSync(join(tmpdir(), "cp-worktree-orphan-"));
  const repo = initializeRepository(root, { "file.txt": "base\n" });
  const registry = new ControlRegistry({ path: ":memory:" });
  const manager = new WorktreeManager(registry, { root: join(root, "managed") });
  try {
    const worktree = await manager.prepare({ taskId: "orphan", cwd: repo });
    execFileSync("git", ["-C", repo, "worktree", "remove", "--force", worktree.path]);
    const inspected = await manager.recover(worktree.id, "inspect");
    assert.equal(inspected.worktree.status, "quarantined");
  } finally {
    registry.close();
    rmSync(root, { recursive: true, force: true });
  }
});
