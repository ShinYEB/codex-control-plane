import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
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
