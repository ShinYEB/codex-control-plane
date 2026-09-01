import assert from "node:assert/strict";
import test from "node:test";

import { ControlRegistry } from "../src/registry.js";
import { RunController } from "../src/run-controller.js";

test("run controller exposes agent-assigned dependency graph", () => {
  const registry = new ControlRegistry({ path: ":memory:" });
  registry.upsertAgent({ id: "backend", name: "[Backend] 구현", cwd: "/repo", status: "idle" }, { role: "implementer" });
  registry.upsertAgent({ id: "qa", name: "[QA] 검증", cwd: "/repo", status: "idle" }, { role: "qa" });
  registry.upsertAgent({ id: "orchestrator", name: "[🤖 orchestrator] 제품 구현", cwd: "/repo", status: "idle" }, { role: "orchestrator" });
  registry.createTaskGraph({ id: "run_graph", name: "제품 구현", cwd: "/repo", status: "awaiting_user_start", metadata: { dispatchPath: "orchestrated", complexity: { level: "medium", score: 44 }, schedulerIdentity: { type: "daemon_scheduler", instanceId: "daemon_1" }, orchestratorSessionIdentity: { type: "codex_session", agentId: "orchestrator" }, orchestratorAgentId: "orchestrator" } }, [
    { id: "test", prompt: "통합 테스트", role: "qa", agentId: "qa", dependsOn: ["build"], metadata: { key: "test", title: "통합 테스트", acceptanceCriteria: ["all tests pass"], execution: { workspaceMode: "shared" } } },
    { id: "build", prompt: "백엔드 구현", role: "implementer", agentId: "backend", metadata: { key: "build", title: "백엔드 구현", execution: { workspaceMode: "worktree", branch: "codex/build" } } },
  ]);
  const controller = new RunController({ registry, getControl: async () => null });
  const graph = controller.graph("run_graph");
  assert.deepEqual(graph.edges, [{ id: "build:test", source: "build", target: "test", type: "dependency" }]);
  assert.equal(graph.nodes.find((node) => node.id === "build").agent.name, "[Backend] 구현");
  assert.equal(graph.nodes.find((node) => node.id === "build").workspace.mode, "worktree");
  assert.deepEqual(graph.nodes.find((node) => node.id === "test").acceptanceCriteria, ["all tests pass"]);
  assert.equal(graph.run.dispatchPath, "orchestrated");
  assert.equal(graph.run.orchestrator.name, "[🤖 orchestrator] 제품 구현");
  assert.deepEqual(graph.run.scheduler, { type: "daemon_scheduler", instanceId: "daemon_1" });
  assert.deepEqual(graph.run.orchestratorSession, { type: "codex_session", agentId: "orchestrator" });
  assert.notEqual(graph.run.scheduler.instanceId, graph.run.orchestratorSession.agentId);
  assert.equal(graph.run.complexity.score, 44);
  registry.close();
});

test("run graph repairs a stale parent status after every task is terminal", () => {
  const registry = new ControlRegistry({ path: ":memory:" });
  registry.createTaskGraph(
    { id: "run_stale_terminal", name: "stale terminal", status: "running", cwd: "/tmp/project" },
    [
      { id: "task_rejected", prompt: "inspect", status: "rejected" },
      { id: "task_failed", prompt: "test", status: "failed", dependsOn: ["task_rejected"] },
    ],
  );
  const controller = new RunController({ registry, getControl: async () => null });

  const graph = controller.graph("run_stale_terminal");

  assert.equal(graph.run.status, "failed");
  assert.equal(graph.run.completedAt !== null, true);
  assert.equal(registry.getRun("run_stale_terminal").status, "failed");
  registry.close();
});

test("run controller releases roots and keeps dependent nodes blocked", () => {
  const registry = new ControlRegistry({ path: ":memory:" });
  registry.createTaskGraph({ id: "run_start", status: "awaiting_user_start" }, [
    { id: "child", prompt: "child", dependsOn: ["root"] },
    { id: "root", prompt: "root" },
  ]);
  let released = false;
  const controller = new RunController({ registry, getControl: async () => null, onReleased: () => { released = true; } });
  controller.start("run_start", { source: "test" });
  assert.equal(released, true);
  assert.equal(registry.getTask("root").status, "queued");
  assert.equal(registry.getTask("child").status, "blocked");
  assert.deepEqual(controller.nextTasks(5).map((task) => task.id), ["root"]);
  registry.close();
});
