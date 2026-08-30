import assert from "node:assert/strict";
import test from "node:test";

import { DashboardServer } from "../src/dashboard-server.js";
import { ControlRegistry } from "../src/registry.js";

test("local dashboard requires its token and waits for an explicit start", async () => {
  const registry = new ControlRegistry({ path: ":memory:" });
  registry.createRun({ id: "run_1", name: "test", cwd: "/repo", status: "awaiting_user_start" });
  registry.createTask({ id: "task_1", prompt: "work", cwd: "/repo", status: "staged", metadata: { runId: "run_1", execution: {} } });
  registry.createRun({ id: "run_done", name: "done", cwd: "/repo", status: "completed" });
  registry.upsertAgent({ id: "agent_idle", name: "Idle", cwd: "/repo", status: "idle" });
  let startCalls = 0;
  const server = new DashboardServer({
    registry,
    html: "<!doctype html><title>dashboard</title>",
    onStart: (runId, details) => { startCalls += 1; return registry.releaseStagedRun(runId, details); },
    onArchiveRun: (runId) => registry.archiveRun(runId),
    onArchiveAgent: (agentId) => registry.archiveAgent(agentId),
  });
  await server.start();
  const url = new URL(server.url({ cwd: "/repo", runId: "run_1" }));

  const forbidden = await fetch(`${url.origin}/api/snapshot`);
  assert.equal(forbidden.status, 403);

  const snapshot = await fetch(`${url.origin}/api/snapshot?${url.searchParams}`).then((response) => response.json());
  assert.equal(snapshot.tasks[0].status, "staged");
  assert.equal(snapshot.tasks[0].prompt, undefined);
  assert.equal(typeof snapshot.revision, "number");
  assert.equal(snapshot.run.status, "awaiting_user_start");
  assert.equal(startCalls, 0);

  const archivedRun = await fetch(`${url.origin}/api/runs/run_done/archive?${url.searchParams}`, { method: "POST" });
  const archivedAgent = await fetch(`${url.origin}/api/agents/agent_idle/archive?${url.searchParams}`, { method: "POST" });
  assert.equal(archivedRun.status, 200);
  assert.equal(archivedAgent.status, 200);
  const archivedSnapshotUrl = new URL(`${url.origin}/api/snapshot?${url.searchParams}`);
  archivedSnapshotUrl.searchParams.set("scope", "archived");
  const archivedSnapshot = await fetch(archivedSnapshotUrl).then((response) => response.json());
  assert.deepEqual(archivedSnapshot.runs.map((run) => run.id), ["run_done"]);
  assert.deepEqual(archivedSnapshot.agents.map((agent) => agent.id), ["agent_idle"]);
  assert.equal(registry.getRun("run_1").status, "awaiting_user_start");
  assert.equal(registry.getTask("task_1").status, "staged");
  assert.equal(startCalls, 0);

  const detail = await fetch(`${url.origin}/api/details/task/task_1?${url.searchParams}`).then((response) => response.json());
  assert.equal(detail.detail.prompt, "work");

  const started = await fetch(`${url.origin}/api/runs/run_1/start?${url.searchParams}`, { method: "POST" }).then((response) => response.json());
  assert.equal(started.tasks[0].status, "queued");
  assert.equal(registry.getRun("run_1").status, "running");
  assert.equal(startCalls, 1);
  await server.close();
  registry.close();
});

test("only one live dashboard server owns the durable dashboard lease", async () => {
  const registry = new ControlRegistry({ path: ":memory:" });
  const first = new DashboardServer({ registry, html: "<!doctype html>", ownerId: "daemon_one", leaseTtlMs: 60_000 });
  const second = new DashboardServer({ registry, html: "<!doctype html>", ownerId: "daemon_two", leaseTtlMs: 60_000 });
  await first.start();
  await assert.rejects(second.start(), /owned by another live daemon/);
  await first.close();
  await second.start();
  await second.close();
  registry.close();
});

test("local dashboard registers an existing session as an agent", async () => {
  const registry = new ControlRegistry({ path: ":memory:" });
  registry.upsertAgent({ id: "thread_1", name: "Existing session", cwd: "/repo", status: "available" });
  const server = new DashboardServer({
    registry,
    html: "<!doctype html><title>dashboard</title>",
    onRegisterAgent: (threadId, profile) => registry.updateAgent(threadId, profile),
  });
  await server.start();
  const url = new URL(server.url({ cwd: "/repo" }));
  const response = await fetch(`${url.origin}/api/agents/thread_1/profile?${url.searchParams}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ role: "reviewer", capabilities: ["review"] }),
  });
  assert.equal(response.status, 200);
  assert.equal(registry.getAgent("thread_1").role, "reviewer");
  await server.close();
  registry.close();
});
