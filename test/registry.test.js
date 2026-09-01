import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { ControlRegistry, CURRENT_SCHEMA_VERSION } from "../src/registry.js";
import { AgentRouter } from "../src/router.js";
import { compileExecutionContract } from "../src/execution-contracts.js";

test("registry persists only the four canonical notification kinds", () => {
  const registry = new ControlRegistry({ path: ":memory:" });
  const legacy = registry.createNotification({ kind: "run_completed", dedupeKey: "legacy-complete", title: "done" });
  assert.equal(legacy.kind, "completed");
  assert.equal(legacy.severity, "success");

  registry.createTaskGraph({ id: "policy_run", cwd: "/repo", status: "running" }, [
    { id: "policy_task", prompt: "external mutation", status: "blocked_by_policy" },
  ]);
  registry.refreshRun("policy_run");
  const notification = registry.listNotifications({ runId: "policy_run" })[0];
  assert.equal(notification.kind, "policy_blocked");
  assert.equal(notification.title, "정책으로 작업 중단");
  assert.throws(() => registry.createNotification({ kind: "progress_update", dedupeKey: "quiet-progress" }), /Unsupported notification kind/);
  registry.close();
});

test("terminal Run state always owns the projected dispatch phase", () => {
  const registry = new ControlRegistry({ path: ":memory:" });
  registry.createRun({ id: "terminal_phase", cwd: "/repo", status: "planning", metadata: { dispatchPhase: "planning" } });
  const failed = registry.updateRun("terminal_phase", { status: "failed", completedAt: new Date().toISOString() });
  assert.equal(failed.metadata.dispatchPhase, "failed");
  registry.close();
});

