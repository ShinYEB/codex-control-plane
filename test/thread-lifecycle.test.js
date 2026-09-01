import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { ControlRegistry, CURRENT_SCHEMA_VERSION } from "../src/registry.js";
import { AgentRouter } from "../src/router.js";

function projectFixture(prefix = "thread-lifecycle-") {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  const cwd = join(directory, "project");
  mkdirSync(cwd);
  return { directory, cwd };
}

test("busy threads queue instead of exceeding project, role, or lineage budgets", () => {
  const { directory, cwd } = projectFixture();
  const registry = new ControlRegistry({ path: ":memory:" });
  try {
    const agent = registry.upsertAgent({ id: "busy_reviewer", cwd, status: "running" }, { role: "reviewer", capabilities: ["review"] });
    const budget = registry.upsertThreadBudget({ cwd, role: "reviewer", policy: {
      maxProjectThreads: 1, maxRoleThreads: 1, maxLineageForks: 0, maxReuseCount: 12,
      minContextHealth: 0, queueWhenBusy: true,
    } });
    const budgetState = registry.getThreadBudgetState({ cwd, role: "reviewer", sourceThreadId: agent.id });
    const result = new AgentRouter().select([agent], {
      cwd, role: "reviewer", capabilities: ["review"], prompt: "review", reuseExisting: true,
      lifecycleByAgent: { [agent.id]: registry.getThreadLifecycle(agent.id) },
      threadBudget: budget, threadBudgetStateByAgent: { [agent.id]: budgetState },
    });
    assert.equal(result.decision, "wait");
    assert.equal(result.selectedAgent.id, agent.id);
    assert.equal(result.budgetState.canCreateProject, false);
    assert.equal(result.budgetState.canForkLineage, false);
  } finally {
    registry.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("read-only one-off analysis may use an ephemeral worker when durable budget is full", () => {
  const result = new AgentRouter().select([], {
    prompt: "inspect the failure history", role: "analyst", capabilities: [], tools: [],
    executionContract: { taskKind: "analysis", sideEffectPolicy: "none", mutatesWorkspace: false },
    threadBudgetState: { canCreateProject: false, canCreateRole: false, canForkLineage: false },
  });
  assert.equal(result.decision, "ephemeral");
  assert.equal(result.ephemeral, true);
});

test("superseded threads retain lineage evidence and are excluded from routing", () => {
  const { directory, cwd } = projectFixture();
  const registry = new ControlRegistry({ path: ":memory:" });
  try {
    const oldThread = registry.upsertAgent({ id: "reviewer_old", cwd, status: "idle" }, { role: "reviewer" });
    const successor = registry.upsertAgent({ id: "reviewer_new", cwd, status: "idle" }, { role: "reviewer" });
    const snapshot = registry.upsertThreadKnowledgeSnapshot({
      threadId: successor.id, projectId: successor.projectId, role: "reviewer", sourceDigest: "successor-context",
      extractorVersion: "test-v1", status: "current", topics: ["contracts"], claimIds: [],
    });
    registry.transitionThreadLifecycle(oldThread.id, "superseded", {
      successorThreadId: successor.id, snapshotId: snapshot.id, reason: "context_rollover",
      evidence: { verified: true },
    });
    const ranked = new AgentRouter().rank([registry.getAgent(oldThread.id)], {
      cwd, role: "reviewer", prompt: "review contracts",
      lifecycleByAgent: { [oldThread.id]: registry.getThreadLifecycle(oldThread.id) },
    });
    assert.equal(ranked[0].eligible, false);
    assert.match(ranked[0].blockers.join(" "), /superseded/);
    assert.equal(registry.getAgent(oldThread.id).archivedAt, null);
    assert.equal(registry.listThreadLineage({ parentThreadId: oldThread.id })[0].threadId, successor.id);
  } finally {
    registry.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("archive and compaction are fenced while a thread owns unresolved work", () => {
  const registry = new ControlRegistry({ path: ":memory:" });
  try {
    registry.upsertAgent({ id: "integration_owner", status: "idle" });
    registry.createTask({ id: "integration_task", prompt: "integrate", agentId: "integration_owner", status: "integration_blocked" });
    assert.throws(
      () => registry.transitionThreadLifecycle("integration_owner", "compacted"),
      (error) => error.code === "THREAD_LIFECYCLE_UNRESOLVED_TASK",
    );
    assert.throws(
      () => registry.archiveAgent("integration_owner"),
      (error) => error.code === "THREAD_LIFECYCLE_UNRESOLVED_TASK",
    );
    assert.equal(registry.getThreadLifecycle("integration_owner").status, "idle");
  } finally {
    registry.close();
  }
});

test("thread budget revisions are immutable, scoped, and fingerprinted only from policy fields", () => {
  const { directory, cwd } = projectFixture();
  const registry = new ControlRegistry({ path: ":memory:" });
  try {
    const first = registry.upsertThreadBudget({ cwd, role: "qa", policy: { maxRoleThreads: 2 } });
    const second = registry.upsertThreadBudget({ cwd, role: "qa", policy: { maxRoleThreads: 1 } });
    assert.equal(first.version, 1);
    assert.equal(registry.db.prepare("SELECT status FROM thread_budgets WHERE id = ?").get(first.id).status, "superseded");
    assert.equal(second.version, 2);
    assert.equal(second.policy.cwd, undefined);
    assert.equal(second.policy.role, undefined);
    assert.notEqual(first.fingerprint, second.fingerprint);
    assert.throws(() => registry.upsertThreadBudget({ cwd, role: "qa", policy: { minContextHealth: 2 } }), (error) => error.code === "THREAD_BUDGET_INVALID");
  } finally {
    registry.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("schema v6 migrates thread lifecycle and budget tables with a backup and backfill", () => {
  const { directory, cwd } = projectFixture("thread-lifecycle-migration-");
  const path = join(directory, "registry.sqlite");
  try {
    const first = new ControlRegistry({ path });
    first.upsertAgent({ id: "legacy_thread", cwd, status: "idle" }, { role: "reviewer" });
    first.close();
    const legacy = new DatabaseSync(path);
    legacy.exec("DROP TABLE thread_lifecycle_events; DROP TABLE thread_lifecycle; DROP TABLE thread_budgets; PRAGMA user_version = 6;");
    legacy.close();

    const migrated = new ControlRegistry({ path });
    assert.equal(migrated.schemaVersion, CURRENT_SCHEMA_VERSION);
    assert.equal(existsSync(migrated.migrationBackupPath), true);
    assert.equal(migrated.getThreadLifecycle("legacy_thread").status, "idle");
    assert.equal(migrated.getThreadLifecycle("legacy_thread").threadType, "durable_specialist");
    migrated.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
