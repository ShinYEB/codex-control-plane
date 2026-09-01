import assert from "node:assert/strict";
import test from "node:test";

import { buildDashboardDelta, buildDashboardSnapshot, dashboardRevision, getDashboardDetail } from "../src/dashboard-model.js";
import { ControlRegistry } from "../src/registry.js";
import { ContextResolver } from "../src/context-resolver.js";
import { buildRunGraph, RunController } from "../src/run-controller.js";
import { compileExecutionContract } from "../src/execution-contracts.js";

function executable(task) {
  const executionContract = compileExecutionContract({ key: task.id, taskKind: "analysis", mutatesWorkspace: false });
  return { ...task, metadata: { ...(task.metadata ?? {}), executionContract } };
}

test("dashboard keeps Context Snapshot summaries lightweight and loads provenance on demand", () => {
  const registry = new ControlRegistry({ path: ":memory:" });
  registry.createContextClaim({ id: "dashboard_claim", kind: "decision", subject: "api-contract", body: "Sensitive full contract body", scope: "global", authority: "user_explicit", status: "candidate" });
  registry.addContextClaimSource("dashboard_claim", { kind: "user_turn", id: "turn_contract" });
  registry.activateContextClaim("dashboard_claim");
  const context = new ContextResolver(registry).resolve({ objective: "Use the API contract", requiredSubjects: ["api-contract"] });
  registry.createTaskGraph({ id: "context_run", cwd: "/repo", status: "running", metadata: { contextSnapshotId: context.id, contextSnapshotFingerprint: context.fingerprint } }, [
    executable({ id: "context_task", prompt: "work", status: "queued", metadata: { contextSnapshotId: context.id, contextSnapshotFingerprint: context.fingerprint } }),
  ]);

  const dashboard = buildDashboardSnapshot(registry, { cwd: "/repo", runId: "context_run", getGraph: buildRunGraph.bind(null, registry) });
  assert.deepEqual(dashboard.run.contextSnapshot, {
    id: context.id, status: "validated", revision: 1, fingerprint: context.fingerprint,
    selectedCount: 1, excludedCount: 0, conflictCount: 0, blockingConflictCount: 0,
  });
  assert.equal(dashboard.tasks[0].contextSnapshot.id, context.id);
  assert.doesNotMatch(JSON.stringify(dashboard), /Sensitive full contract body/);

  const detail = getDashboardDetail(registry, "context_snapshot", context.id);
  assert.equal(detail.claims[0].claim.body, "Sensitive full contract body");
  assert.deepEqual(detail.claims[0].reasons, ["required_subject", "objective_overlap:2", "authority:user_explicit"]);
  registry.close();
});

test("dashboard exposes Global Run projection separately from Project Runs", () => {
  const registry = new ControlRegistry({ path: ":memory:" });
  registry.createGlobalRun({ id: "global_dashboard", objective: "Coordinate API and web" });
  const snapshot = buildDashboardSnapshot(registry);
  assert.deepEqual(snapshot.globalRuns.map(({ id, status, projectCount }) => ({ id, status, projectCount })), [
    { id: "global_dashboard", status: "accepted", projectCount: 0 },
  ]);
  assert.equal(snapshot.globalRuns[0].authorizationManifestCount, 0);
  assert.equal(snapshot.globalRuns[0].handoffCount, 0);
  assert.equal(snapshot.globalRuns[0].invalidHandoffCount, 0);
  assert.equal(getDashboardDetail(registry, "global_run", "global_dashboard").globalRun.objective, "Coordinate API and web");
  registry.close();
});

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

test("dashboard exposes a graphless dispatch failure before worker creation", () => {
  const registry = new ControlRegistry({ path: ":memory:" });
  registry.createRun({
    id: "preflight_failed", cwd: "/repo", status: "failed",
    metadata: { dispatchPhase: "failed", dispatchError: "Task health requires a separate user-authorized external action" },
  });
  const snapshot = buildDashboardSnapshot(registry, {
    cwd: "/repo", runId: "preflight_failed", getGraph: buildRunGraph.bind(null, registry),
  });
  assert.equal(snapshot.run.failure.category, "configuration");
  assert.match(snapshot.run.failure.cause, /Task health/);
  assert.equal(snapshot.graph.run.failure.nextAction, "repair_contract");
  assert.equal(snapshot.graph.nodes.length, 0);
  registry.close();
});

test("dashboard reconciles a stale terminal Run consistently across card, list, and graph", () => {
  const registry = new ControlRegistry({ path: ":memory:" });
  registry.createTaskGraph({ id: "stale_dashboard", cwd: "/repo", status: "running" }, [
    { id: "rejected_root", prompt: "root", status: "rejected" },
    { id: "failed_child", prompt: "child", status: "failed", dependsOn: ["rejected_root"] },
  ]);
  const controller = new RunController({ registry, getControl: async () => null });

  const snapshot = buildDashboardSnapshot(registry, {
    cwd: "/repo",
    runId: "stale_dashboard",
    getGraph: (runId, options) => controller.graph(runId, options),
  });

  assert.equal(snapshot.status, "failed");
  assert.equal(snapshot.run.status, "failed");
  assert.equal(snapshot.runs.find((run) => run.id === "stale_dashboard").status, "failed");
  assert.equal(snapshot.graph.run.status, "failed");
  assert.equal(snapshot.graph.summary.progress, 100);
  registry.close();
});

