import assert from "node:assert/strict";
import test from "node:test";

import { buildDashboardSnapshot } from "../src/dashboard-model.js";
import { ControlRegistry } from "../src/registry.js";
import { buildRunGraph } from "../src/run-controller.js";

test("dashboard DTO exposes failure, routing provenance, identities, and safe archive scopes without starting work", () => {
  const registry = new ControlRegistry({ path: ":memory:" });
  registry.createRun({
    id: "active_run", cwd: "/repo", status: "awaiting_user_start",
    metadata: {
      dispatchPath: "orchestrated",
      schedulerIdentity: { type: "daemon_scheduler", instanceId: "daemon_1" },
      orchestratorSessionIdentity: { type: "codex_session", agentId: "orch_1" },
    },
  });
  registry.createTask({
    id: "task_1", prompt: "실패를 고쳐라", cwd: "/repo", status: "staged", metadata: {
      runId: "active_run", title: "실패 처리",
      failure: { type: "command_failed", cause: "test exited 1", retryable: true, nextAction: "retry", attemptBudget: { used: 1, max: 2, remaining: 1 }, exhausted: false },
    },
    routing: {
      decision: "reuse", reasons: ["same working directory"],
      selectedRequirementMatrix: { capabilities: { cells: [{ requirement: "api", satisfied: true }] }, tools: { cells: [{ requirement: "node", satisfied: true }] } },
      provenance: { decisionSource: "agent_router" },
      schedulerIdentity: { type: "daemon_scheduler", instanceId: "daemon_1" },
      orchestratorSessionIdentity: { type: "codex_session", agentId: "orch_1" },
    },
  });
  registry.createRun({ id: "archived_run", cwd: "/repo", status: "completed" });
  registry.archiveRun("archived_run");
  registry.upsertAgent({ id: "idle_1", cwd: "/repo", status: "idle" }, { metadata: { tools: ["node"] } });

  const active = buildDashboardSnapshot(registry, { cwd: "/repo", scope: "active", getGraph: buildRunGraph.bind(null, registry) });
  assert.deepEqual(active.runs.map((run) => run.id), ["active_run"]);
  assert.equal(active.run.archiveAllowed, false);
  assert.equal(active.tasks[0].failure.nextAction, "retry");
  assert.equal(active.tasks[0].routing.requirementMatrix.tools.cells[0].satisfied, true);
  assert.deepEqual(active.run.schedulerIdentity, { type: "daemon_scheduler", instanceId: "daemon_1" });
  assert.deepEqual(active.run.orchestratorSessionIdentity, { type: "codex_session", agentId: "orch_1" });
  assert.notEqual(active.run.schedulerIdentity.instanceId, active.run.orchestratorSessionIdentity.agentId);
  assert.equal(active.agents.find((agent) => agent.id === "idle_1").archiveAllowed, true);
  assert.equal(registry.getRun("active_run").status, "awaiting_user_start");
  assert.equal(registry.getTask("task_1").status, "staged");

  const archived = buildDashboardSnapshot(registry, { cwd: "/repo", scope: "archived", getGraph: buildRunGraph.bind(null, registry) });
  assert.deepEqual(archived.runs.map((run) => run.id), ["archived_run"]);
  assert.equal(archived.run.unarchiveAllowed, true);
  assert.deepEqual(archived.tasks, []);
  assert.equal(registry.getRun("active_run").status, "awaiting_user_start");
  registry.close();
});