test("Control Plane result delivery is durable, idempotent, and retryable", () => {
  const registry = new ControlRegistry({ path: ":memory:" });
  registry.createRun({ id: "run_delivery", cwd: "/repo", status: "completed" });
  const created = registry.enqueueControlDelivery({
    runId: "run_delivery",
    originThreadId: "control_thread",
    originTurnId: "origin_turn",
    payload: { summary: "done" },
  });
  assert.equal(created.status, "pending");
  assert.equal(registry.enqueueControlDelivery({ runId: "run_delivery", originThreadId: "control_thread", payload: { summary: "updated" } }).id, created.id);
  assert.equal(registry.listControlDeliveries({ originThreadId: "control_thread", ready: true })[0].payload.summary, "updated");
  const deferred = registry.deferControlDelivery(created.id, new Error("active writer"), 0);
  assert.equal(deferred.status, "retry_waiting");
  assert.equal(deferred.attempt, 1);
  const delivered = registry.markControlDeliveryDelivered(created.id, "delivered_turn");
  assert.equal(delivered.status, "delivered");
  assert.equal(delivered.deliveredTurnId, "delivered_turn");
  registry.close();
});

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
    assert.equal(second.getTask("task_1").status, "failed");
    assert.equal(second.getTask("task_1").metadata.failure.nextAction, "repair_contract");
    second.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("legacy database upgrades transactionally with backup, run foreign key, and status constraint", () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-control-migration-"));
  const path = join(directory, "registry.sqlite");
  const legacy = new DatabaseSync(path);
  legacy.exec(`
    CREATE TABLE runs (
      id TEXT PRIMARY KEY, request_key TEXT, plan_id TEXT, name TEXT, status TEXT NOT NULL,
      cwd TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, started_at TEXT,
      completed_at TEXT, archived_at TEXT, metadata_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY, status TEXT NOT NULL, prompt TEXT NOT NULL, cwd TEXT,
      source_thread_id TEXT, agent_id TEXT, mode TEXT, output TEXT, error TEXT, turn_id TEXT,
      role TEXT, required_capabilities_json TEXT NOT NULL DEFAULT '[]', routing_json TEXT,
      created_at TEXT NOT NULL, started_at TEXT, completed_at TEXT, updated_at TEXT NOT NULL,
      worker_id TEXT, heartbeat_at TEXT, attempt INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 1, retry_delay_ms INTEGER NOT NULL DEFAULT 0,
      next_retry_at TEXT, claim_token TEXT, version INTEGER NOT NULL DEFAULT 0,
      metadata_json TEXT NOT NULL DEFAULT '{}'
    );
    INSERT INTO runs (id, status, created_at, updated_at) VALUES ('legacy_run', 'running', '2026-01-01', '2026-01-01');
    INSERT INTO tasks (id, status, prompt, created_at, updated_at, metadata_json)
      VALUES ('legacy_task', 'queued', 'legacy', '2026-01-01', '2026-01-01', '{"runId":"legacy_run"}');
    PRAGMA user_version = 0;
  `);
  legacy.close();
  try {
    const registry = new ControlRegistry({ path });
    assert.equal(registry.schemaVersion, CURRENT_SCHEMA_VERSION);
    assert.equal(registry.getTask("legacy_task").runId, "legacy_run");
    assert.equal(existsSync(registry.migrationBackupPath), true);
    assert.equal(registry.db.prepare("PRAGMA foreign_key_list(tasks)").all().some((entry) => entry.from === "run_id" && entry.table === "runs"), true);
    assert.throws(() => registry.db.prepare("UPDATE tasks SET status = 'not_a_state' WHERE id = 'legacy_task'").run(), /CHECK constraint failed/);
    registry.close();

    const reopened = new ControlRegistry({ path });
    assert.equal(reopened.schemaVersionBeforeMigration, CURRENT_SCHEMA_VERSION);
    assert.equal(reopened.migrationBackupPath, null);
    assert.equal(reopened.getTask("legacy_task").runId, "legacy_run");
    reopened.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("schema v1 expands canonical projects and backfills legacy memories as unverified candidate claims", () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-project-migration-"));
  const projectRoot = join(directory, "project");
  const missingRoot = join(directory, "missing-project");
  const path = join(directory, "registry.sqlite");
  mkdirSync(projectRoot);
  const legacy = new DatabaseSync(path);
  legacy.exec(`
    CREATE TABLE project_memories (
      id TEXT PRIMARY KEY,
      cwd TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'note',
      title TEXT,
      content TEXT NOT NULL,
      tags_json TEXT NOT NULL DEFAULT '[]',
      source TEXT NOT NULL DEFAULT 'user',
      authority TEXT NOT NULL DEFAULT 'reference',
      subject TEXT,
      semantic_version TEXT,
      supersedes_json TEXT NOT NULL DEFAULT '[]',
      confidence REAL NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_used_at TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}'
    );
  `);
  legacy.prepare(`
    INSERT INTO project_memories (
      id, cwd, kind, content, created_at, updated_at
    ) VALUES (?, ?, 'decision', ?, '2026-01-01', '2026-01-01')
  `).run("legacy_valid", projectRoot, "Use the canonical project registry");
  legacy.prepare(`
    INSERT INTO project_memories (
      id, cwd, kind, content, created_at, updated_at
    ) VALUES (?, ?, 'fact', ?, '2026-01-01', '2026-01-01')
  `).run("legacy_missing", missingRoot, "This path no longer exists");
  legacy.exec("PRAGMA user_version = 1");
  legacy.close();

  try {
    const registry = new ControlRegistry({ path });
    assert.equal(registry.schemaVersion, CURRENT_SCHEMA_VERSION);
    assert.equal(existsSync(registry.migrationBackupPath), true);
    assert.equal(registry.listProjects().length, 1);
    assert.ok(registry.getMemory("legacy_valid").projectId);
    assert.equal(registry.getMemory("legacy_missing").projectId, null);

    const claims = registry.listContextClaims({ authority: "legacy_unverified" });
    assert.equal(claims.length, 2);
    assert.ok(claims.every((claim) => claim.status === "candidate"));
    assert.ok(claims.find((claim) => claim.metadata.legacyMemoryId === "legacy_valid").projectId);
    assert.equal(claims.find((claim) => claim.metadata.legacyMemoryId === "legacy_missing").projectId, null);
    assert.ok(registry.listMigrationAttention({ kind: "project_identity_unresolved" }).some((entry) => entry.sourceValue === missingRoot));
    assert.ok(registry.listMigrationAttention({ kind: "legacy_memory_project_unresolved" }).some((entry) => entry.sourceId === "legacy_missing"));
    registry.close();

    const reopened = new ControlRegistry({ path });
    assert.equal(reopened.migrationBackupPath, null);
    assert.equal(reopened.listProjects().length, 1);
    assert.equal(reopened.listContextClaims({ authority: "legacy_unverified" }).length, 2);
    assert.equal(reopened.listMigrationAttention().filter((entry) => entry.sourceValue === missingRoot).length, 2);
    reopened.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("new project-scoped entities persist the same canonical project id", () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-project-write-"));
  const projectRoot = join(directory, "project");
  const nested = join(projectRoot, "packages", "app");
  mkdirSync(nested, { recursive: true });
  const registry = new ControlRegistry({ path: ":memory:" });
  try {
    const project = registry.registerProject(projectRoot);
    const run = registry.createRun({ id: "project_run", cwd: projectRoot, status: "draft" });
    const task = registry.createTask({ id: "project_task", cwd: projectRoot, prompt: "inspect" });
    const agent = registry.upsertAgent({ id: "project_agent", cwd: projectRoot, status: "idle" });
    const plan = registry.createPlan({ id: "project_plan", cwd: projectRoot, objective: "inspect" });
    const memory = registry.upsertMemory({ id: "project_memory", cwd: projectRoot, content: "shared identity" });

    assert.deepEqual(
      [run.projectId, task.projectId, agent.projectId, plan.projectId, memory.projectId],
      Array(5).fill(project.id),
    );
    assert.equal(registry.listProjects().length, 1);
    assert.deepEqual(registry.listRuns({ projectId: project.id }).map((entry) => entry.id), [run.id]);
    assert.deepEqual(registry.listTasks({ projectId: project.id }).map((entry) => entry.id), [task.id]);
    assert.deepEqual(registry.listAgents({ projectId: project.id }).map((entry) => entry.id), [agent.id]);
    assert.deepEqual(registry.listPlans({ projectId: project.id }).map((entry) => entry.id), [plan.id]);
    assert.deepEqual(registry.listMemories({ projectId: project.id }).map((entry) => entry.id), [memory.id]);
    assert.equal(registry.listContextClaims({ projectId: project.id, authority: "legacy_unverified" }).length, 1);
  } finally {
    registry.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("explicit user decision memories become active provenance-backed context claims", () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-user-contract-"));
  const registry = new ControlRegistry({ path: ":memory:" });
  try {
    registry.upsertMemory({
      id: "user_start_contract",
      cwd: directory,
      kind: "decision",
      title: "Run start policy",
      content: "Runs require an explicit user Start.",
      source: "user",
      authority: "authoritative",
    });
    const claim = registry.listContextClaims({ authority: "user_explicit" })[0];
    assert.equal(claim.status, "active");
    assert.equal(claim.subject, "run_start_policy");
    assert.equal(registry.listContextClaimSources(claim.id)[0].kind, "legacy_memory");
  } finally {
    registry.close();
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

test("router rejects a reusable session below the required permission ceiling", () => {
  const router = new AgentRouter();
  const result = router.select([{
    id: "readonly_writer",
    cwd: "/repo",
    status: "idle",
    role: "implementer",
    capabilities: ["implementation"],
    metadata: { permissionCeiling: "read-only" },
  }], {
    prompt: "implement",
    cwd: "/repo",
    role: "implementer",
    capabilities: ["implementation"],
    executionContract: { fingerprint: "contract_1", sandbox: "workspace-write", workspaceMode: "shared" },
  });
  assert.equal(result.decision, "spawn");
  assert.match(result.candidates[0].blockers.join(" "), /permission ceiling/);
});

test("router forks instead of reusing a session with an active writer or locked approval policy", () => {
  const router = new AgentRouter();
  const busy = router.select([{
    id: "busy_writer", cwd: "/repo", status: "running", role: "implementer", capabilities: ["implementation"],
    metadata: { permissionCeiling: "workspace-write", currentTaskId: "other_task", approvalPolicy: "never", approvalPolicyLocked: true },
  }], {
    taskId: "new_task", prompt: "implement", cwd: "/repo", role: "implementer", capabilities: ["implementation"], reuseExisting: true,
    executionContract: { fingerprint: "writer_contract", sandbox: "workspace-write", workspaceMode: "shared", approvalPolicy: "never" },
  });
  assert.equal(busy.decision, "fork");
  assert.equal(busy.selectedRequirementMatrix.execution.writerAvailable, false);
  assert.match(busy.reasons.join(" "), /active writer ownership/);

  const locked = router.select([{
    id: "locked_policy", cwd: "/repo", status: "idle", role: "implementer", capabilities: ["implementation"],
    metadata: { permissionCeiling: "workspace-write", approvalPolicy: "on-request", approvalPolicyLocked: true },
  }], {
    prompt: "implement", cwd: "/repo", role: "implementer", capabilities: ["implementation"], reuseExisting: true,
    executionContract: { fingerprint: "policy_contract", sandbox: "workspace-write", workspaceMode: "shared", approvalPolicy: "never" },
  });
  assert.equal(locked.decision, "spawn");
  assert.match(locked.candidates[0].blockers.join(" "), /approval policy/);
});

test("dependency policies support always-run and failure-only tasks", () => {
  const registry = new ControlRegistry({ path: ":memory:" });
  registry.createTask({ id: "parent_failed", prompt: "parent", status: "failed" });
  registry.createTask({ id: "always", prompt: "cleanup", dependsOn: ["parent_failed"], metadata: { dependencyPolicy: "all_terminal" } });
  registry.createTask({ id: "fallback", prompt: "recover", dependsOn: ["parent_failed"], metadata: { dependencyPolicy: "on_failure" } });
  registry.createTask({ id: "parent_ok", prompt: "ok", status: "completed" });
  registry.createTask({ id: "unused_fallback", prompt: "recover", dependsOn: ["parent_ok"], metadata: { dependencyPolicy: "on_failure" } });
  registry.refreshBlockedTasks();
  assert.equal(registry.getTask("always").status, "queued");
  assert.equal(registry.getTask("fallback").status, "queued");
  assert.equal(registry.getTask("unused_fallback").status, "skipped");
  registry.close();
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

  const parent1Claim = registry.claimTask("parent_1", "worker_1");
  registry.completeClaim("parent_1", "worker_1", parent1Claim.claimToken, { output: "done" });
  registry.refreshBlockedTasks();
  assert.equal(registry.getTask("child").status, "blocked");

  const parent2Claim = registry.claimTask("parent_2", "worker_2");
  registry.completeClaim("parent_2", "worker_2", parent2Claim.claimToken, { output: "done" });
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

test("claim requires a matching validated contract marker", () => {
  const registry = new ControlRegistry({ path: ":memory:" });
  registry.createTask({ id: "validated_marker", prompt: "inspect" });
  const stored = registry.getTask("validated_marker");
  assert.equal(stored.metadata.contractStatus, "validated");
  assert.equal(stored.metadata.contractFingerprint, stored.metadata.executionContract.fingerprint);

  registry.db.prepare("UPDATE tasks SET metadata_json = json_remove(metadata_json, '$.contractStatus') WHERE id = ?").run("validated_marker");
  assert.equal(registry.claimTask("validated_marker", "worker"), null);
  assert.equal(registry.getTask("validated_marker").attempt, 0);
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
    assert.equal(second.getTask("shared").status, "queued");
    first.close();
    second.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("restart recovery automatically requeues only side-effect-free execution contracts", () => {
  const registry = new ControlRegistry({ path: ":memory:" });
  const safeContract = compileExecutionContract({ key: "safe_read", taskKind: "analysis", mutatesWorkspace: false });
  const writeContract = compileExecutionContract({ key: "uncertain_write", taskKind: "implementation", mutatesWorkspace: true, workspaceMode: "shared", integrationStrategy: "none" });
  registry.createTask({
    id: "safe_read",
    prompt: "inspect",
    status: "running",
    metadata: { executionContract: safeContract },
  });
  registry.createTask({
    id: "uncertain_write",
    prompt: "modify",
    status: "running",
    metadata: { executionContract: writeContract },
  });
  registry.recoverInterruptedTasks({ staleBefore: new Date(Date.now() + 1000).toISOString() });
  assert.equal(registry.getTask("safe_read").status, "queued");
  assert.equal(registry.getTask("uncertain_write").status, "recovery_attention");
  registry.close();
});

test("restart recovery terminalizes uncertain integration and clears claim ownership", () => {
  const registry = new ControlRegistry({ path: ":memory:" });
  const executionContract = compileExecutionContract({ key: "integrating", taskKind: "integration", mutatesWorkspace: true, workspaceMode: "shared", integrationStrategy: "none" });
  registry.createTask({ id: "integrating", prompt: "integrate", metadata: { executionContract } });
  const claim = registry.claimTask("integrating", "worker");
  registry.markClaimIntegrationPending("integrating", "worker", claim.claimToken, { strategy: "patch" });

  assert.equal(registry.recoverInterruptedTasks({ staleBefore: new Date(Date.now() + 1_000).toISOString() }), 1);
  const recovered = registry.getTask("integrating");
  assert.equal(recovered.status, "recovery_attention");
  assert.equal(recovered.workerId, null);
  assert.equal(recovered.claimToken, null);
  assert.equal(recovered.heartbeatAt, null);
  registry.close();
});

test("cancellation clears task ownership and releases active leases", () => {
  const registry = new ControlRegistry({ path: ":memory:" });
  registry.upsertAgent({ id: "agent", cwd: "/repo", status: "running" });
  registry.createTask({ id: "cancelled", prompt: "work", agentId: "agent" });
  const claim = registry.claimTask("cancelled", "worker");
  registry.acquireLease({ key: "workspace", ownerTaskId: "cancelled", ownerAgentId: "agent", ownerToken: claim.claimToken });
  registry.acquireAgentLease("agent", "cancelled", claim.claimToken);

  const cancelled = registry.cancelTask("cancelled");
  assert.equal(cancelled.status, "canceled");
  assert.equal(cancelled.workerId, null);
  assert.equal(cancelled.claimToken, null);
  assert.equal(cancelled.heartbeatAt, null);
  assert.equal(registry.listLeases({ ownerTaskId: "cancelled" })[0].status, "released");
  assert.equal(registry.getAgentLease("agent").status, "released");
  assert.equal(registry.getAgent("agent").status, "idle");
  registry.close();
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

  const replaced = registry.replaceStagedTaskGraph({
    id: "run_accepted", requestKey: "request-accepted", planId: "plan_v2", cwd: "/repo", name: "revision",
  }, [
    { id: "replacement_child", prompt: "new child", status: "staged", dependsOn: ["replacement_root"] },
    { id: "replacement_root", prompt: "new root", status: "staged" },
  ]);
  assert.equal(replaced.replaced, true);
  assert.equal(replaced.run.planId, "plan_v2");
  assert.deepEqual(replaced.tasks.map((task) => task.id).sort(), ["replacement_child", "replacement_root"]);
  assert.equal(registry.getTask("accepted_task"), null);
  registry.releaseStagedRun("run_accepted", { source: "test" });
  assert.throws(() => registry.replaceStagedTaskGraph({ id: "run_accepted" }, [{ id: "late", prompt: "late" }]), /cannot replace its graph/);
  registry.close();
});

test("every terminal dependency failure cascades through multiple blocked levels in one refresh", () => {
  for (const terminalStatus of ["rejected", "validation_failed", "failed", "canceled", "interrupted"]) {
    const registry = new ControlRegistry({ path: ":memory:" });
    const runId = `run_${terminalStatus}`;
    registry.createRun({ id: runId, status: "running" });
    registry.createTask({ id: `root_${terminalStatus}`, prompt: "root", status: terminalStatus, metadata: { runId } });
    registry.createTask({ id: `middle_${terminalStatus}`, prompt: "middle", status: "blocked", dependsOn: [`root_${terminalStatus}`], metadata: { runId } });
    registry.createTask({ id: `leaf_${terminalStatus}`, prompt: "leaf", status: "blocked", dependsOn: [`middle_${terminalStatus}`], metadata: { runId } });

    const refreshed = registry.refreshBlockedTasks();

    assert.equal(refreshed.failed, 2, terminalStatus);
    assert.equal(registry.getTask(`middle_${terminalStatus}`).status, "failed", terminalStatus);
    assert.equal(registry.getTask(`leaf_${terminalStatus}`).status, "failed", terminalStatus);
    assert.equal(registry.getRun(runId).status, "failed", terminalStatus);
    registry.close();
  }
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
  assert.equal(registry.getRun("run_validation").status, "failed");
  registry.close();
});

test("completed_with_warnings is terminal, unblocks dependencies, and completes its run", () => {
  const registry = new ControlRegistry({ path: ":memory:" });
  registry.createRun({ id: "run_warning", status: "running" });
  registry.createTask({ id: "warning", prompt: "warning", metadata: { runId: "run_warning" } });
  registry.createTask({ id: "downstream", prompt: "downstream", status: "blocked", dependsOn: ["warning"], metadata: { runId: "run_warning" } });
  const warningClaim = registry.claimTask("warning", "worker_warning");
  registry.markClaimAgentDone("warning", "worker_warning", warningClaim.claimToken, { output: "done with warning" });
  registry.markClaimValidating("warning", "worker_warning", warningClaim.claimToken);
  registry.finishValidationClaim("warning", "worker_warning", warningClaim.claimToken, { decision: "accept_with_warnings", summary: "minor warning" });
  registry.refreshBlockedTasks();
  assert.equal(registry.getTask("downstream").status, "queued");
  const downstreamClaim = registry.claimTask("downstream", "worker_downstream");
  registry.completeClaim("downstream", "worker_downstream", downstreamClaim.claimToken, { output: "done" });
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
    assert.equal(waiting.metadata.failure.retrySafety.reason, "validator_feedback_revision");
    assert.equal(waiting.metadata.rework.feedbackRevision, 1);
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
    assert.equal(terminal.metadata.rework.feedbackRevision, 1);
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

test("configuration failures never repeat under the same execution contract", () => {
  const registry = new ControlRegistry({ path: ":memory:" });
  const executionContract = compileExecutionContract({ key: "bad_contract", taskKind: "implementation", mutatesWorkspace: true, workspaceMode: "shared", integrationStrategy: "none" });
  registry.createTask({
    id: "bad_contract",
    prompt: "write files",
    maxAttempts: 3,
    metadata: { executionContract },
  });
  const claim = registry.claimTask("bad_contract", "daemon");
  const terminal = registry.finishFailureClaim("bad_contract", "daemon", claim.claimToken, {
    type: "configuration", category: "configuration", stage: "execution",
    cause: "read-only sandbox cannot modify files", retryable: true, nextAction: "repair_contract",
  }, { terminalStatus: "failed" });
  assert.equal(terminal.status, "failed");
  assert.equal(terminal.attempt, 1);
  assert.equal(terminal.metadata.failure.executionFingerprint, executionContract.fingerprint);
  assert.equal(terminal.metadata.failure.retryMutation.reason, "no_automatic_retry");
  assert.equal(registry.claimTask("bad_contract", "daemon"), null);
  registry.close();
});
