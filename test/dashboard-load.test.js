import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import test from "node:test";

import { buildDashboardDelta, buildDashboardSnapshot } from "../src/dashboard-model.js";
import { ControlRegistry } from "../src/registry.js";

function seededRegistry(runCount = 10, tasksPerRun = 5) {
  const registry = new ControlRegistry({ path: ":memory:" });
  for (let runIndex = 0; runIndex < runCount; runIndex += 1) {
    const runId = `run_load_${runIndex}`;
    registry.createRun({ id: runId, name: `Load run ${runIndex}`, cwd: "/repo", status: "running" });
    for (let taskIndex = 0; taskIndex < tasksPerRun; taskIndex += 1) {
      const agentId = `agent_load_${runIndex}_${taskIndex}`;
      registry.upsertAgent({ id: agentId, name: `Agent ${runIndex}-${taskIndex}`, cwd: "/repo", status: "running" }, { role: "implementer" });
      registry.createTask({
        id: `task_load_${runIndex}_${taskIndex}`,
        prompt: `Representative task ${taskIndex} with bounded dashboard summary data`,
        cwd: "/repo",
        status: "running",
        agentId,
        metadata: { runId, title: `Task ${taskIndex}` },
      });
    }
  }
  return registry;
}

test("10 runs by 5 tasks stay inside dashboard payload and latency budgets", () => {
  const registry = seededRegistry();
  const snapshot = buildDashboardSnapshot(registry, { cwd: "/repo", tasksForSelectedRun: false });
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) < 100_000, "snapshot must remain a lightweight DTO");

  const revision = snapshot.revision;
  const samples = [];
  for (let index = 0; index < 1_000; index += 1) {
    const started = performance.now();
    const delta = buildDashboardDelta(registry, { cwd: "/repo", sinceRevision: revision });
    samples.push(performance.now() - started);
    assert.equal(delta.changed, false);
  }
  samples.sort((left, right) => left - right);
  const p95 = samples[Math.floor(samples.length * 0.95)];
  assert.ok(p95 < 5, `unchanged delta p95 ${p95.toFixed(3)}ms exceeds 5ms`);
  assert.ok(Buffer.byteLength(JSON.stringify(buildDashboardDelta(registry, { cwd: "/repo", sinceRevision: revision }))) < 512);
  registry.close();
});

test("repeated dashboard reads do not retain unbounded heap", () => {
  const registry = seededRegistry();
  const revision = buildDashboardSnapshot(registry, { cwd: "/repo" }).revision;
  const before = process.memoryUsage().heapUsed;
  for (let index = 0; index < 10_000; index += 1) {
    buildDashboardDelta(registry, { cwd: "/repo", sinceRevision: revision });
  }
  const growth = process.memoryUsage().heapUsed - before;
  assert.ok(growth < 32 * 1024 * 1024, `dashboard reads retained ${(growth / 1024 / 1024).toFixed(1)} MiB`);
  registry.close();
});
