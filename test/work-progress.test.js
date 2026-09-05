import assert from "node:assert/strict";
import test from "node:test";
import { TASK_STATUSES } from "../src/domain-states.js";
import { workProgress, workStatus } from "../src/work-status.js";

test("progress separates successful completion from rejected and running work", () => {
  const tasks = ["completed", "completed_with_warnings", "rejected", "running"].map(status => ({ status }));
  const progress = workProgress(tasks);
  assert.deepEqual(progress, { total: 4, finished: 3, succeeded: 2, warnings: 1, rejected: 1,
    failed: 0, cancelled: 0, skipped: 0, attention: 0, active: 1, waiting: 0, unknown: 0 });
  const registry = { listTasks: () => tasks, getAgent: () => null };
  assert.equal(workStatus(registry, { id: "r", status: "running" }).needsAttention, true);
});

test("every task state belongs to one progress bucket, excluding the warning subset", () => {
  for (const status of TASK_STATUSES) {
    const p = workProgress([{ status }]);
    assert.equal(p.unknown, 0, status);
    assert.equal(p.succeeded + p.rejected + p.failed + p.cancelled + p.skipped + p.attention + p.active + p.waiting, 1, status);
  }
  const p = workProgress([{ status: "skipped" }, { status: "canceled" }]);
  assert.equal(p.finished, 2);
  assert.equal(p.succeeded, 0);
});

test("approval waits and unknown states are visible rather than reported healthy", () => {
  const task = { status: "approval_waiting", updatedAt: "2026-09-05T10:00:00Z" };
  const registry = { listTasks: () => [task], getAgent: () => null };
  const run = { id: "r", status: "running", updatedAt: "2026-09-05T09:00:00Z" };
  const snapshot = workStatus(registry, run);
  assert.equal(snapshot.needsAttention, true);
  assert.equal(snapshot.progress.attention, 1);
  assert.equal(snapshot.progress.finished, 0);
  assert.equal(snapshot.lastUpdatedAt, task.updatedAt);
  assert.ok(Number.isFinite(Date.parse(snapshot.observedAt)));
  task.status = "future_unknown_state";
  assert.equal(workStatus(registry, run).needsAttention, true);
  assert.equal(workStatus(registry, run).progress.unknown, 1);
});
