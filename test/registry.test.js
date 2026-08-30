import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ControlRegistry } from "../src/registry.js";
import { AgentRouter } from "../src/router.js";

test("registry persists agent profiles and task state across reopen", () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-control-registry-"));
  const path = join(directory, "registry.sqlite");
  try {
    const first = new ControlRegistry({ path });
    first.upsertAgent({ id: "agent_1", cwd: "/repo", status: "available" }, {
      role: "reviewer",
      capabilities: ["security"],
    });
    first.createTask({ id: "task_1", prompt: "review", status: "running", agentId: "agent_1" });
    first.close();

    const second = new ControlRegistry({ path });
    assert.equal(second.getAgent("agent_1").role, "reviewer");
    assert.deepEqual(second.getAgent("agent_1").capabilities, ["security"]);
    assert.equal(second.getTask("task_1").status, "running");
    assert.equal(second.recoverInterruptedTasks(), 1);
    assert.equal(second.getTask("task_1").status, "recovery_attention");
    second.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("router selects a matching available agent and spawns when score is too low", () => {
  const router = new AgentRouter();
  const agents = [
    { id: "security", cwd: "/repo", status: "available", role: "reviewer", capabilities: ["security"], summary: "dependency audit" },
    { id: "frontend", cwd: "/repo", status: "running", role: "designer", capabilities: ["css"] },
  ];
  const selected = router.select(agents, {
    prompt: "보안 dependency audit",
    cwd: "/repo",
    role: "reviewer",
    capabilities: ["security"],
  });
  assert.equal(selected.decision, "fork");
  assert.equal(selected.selectedAgent.id, "security");
  assert.ok(selected.scoreBreakdown.role > 0);

  const missing = router.select(agents, {
    prompt: "iOS 앱 구현",
    role: "ios",
    capabilities: ["swift"],
    minimumScore: 35,
  });
  assert.equal(missing.decision, "spawn");
  assert.equal(missing.selectedAgent, null);
});

test("router rolls a heavily reused session into a fresh fork", () => {
  const router = new AgentRouter();
  const result = router.select([{
    id: "reviewer_old",
    cwd: "/repo",
    status: "idle",
    role: "reviewer",
    capabilities: ["review"],
    metadata: { reuseCount: 12 },
  }], {
    prompt: "review",
    cwd: "/repo",
    role: "reviewer",
    capabilities: ["review"],
    reuseExisting: true,
  });
  assert.equal(result.decision, "fork");
  assert.equal(result.rolloverRequired, true);
  assert.match(result.reasons.at(-1), /fresh context window/);
});

test("router never selects an agent missing a required capability or tool", () => {
  const router = new AgentRouter();
  const result = router.select([{
    id: "high_score_but_incomplete",
    cwd: "/repo",
    status: "idle",
    role: "reviewer",
    capabilities: ["review"],
    metadata: { tools: ["git"] },
    summary: "review review review security test analysis",
  }], {
    prompt: "review security test analysis",
    cwd: "/repo",
    role: "reviewer",
    capabilities: ["review", "test-analysis"],
    tools: ["git", "node"],
    minimumScore: 0,
  });
  assert.equal(result.decision, "spawn");
  assert.equal(result.selectedAgent, null);
  assert.equal(result.candidates[0].eligible, false);
  assert.match(result.blockers[0], /required capability and tool/);
  assert.deepEqual(result.candidates[0].requirementMatrix.capabilities.missing, ["test-analysis"]);
  assert.deepEqual(result.candidates[0].requirementMatrix.tools.missing, ["node"]);
  assert.equal(result.provenance.decisionSource, "agent_router");
});

test("terminal runs and idle agents support durable archive scopes while active or leased targets are rejected", () => {
  const registry = new ControlRegistry({ path: ":memory:" });
  registry.createRun({ id: "terminal", status: "completed" });
  registry.createRun({ id: "active_run", status: "running" });
  assert.throws(() => registry.archiveRun("active_run"), (error) => error.code === "ARCHIVE_ACTIVE_RUN");
  assert.ok(registry.archiveRun("terminal").archivedAt);
  assert.deepEqual(registry.listRuns({ scope: "active" }).map((run) => run.id), ["active_run"]);
  assert.deepEqual(registry.listRuns({ scope: "archived" }).map((run) => run.id), ["terminal"]);
  assert.equal(registry.listRuns({ scope: "all" }).length, 2);
  assert.equal(registry.unarchiveRun("terminal").archivedAt, null);

  registry.upsertAgent({ id: "idle_agent", status: "idle" });
  registry.upsertAgent({ id: "busy_agent", status: "running" });
  registry.upsertAgent({ id: "leased_agent", status: "idle" });
  registry.createTask({ id: "lease_task", prompt: "lease" });
  const claim = registry.claimTask("lease_task", "daemon");
  registry.acquireAgentLease("leased_agent", "lease_task", claim.claimToken, 60_000);
  assert.throws(() => registry.archiveAgent("busy_agent"), (error) => error.code === "ARCHIVE_ACTIVE_AGENT");
  assert.throws(() => registry.archiveAgent("leased_agent"), (error) => error.code === "ARCHIVE_LEASED_AGENT");
  assert.ok(registry.archiveAgent("idle_agent").archivedAt);
  assert.deepEqual(registry.listAgents({ scope: "archived" }).map((agent) => agent.id), ["idle_agent"]);
  assert.equal(registry.listAgents({ scope: "all" }).length, 3);
  assert.equal(registry.unarchiveAgent("idle_agent").archivedAt, null);
  registry.close();
});

test("routing provenance, archive state, and memory freshness metadata survive registry reopen", () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-control-provenance-"));
  const path = join(directory, "registry.sqlite");
  try {
    const first = new ControlRegistry({ path });
    first.upsertAgent({ id: "durable_agent", cwd: "/repo", status: "idle" }, { capabilities: ["api"], metadata: { tools: ["node"] } });
    first.createRun({ id: "durable_run", cwd: "/repo", status: "completed" });
    first.createTask({ id: "durable_task", prompt: "route", cwd: "/repo" });
    const claim = first.claimTask("durable_task", "daemon");
    const routing = new AgentRouter().select(first.listAgents({ scope: "active" }), { cwd: "/repo", capabilities: ["api"], tools: ["node"] });
    first.bindClaim("durable_task", "daemon", claim.claimToken, { agentId: "durable_agent", mode: "reused", routing });
    first.completeClaim("durable_task", "daemon", claim.claimToken, { output: "done" });
    first.archiveRun("durable_run");
    first.archiveAgent("durable_agent");
    first.upsertMemory({ id: "durable_memory", cwd: "/repo", kind: "fact", title: "Package version", content: "0.14.0", source: "repository", authority: "primary", subject: "package-version", semanticVersion: "0.14.0", supersedes: ["old"] });
    first.close();

    const second = new ControlRegistry({ path });
    assert.equal(second.getTask("durable_task").routing.provenance.decisionSource, "agent_router");
    assert.equal(second.getTask("durable_task").routing.selectedRequirementMatrix.tools.allSatisfied, true);
    assert.deepEqual(second.listRuns({ scope: "archived" }).map((run) => run.id), ["durable_run"]);
    assert.deepEqual(second.listAgents({ scope: "archived" }).map((agent) => agent.id), ["durable_agent"]);
    const memory = second.getMemory("durable_memory");
    assert.equal(memory.authority, "primary");
    assert.equal(memory.semanticVersion, "0.14.0");
    assert.deepEqual(memory.supersedes, ["old"]);
    second.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("project memories persist with project-tree scope", () => {
  const registry = new ControlRegistry({ path: ":memory:" });
  const memory = registry.upsertMemory({ cwd: "/repo", kind: "constraint", content: "Node 20 이상", tags: ["node"] });
  assert.equal(registry.listMemories({ cwd: "/repo/packages/app" })[0].id, memory.id);
  registry.touchMemories([memory.id]);
  assert.ok(registry.getMemory(memory.id).lastUsedAt);
  registry.upsertMemory({ ...memory, content: "Node 22 이상" });
  assert.equal(registry.getMemory(memory.id).content, "Node 22 이상");
  assert.equal(registry.deleteMemory(memory.id).id, memory.id);
  assert.equal(registry.getMemory(memory.id), null);
  registry.close();
});

test("dependency tasks unblock only after every parent completes", () => {
  const registry = new ControlRegistry({ path: ":memory:" });
  registry.createTask({ id: "parent_1", prompt: "one" });
  registry.createTask({ id: "parent_2", prompt: "two" });
  registry.createTask({ id: "child", prompt: "child", dependsOn: ["parent_1", "parent_2"] });
  assert.equal(registry.getTask("child").status, "blocked");

  registry.updateTask("parent_1", { status: "completed", completedAt: new Date().toISOString() });
  registry.refreshBlockedTasks();
  assert.equal(registry.getTask("child").status, "blocked");

  registry.updateTask("parent_2", { status: "completed", completedAt: new Date().toISOString() });
  registry.refreshBlockedTasks();
  assert.equal(registry.getTask("child").status, "queued");
  assert.deepEqual(registry.getTask("child").dependencies.map((entry) => entry.taskId), ["parent_1", "parent_2"]);
  registry.close();
});

test("claim is atomic and retry uses bounded exponential backoff", () => {
  const registry = new ControlRegistry({ path: ":memory:" });
  registry.createTask({ id: "retry", prompt: "retry", maxAttempts: 2, retryDelayMs: 10 });
  assert.equal(registry.claimTask("retry", "worker_1").attempt, 1);
  assert.equal(registry.claimTask("retry", "worker_2"), null);
  const retrying = registry.scheduleRetry("retry", "temporary");
  assert.equal(retrying.status, "retry_waiting");
  assert.equal(retrying.workerId, null);
  registry.updateTask("retry", { nextRetryAt: new Date(0).toISOString() });
  assert.equal(registry.claimTask("retry", "worker_2").attempt, 2);
  const failed = registry.scheduleRetry("retry", "permanent");
  assert.equal(failed.status, "failed");
  registry.close();
});

test("two registry connections cannot claim once and stale completion is fenced", () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-control-claim-"));
  const path = join(directory, "registry.sqlite");
  try {
    const first = new ControlRegistry({ path });
    const second = new ControlRegistry({ path });
    first.createTask({ id: "shared", prompt: "shared" });
    const claimed = first.claimTask("shared", "worker_1");
    assert.ok(claimed.claimToken);
    assert.equal(second.claimTask("shared", "worker_2"), null);

    second.recoverInterruptedTasks({ staleBefore: new Date(Date.now() + 1000).toISOString() });
    assert.equal(first.completeClaim("shared", "worker_1", claimed.claimToken, { output: "late" }), null);
    assert.equal(second.getTask("shared").status, "recovery_attention");
    first.close();
    second.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("worktree lease has one active owner and can be released", () => {
  const registry = new ControlRegistry({ path: ":memory:" });
  registry.createTask({ id: "owner_1", prompt: "one" });
  registry.createTask({ id: "owner_2", prompt: "two" });
  const first = registry.acquireLease({ key: "repo:feature", ownerTaskId: "owner_1", worktreePath: "/tmp/one" });
  assert.equal(first.ownerTaskId, "owner_1");
  assert.equal(registry.acquireLease({ key: "repo:feature", ownerTaskId: "owner_2" }), null);
  assert.equal(registry.renewLease("repo:feature", "owner_1", 60_000).status, "active");
  assert.equal(registry.releaseLease("repo:feature", "owner_1").status, "released");
  assert.equal(registry.acquireLease({ key: "repo:feature", ownerTaskId: "owner_2" }).ownerTaskId, "owner_2");

  registry.db.prepare("UPDATE worktree_leases SET expires_at = ? WHERE lease_key = ?").run(new Date(0).toISOString(), "repo:feature");
  assert.equal(registry.listLeases({ status: "expired" })[0].status, "expired");
  assert.equal(registry.acquireLease({ key: "repo:feature", ownerTaskId: "owner_1" }), null);
  assert.equal(registry.releaseLease("repo:feature", "owner_2").status, "released");
  registry.close();
});

test("agent lease enforces one task owner and recovers an expired lifecycle", () => {
  const registry = new ControlRegistry({ path: ":memory:" });
  registry.upsertAgent({ id: "agent_shared", cwd: "/repo", status: "idle" });
  const first = registry.acquireAgentLease("agent_shared", "task_one", "token_one", 60_000);
  assert.equal(first.ownerTaskId, "task_one");
  assert.equal(registry.acquireAgentLease("agent_shared", "task_two", "token_two", 60_000), null);
  assert.equal(registry.renewAgentLease("agent_shared", "task_one", "token_one", 60_000).status, "active");
  assert.equal(registry.releaseAgentLease("agent_shared", "task_one", "token_one").status, "released");
  assert.equal(registry.acquireAgentLease("agent_shared", "task_two", "token_two", 60_000).ownerTaskId, "task_two");

  registry.updateAgent("agent_shared", { status: "running", metadata: { currentTaskId: "task_two" } });
  registry.db.prepare("UPDATE agent_leases SET expires_at = ? WHERE agent_id = ?").run(new Date(0).toISOString(), "agent_shared");
  assert.equal(registry.recoverExpiredAgentLeases(), 1);
  assert.equal(registry.getAgentLease("agent_shared").status, "expired");
  assert.equal(registry.getAgent("agent_shared").status, "idle");
  assert.equal(registry.getAgent("agent_shared").metadata.currentTaskId, null);
  registry.close();
});

test("dashboard lease fences competing daemon owners", () => {
  const registry = new ControlRegistry({ path: ":memory:" });
  const first = registry.acquireDashboardLease("dashboard", "daemon_1", { ttlMs: 60_000 });
  assert.equal(first.ownerId, "daemon_1");
  assert.equal(registry.acquireDashboardLease("dashboard", "daemon_2", { ttlMs: 60_000 }), null);
  assert.equal(registry.renewDashboardLease("dashboard", "daemon_1", first.token, 60_000).ownerId, "daemon_1");
  assert.equal(registry.releaseDashboardLease("dashboard", "daemon_1", "wrong"), false);
  assert.equal(registry.releaseDashboardLease("dashboard", "daemon_1", first.token), true);
  assert.equal(registry.acquireDashboardLease("dashboard", "daemon_2", { ttlMs: 60_000 }).ownerId, "daemon_2");
  registry.close();
});

test("dashboard gate keeps a run staged and releases roots before dependencies", () => {
  const registry = new ControlRegistry({ path: ":memory:" });
  registry.createRun({ id: "run_1", name: "gate", cwd: "/repo", status: "awaiting_user_start" });
  const metadata = { runId: "run_1", execution: {} };
  registry.createTask({ id: "root", prompt: "root", status: "staged", metadata });
  registry.createTask({ id: "child", prompt: "child", status: "staged", dependsOn: ["root"], metadata });
  assert.deepEqual(registry.listRunnableTasks(), []);

  const released = registry.releaseStagedRun("run_1", { source: "test" });
  assert.equal(released.releasedTasks, 2);
  assert.equal(registry.getTask("root").status, "queued");
  assert.equal(registry.getTask("child").status, "blocked");
  assert.equal(registry.getRun("run_1").status, "running");
  assert.deepEqual(registry.listRunnableTasks().map((task) => task.id), ["root"]);
  registry.close();
});

test("cwd scope includes parent and child working directories", () => {
  const registry = new ControlRegistry({ path: ":memory:" });
  registry.upsertAgent({ id: "child", cwd: "/repo/packages/app", status: "idle" });
  registry.upsertAgent({ id: "parent", cwd: "/repo", status: "idle" });
  assert.deepEqual(registry.listAgents({ cwd: "/repo" }).map((agent) => agent.id).sort(), ["child", "parent"]);
  assert.deepEqual(registry.listAgents({ cwd: "/repo/packages/app" }).map((agent) => agent.id).sort(), ["child", "parent"]);
  registry.close();
});

test("task graph creation is atomic and idempotent", () => {
  const registry = new ControlRegistry({ path: ":memory:" });
  assert.throws(() => registry.createTaskGraph({ id: "bad_run" }, [
    { id: "a", prompt: "a", dependsOn: ["missing"] },
  ]), /missing/i);
  assert.equal(registry.getRun("bad_run"), null);
  assert.deepEqual(registry.listTasks({ limit: 10 }), []);

  const first = registry.createTaskGraph({ id: "run_atomic", requestKey: "request-1", cwd: "/repo" }, [
    { id: "b", prompt: "b", dependsOn: ["a"] },
    { id: "a", prompt: "a" },
  ]);
  assert.equal(first.tasks.length, 2);
  const repeated = registry.createTaskGraph({ id: "ignored", requestKey: "request-1", cwd: "/repo" }, [{ id: "x", prompt: "x" }]);
  assert.equal(repeated.idempotent, true);
  assert.equal(repeated.run.id, "run_atomic");
  assert.equal(registry.getRun("ignored"), null);

  registry.createRun({ id: "run_accepted", requestKey: "request-accepted", cwd: "/repo", status: "accepted", metadata: { dispatchPhase: "accepted" } });
  const materialized = registry.createTaskGraph({ id: "run_accepted", requestKey: "request-accepted", cwd: "/repo", status: "awaiting_user_start", metadata: { dispatchPhase: "prepared" } }, [
    { id: "accepted_task", prompt: "work", status: "staged" },
  ]);
  assert.equal(materialized.idempotent, false);
  assert.equal(materialized.run.status, "awaiting_user_start");
  assert.equal(materialized.run.metadata.dispatchPhase, "prepared");
  assert.equal(materialized.tasks.length, 1);
  registry.close();
});

test("plans approvals worktrees and role templates persist", () => {
  const registry = new ControlRegistry({ path: ":memory:" });
  registry.createPlan({ id: "plan_1", objective: "ship", cwd: "/repo" });
  registry.updatePlan("plan_1", { status: "planned", plan: { tasks: [] } });
  assert.equal(registry.getPlan("plan_1").status, "planned");
  registry.createApproval({ id: "approval_1", method: "item/fileChange/requestApproval", taskId: null });
  assert.equal(registry.resolveApproval("approval_1", "accept").decision, "accept");
  registry.upsertManagedWorktree({ id: "wt_1", repoRoot: "/repo", path: "/tmp/wt", status: "active" });
  assert.equal(registry.listManagedWorktrees()[0].status, "active");
  registry.upsertRoleTemplate({ name: "swift", developerInstructions: "Implement Swift safely", capabilities: ["swift"], skills: ["ios-review"], effort: "high", sandbox: "workspace-write" });
  assert.deepEqual(registry.getRoleTemplate("swift").capabilities, ["swift"]);
  assert.deepEqual(registry.getRoleTemplate("swift").skills, ["ios-review"]);
  registry.close();
});

test("validation rejection is terminal and blocks dependent work", () => {
  const registry = new ControlRegistry({ path: ":memory:" });
  registry.createRun({ id: "run_validation", status: "running" });
  registry.createTask({ id: "implementation", prompt: "implement", metadata: { runId: "run_validation", acceptanceCriteria: ["tests pass"] } });
  registry.createTask({ id: "release", prompt: "release", dependsOn: ["implementation"], metadata: { runId: "run_validation" } });
  const claim = registry.claimTask("implementation", "worker");
  registry.markClaimAgentDone("implementation", "worker", claim.claimToken, { output: "tests failed" });
  registry.markClaimValidating("implementation", "worker", claim.claimToken);
  registry.finishValidationClaim("implementation", "worker", claim.claimToken, { decision: "reject", summary: "Tests failed", evidence: [], unmetCriteria: ["tests pass"] });
  registry.refreshBlockedTasks();
  assert.equal(registry.getTask("implementation").status, "rejected");
  assert.equal(registry.getTask("release").status, "failed");
  assert.equal(registry.refreshRun("run_validation").status, "failed");
  registry.close();
});

test("completed_with_warnings is terminal, unblocks dependencies, and completes its run", () => {
  const registry = new ControlRegistry({ path: ":memory:" });
  registry.createRun({ id: "run_warning", status: "running" });
  registry.createTask({ id: "warning", prompt: "warning", metadata: { runId: "run_warning" } });
  registry.createTask({ id: "downstream", prompt: "downstream", status: "blocked", dependsOn: ["warning"], metadata: { runId: "run_warning" } });
  registry.updateTask("warning", { status: "completed_with_warnings", completedAt: new Date().toISOString() });
  registry.refreshBlockedTasks();
  assert.equal(registry.getTask("downstream").status, "queued");
  registry.updateTask("downstream", { status: "completed", completedAt: new Date().toISOString() });
  assert.equal(registry.refreshRun("run_warning").status, "completed");
  registry.close();
});

test("validation infrastructure errors are never completed and persist exhausted failure details", () => {
  const registry = new ControlRegistry({ path: ":memory:" });
  registry.createTask({ id: "validation_warning", prompt: "work", metadata: { acceptanceCriteria: ["checked"] } });
  const claim = registry.claimTask("validation_warning", "worker");
  registry.markClaimAgentDone("validation_warning", "worker", claim.claimToken, { output: "done" });
  registry.markClaimValidating("validation_warning", "worker", claim.claimToken);
  registry.finishValidationClaim("validation_warning", "worker", claim.claimToken, { decision: "error", summary: "validator unavailable" });
  const failed = registry.getTask("validation_warning");
  assert.equal(failed.status, "validation_failed");
  assert.equal(failed.metadata.failure.type, "infrastructure");
  assert.equal(failed.metadata.failure.retryable, true);
  assert.deepEqual(failed.metadata.failure.attemptBudget, { used: 1, max: 1, remaining: 0 });
  assert.equal(failed.metadata.failure.exhausted, true);
  registry.close();
});

test("validator rejection schedules bounded rework and repeated feedback is deduplicated across reopen", () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-control-rework-"));
  const path = join(directory, "registry.sqlite");
  try {
    const first = new ControlRegistry({ path });
    first.createTask({ id: "rework", prompt: "implement", maxAttempts: 3, retryDelayMs: 0, metadata: { acceptanceCriteria: ["tests pass"] } });
    const firstClaim = first.claimTask("rework", "daemon_1");
    first.markClaimAgentDone("rework", "daemon_1", firstClaim.claimToken, { output: "first" });
    first.markClaimValidating("rework", "daemon_1", firstClaim.claimToken);
    const feedback = { decision: "reject", summary: "Tests still fail", evidence: ["exit 1"], unmetCriteria: ["tests pass"] };
    const waiting = first.finishValidationClaim("rework", "daemon_1", firstClaim.claimToken, feedback);
    assert.equal(waiting.status, "retry_waiting");
    assert.equal(waiting.metadata.failure.nextAction, "rework");
    assert.deepEqual(waiting.metadata.failure.attemptBudget, { used: 1, max: 3, remaining: 2 });
    assert.equal(waiting.metadata.failure.exhausted, false);
    const hash = waiting.metadata.rework.current.feedbackHash;
    first.close();

    const second = new ControlRegistry({ path });
    const secondClaim = second.claimTask("rework", "daemon_2");
    assert.ok(secondClaim);
    assert.equal(second.claimTask("rework", "daemon_3"), null);
    second.markClaimAgentDone("rework", "daemon_2", secondClaim.claimToken, { output: "second" });
    second.markClaimValidating("rework", "daemon_2", secondClaim.claimToken);
    const terminal = second.finishValidationClaim("rework", "daemon_2", secondClaim.claimToken, feedback);
    assert.equal(terminal.status, "rejected");
    assert.equal(terminal.metadata.failure.duplicateFeedback, true);
    assert.equal(terminal.metadata.failure.exhausted, true);
    assert.equal(terminal.metadata.failure.nextAction, "manual_intervention");
    assert.equal(terminal.metadata.failureHistory.length, 2);
    assert.equal(terminal.metadata.rework.feedbackHashes[0], hash);
    assert.equal(second.finishValidationClaim("rework", "daemon_2", secondClaim.claimToken, feedback), null, "stale validator completion stays fenced");
    second.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("infrastructure failures use bounded retry rather than validator rework", () => {
  const registry = new ControlRegistry({ path: ":memory:" });
  registry.createTask({ id: "infra_retry", prompt: "work", maxAttempts: 2, retryDelayMs: 0 });
  const first = registry.claimTask("infra_retry", "daemon");
  const waiting = registry.finishFailureClaim("infra_retry", "daemon", first.claimToken, {
    type: "infrastructure", stage: "execution", cause: "app-server disconnected", message: "app-server disconnected", retryable: true, nextAction: "retry",
  });
  assert.equal(waiting.status, "retry_waiting");
  assert.equal(waiting.metadata.failure.nextAction, "retry");
  assert.equal(waiting.metadata.failure.exhausted, false);

  const second = registry.claimTask("infra_retry", "daemon");
  const exhausted = registry.finishFailureClaim("infra_retry", "daemon", second.claimToken, {
    type: "infrastructure", stage: "execution", cause: "app-server disconnected", message: "app-server disconnected", retryable: true, nextAction: "retry",
  });
  assert.equal(exhausted.status, "failed");
  assert.equal(exhausted.metadata.failure.nextAction, "manual_intervention");
  assert.equal(exhausted.metadata.failure.exhausted, true);
  assert.deepEqual(exhausted.metadata.failure.attemptBudget, { used: 2, max: 2, remaining: 0 });
  registry.close();
});