test("task-only deltas update graph, selected Run, and Run cards together", () => {
  const registry = new ControlRegistry({ path: ":memory:" });
  registry.createTaskGraph({ id: "delta_run", cwd: "/repo", status: "running" }, [
    executable({ id: "delta_task", prompt: "finish", status: "running" }),
  ]);
  const revision = dashboardRevision(registry);
  registry.updateTask("delta_task", { status: "completed", completedAt: new Date().toISOString() });
  const controller = new RunController({ registry, getControl: async () => null });
  const delta = buildDashboardDelta(registry, {
    cwd: "/repo", runId: "delta_run", sinceRevision: revision,
    getGraph: (runId, options) => controller.graph(runId, options),
  });
  assert.equal(delta.tasks[0].status, "completed");
  assert.equal(delta.graph.run.status, "completed");
  assert.equal(delta.run.status, "completed");
  assert.equal(delta.runs.find((run) => run.id === "delta_run").status, "completed");
  registry.close();
});

test("task DTO exposes dependencies, runnable state, and current work", () => {
  const registry = new ControlRegistry({ path: ":memory:" });
  registry.createTaskGraph({ id: "dto_run", cwd: "/repo", status: "running" }, [
    { id: "done_root", prompt: "root", status: "completed" },
    { id: "ready_child", prompt: "child", status: "queued", dependsOn: ["done_root"] },
    executable({ id: "working", prompt: "work", status: "running", agentId: "agent_1", turnId: "turn_1", heartbeatAt: "2026-08-30T00:00:00.000Z" }),
  ]);
  const snapshot = buildDashboardSnapshot(registry, { cwd: "/repo", runId: "dto_run", getGraph: buildRunGraph.bind(null, registry) });
  const child = snapshot.tasks.find((task) => task.id === "ready_child");
  const working = snapshot.tasks.find((task) => task.id === "working");
  assert.deepEqual(child.dependsOn, ["done_root"]);
  assert.deepEqual(child.blockedBy, []);
  assert.equal(child.runnable, true);
  assert.deepEqual(working.currentWork, {
    phase: "running", agentId: "agent_1", turnId: "turn_1", workerId: null,
    startedAt: null, heartbeatAt: "2026-08-30T00:00:00.000Z",
  });
  assert.deepEqual(working.resultSession, {
    threadId: "agent_1", turnId: "turn_1", name: null, role: null, available: false,
  });
  registry.close();
});

test("run inbox DTO names Orchestrator and Data Plane threads", () => {
  const registry = new ControlRegistry({ path: ":memory:" });
  registry.upsertAgent({ id: "orch", name: "[🤖 orchestrator] 결제 개선", cwd: "/repo", status: "idle" }, { role: "orchestrator" });
  registry.upsertAgent({ id: "worker", name: "[🤖 qa] 회귀 테스트", cwd: "/repo", status: "idle" }, { role: "qa" });
  registry.createTaskGraph({
    id: "participant_run", cwd: "/repo", status: "completed",
    metadata: { dispatchPath: "orchestrated", orchestratorSessionIdentity: { type: "codex_session", agentId: "orch" } },
  }, [{ id: "participant_task", prompt: "test", status: "completed", agentId: "worker", turnId: "turn_done" }]);
  const snapshot = buildDashboardSnapshot(registry, { cwd: "/repo", runId: "participant_run", getGraph: buildRunGraph.bind(null, registry) });
  const participants = snapshot.runs[0].executionParticipants;
  assert.equal(participants.orchestrator.name, "[🤖 orchestrator] 결제 개선");
  assert.deepEqual(participants.dataAgents.map(({ id, name, role }) => ({ id, name, role })), [
    { id: "worker", name: "[🤖 qa] 회귀 테스트", role: "qa" },
  ]);
  assert.equal(snapshot.tasks[0].resultSession.available, true);
  assert.equal(snapshot.tasks[0].resultSession.turnId, "turn_done");
  registry.close();
});

test("run inbox resolves a worktree agent outside the project cwd scope", () => {
  const registry = new ControlRegistry({ path: ":memory:" });
  registry.upsertAgent({ id: "isolated", name: "[🤖 qa] 격리 검증", cwd: "/tmp/control-plane-worktrees/task", status: "idle" }, { role: "qa" });
  registry.createTaskGraph({ id: "isolated_run", cwd: "/repo", status: "completed", metadata: { dispatchPath: "direct" } }, [
    { id: "isolated_task", prompt: "test", status: "completed", agentId: "isolated" },
  ]);
  const snapshot = buildDashboardSnapshot(registry, { cwd: "/repo", runId: "isolated_run", getGraph: buildRunGraph.bind(null, registry) });
  assert.equal(snapshot.runs[0].executionParticipants.dataAgents[0].name, "[🤖 qa] 격리 검증");
  assert.equal(snapshot.tasks[0].resultSession.name, "[🤖 qa] 격리 검증");
  registry.close();
});
