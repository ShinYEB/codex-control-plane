import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ContextResolver } from "../src/context-resolver.js";
import { ControlRegistry, CURRENT_SCHEMA_VERSION } from "../src/registry.js";

function fixture(options = {}) {
  const directory = mkdtempSync(join(tmpdir(), "global-runs-"));
  const projectA = join(directory, "project-a");
  const projectB = join(directory, "project-b");
  mkdirSync(projectA);
  mkdirSync(projectB);
  const registryPath = options.fileBacked ? join(directory, "registry.sqlite") : ":memory:";
  const registry = new ControlRegistry({ path: registryPath });
  const context = new ContextResolver(registry).resolve({ objective: "Coordinate projects" });
  registry.createGlobalRun({ id: "global", requestKey: "global-request", objective: "Coordinate projects" });
  registry.updateGlobalRun("global", { status: "resolving_context" });
  registry.updateGlobalRun("global", { status: "planning" });
  registry.updateGlobalRun("global", { status: "preparing" });
  const projectRuns = [
    { membership: "required", run: { id: "run_a", cwd: projectA }, tasks: [{ id: "task_a", prompt: "Project A" }] },
    { membership: "required", run: { id: "run_b", cwd: projectB }, tasks: [{ id: "task_b", prompt: "Project B" }] },
  ];
  const graph = (overrides = {}) => {
    const selectedProjectRuns = overrides.projectRuns ?? projectRuns;
    return {
      globalRunId: "global", revision: 1,
      contextSnapshotId: context.id, contextSnapshotFingerprint: context.fingerprint,
      projectRuns: selectedProjectRuns,
      authorizationManifests: selectedProjectRuns.map((entry) => ({
        runId: entry.run.id, allowedRoots: [entry.run.cwd], taskKinds: ["analysis"],
        mutatesWorkspace: false, sideEffectPolicies: ["none"], sandboxCeiling: "read-only",
        networkAccess: false, workspaceModes: ["shared"],
      })),
      dependencies: [], ...overrides,
    };
  };
  return { registry, registryPath, directory, projectRuns, graph, cleanup: () => { registry.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test("cyclic cross-project graph is rejected atomically before child Runs or Tasks exist", () => {
  const scope = fixture();
  try {
    assert.throws(() => scope.registry.createGlobalRunGraph(scope.graph({ dependencies: [
      { id: "a_to_b", producerRunId: "run_a", consumerRunId: "run_b" },
      { id: "b_to_a", producerRunId: "run_b", consumerRunId: "run_a" },
    ] })), (error) => error.code === "CROSS_PROJECT_GRAPH_CYCLE");
    assert.equal(scope.registry.getRun("run_a"), null);
    assert.equal(scope.registry.getRun("run_b"), null);
    assert.deepEqual(scope.registry.listTasks({ limit: 10 }), []);
    assert.equal(scope.registry.getGlobalRun("global").currentRevision, null);
  } finally { scope.cleanup(); }
});

test("Global Run public API defaults to v1 and rejects unsupported versions before persistence", () => {
  const scope = fixture();
  try {
    assert.throws(
      () => scope.registry.createGlobalRunGraph(scope.graph({ apiVersion: 2 })),
      (error) => error.code === "GLOBAL_RUN_API_VERSION_UNSUPPORTED",
    );
    assert.equal(scope.registry.getGlobalRun("global").currentRevision, null);
    assert.equal(scope.registry.getRun("run_a"), null);
    const created = scope.registry.createGlobalRunGraph(scope.graph());
    assert.equal(created.revision.metadata.apiVersion, 1);
  } finally { scope.cleanup(); }
});

test("a storage failure in a later Project Run rolls back the entire Global revision", () => {
  const scope = fixture();
  try {
    const projectRuns = scope.projectRuns.map((entry) => ({
      ...entry,
      tasks: [{ ...entry.tasks[0], id: "duplicate_global_task" }],
    }));
    assert.throws(() => scope.registry.createGlobalRunGraph(scope.graph({ projectRuns })), /UNIQUE constraint failed/);
    assert.equal(scope.registry.getRun("run_a"), null);
    assert.equal(scope.registry.getRun("run_b"), null);
    assert.deepEqual(scope.registry.listTasks({ limit: 10 }), []);
    assert.equal(scope.registry.getGlobalRun("global").currentRevision, null);
    assert.equal(scope.registry.getGlobalRunRevision("global:revision:1"), null);
  } finally { scope.cleanup(); }
});

test("validated Global graph releases roots then consumers only after producer success", () => {
  const scope = fixture();
  try {
    const created = scope.registry.createGlobalRunGraph(scope.graph({ dependencies: [
      { id: "a_to_b", producerRunId: "run_a", consumerRunId: "run_b", condition: "all_success", requiredOutputs: ["report"] },
    ] }));
    assert.equal(created.revision.status, "validated");
    assert.equal(scope.registry.getTask("task_a").status, "staged");
    assert.equal(scope.registry.getTask("task_b").status, "staged");

    scope.registry.releaseGlobalRun("global");
    assert.equal(scope.registry.getTask("task_a").status, "queued");
    assert.equal(scope.registry.getTask("task_b").status, "staged");
    const first = scope.registry.claimTask("task_a", "worker_a");
    scope.registry.completeClaim("task_a", "worker_a", first.claimToken, { output: "A done" });
    scope.registry.refreshRun("run_a");
    scope.registry.refreshGlobalRun("global");
    assert.equal(scope.registry.listCrossProjectDependencies(created.revision.id)[0].status, "satisfied");
    assert.equal(scope.registry.getTask("task_b").status, "queued");

    const second = scope.registry.claimTask("task_b", "worker_b");
    scope.registry.completeClaim("task_b", "worker_b", second.claimToken, { output: "B done" });
    scope.registry.refreshRun("run_b");
    const terminal = scope.registry.refreshGlobalRun("global");
    assert.equal(terminal.globalRun.status, "completed");
    assert.equal(terminal.result.status, "completed");
  } finally { scope.cleanup(); }
});

test("required failure fails Global Run while optional failure is preserved as a completion warning", () => {
  const requiredFailure = fixture();
  try {
    requiredFailure.registry.createGlobalRunGraph(requiredFailure.graph());
    requiredFailure.registry.releaseGlobalRun("global");
    requiredFailure.registry.updateTask("task_a", { status: "failed", completedAt: new Date().toISOString() });
    const requiredSuccess = requiredFailure.registry.claimTask("task_b", "worker_required_success");
    requiredFailure.registry.completeClaim("task_b", "worker_required_success", requiredSuccess.claimToken, { output: "done" });
    requiredFailure.registry.refreshRun("run_a");
    requiredFailure.registry.refreshRun("run_b");
    assert.equal(requiredFailure.registry.refreshGlobalRun("global").globalRun.status, "failed");
  } finally { requiredFailure.cleanup(); }

  const optionalFailure = fixture();
  try {
    const projectRuns = optionalFailure.projectRuns.map((entry) => entry.run.id === "run_b" ? { ...entry, membership: "optional" } : entry);
    optionalFailure.registry.createGlobalRunGraph(optionalFailure.graph({ projectRuns }));
    optionalFailure.registry.releaseGlobalRun("global");
    const optionalRequiredSuccess = optionalFailure.registry.claimTask("task_a", "worker_optional_required");
    optionalFailure.registry.completeClaim("task_a", "worker_optional_required", optionalRequiredSuccess.claimToken, { output: "done" });
    optionalFailure.registry.updateTask("task_b", { status: "failed", completedAt: new Date().toISOString() });
    optionalFailure.registry.refreshRun("run_a");
    optionalFailure.registry.refreshRun("run_b");
    const terminal = optionalFailure.registry.refreshGlobalRun("global");
    assert.equal(terminal.globalRun.status, "completed");
    assert.deepEqual(terminal.result.warnings, [{ runId: "run_b", status: "failed", cause: "optional_project_not_completed" }]);
  } finally { optionalFailure.cleanup(); }
});

test("global cancellation and revision tampering fence claims without consuming attempts", () => {
  const cancelled = fixture();
  try {
    cancelled.registry.createGlobalRunGraph(cancelled.graph());
    cancelled.registry.releaseGlobalRun("global");
    cancelled.registry.cancelGlobalRun("global");
    assert.equal(cancelled.registry.getGlobalRun("global").status, "cancelled");
    assert.equal(cancelled.registry.claimTask("task_a", "late_worker"), null);
    assert.equal(cancelled.registry.getTask("task_a").attempt, 0);
    assert.throws(() => cancelled.registry.updateGlobalRun("global", { status: "running" }), /Illegal GlobalRun transition/);
  } finally { cancelled.cleanup(); }

  const tampered = fixture();
  try {
    tampered.registry.createGlobalRunGraph(tampered.graph());
    tampered.registry.releaseGlobalRun("global");
    tampered.registry.updateTask("task_a", { metadata: { globalGraphFingerprint: "forged" } });
    assert.equal(tampered.registry.claimTask("task_a", "worker"), null);
    assert.equal(tampered.registry.getTask("task_a").attempt, 0);
  } finally { tampered.cleanup(); }
});

test("unsafe child recovery attention terminalizes the Global Run as attention_required", () => {
  const scope = fixture();
  try {
    scope.registry.createGlobalRunGraph(scope.graph({ projectRuns: [scope.projectRuns[0]] }));
    scope.registry.releaseGlobalRun("global");
    scope.registry.updateTask("task_a", { status: "recovery_attention", completedAt: new Date().toISOString() });
    scope.registry.refreshRun("run_a");
    const terminal = scope.registry.refreshGlobalRun("global");
    assert.equal(terminal.globalRun.status, "attention_required");
    assert.equal(terminal.result.projects[0].attentionRequired, true);
  } finally { scope.cleanup(); }
});

test("restart recovery releases a committed graph and fails an interrupted pre-graph preparation", () => {
  const committed = fixture({ fileBacked: true });
  try {
    committed.registry.createGlobalRunGraph(committed.graph());
    assert.equal(committed.registry.getTask("task_a").status, "staged");
    committed.registry.close();
    const reopened = new ControlRegistry({ path: committed.registryPath });
    const recovered = reopened.recoverGlobalRuns();
    assert.deepEqual(recovered, { released: 1, projected: 0, cancelled: 0, failedPreGraph: 0 });
    assert.equal(reopened.getGlobalRun("global").status, "running");
    assert.equal(reopened.getTask("task_a").status, "queued");
    assert.equal(reopened.getTask("task_a").attempt, 0);
    reopened.close();
  } finally { rmSync(committed.directory, { recursive: true, force: true }); }

  const interrupted = fixture({ fileBacked: true });
  try {
    interrupted.registry.close();
    const reopened = new ControlRegistry({ path: interrupted.registryPath });
    const recovered = reopened.recoverGlobalRuns();
    assert.deepEqual(recovered, { released: 0, projected: 0, cancelled: 0, failedPreGraph: 1 });
    const failed = reopened.getGlobalRun("global");
    assert.equal(failed.status, "failed");
    assert.equal(failed.metadata.failure.code, "GLOBAL_PREPARATION_INTERRUPTED");
    assert.equal(failed.metadata.failure.nextAction, "Create a new Global Run revision.");
    reopened.close();
  } finally { rmSync(interrupted.directory, { recursive: true, force: true }); }
});

test("project authorization manifests reject child escalation and cross-project root inheritance before persistence", () => {
  const escalated = fixture();
  try {
    const projectRuns = escalated.projectRuns.map((entry) => entry.run.id === "run_a" ? {
      ...entry,
      tasks: [{ id: "task_a", prompt: "Modify A", taskKind: "implementation", mutatesWorkspace: true,
        sandbox: "workspace-write", sideEffectPolicy: "workspace", workspaceMode: "worktree", integrationStrategy: "patch" }],
    } : entry);
    assert.throws(() => escalated.registry.createGlobalRunGraph(escalated.graph({ projectRuns })), (error) => error.code === "GLOBAL_AUTHORIZATION_TASK_KIND_EXCEEDED");
    assert.equal(escalated.registry.getRun("run_a"), null);
    assert.deepEqual(escalated.registry.listTasks({ limit: 10 }), []);
  } finally { escalated.cleanup(); }

  const inherited = fixture();
  try {
    const graph = inherited.graph();
    graph.authorizationManifests[1] = { ...graph.authorizationManifests[1], allowedRoots: [graph.projectRuns[0].run.cwd] };
    assert.throws(() => inherited.registry.createGlobalRunGraph(graph), (error) => error.code === "GLOBAL_AUTHORIZATION_ROOT_ESCAPE");
    assert.equal(inherited.registry.getRun("run_b"), null);
  } finally { inherited.cleanup(); }
});

test("authorization expansion requires an explicit new revision payload before graph persistence", () => {
  const scope = fixture();
  try {
    const projectRuns = [{
      membership: "required", run: { id: "run_write", cwd: scope.projectRuns[0].run.cwd },
      tasks: [{
        id: "task_write", prompt: "Apply patch", taskKind: "implementation", mutatesWorkspace: true,
        sandbox: "workspace-write", sideEffectPolicy: "workspace", workspaceMode: "worktree",
        integrationStrategy: "patch", outputs: ["patch"],
      }],
    }];
    const narrow = scope.graph({ revision: 1, projectRuns, authorizationManifests: [{
      runId: "run_write", allowedRoots: [scope.projectRuns[0].run.cwd], taskKinds: ["analysis"],
      mutatesWorkspace: false, sideEffectPolicies: ["none"], sandboxCeiling: "read-only",
      networkAccess: false, workspaceModes: ["shared"],
    }] });
    assert.throws(() => scope.registry.createGlobalRunGraph(narrow), (error) => error.code === "GLOBAL_AUTHORIZATION_TASK_KIND_EXCEEDED");
    assert.equal(scope.registry.getGlobalRunRevision("global:revision:1"), null);
    assert.equal(scope.registry.getRun("run_write"), null);

    const expanded = scope.graph({ revision: 2, projectRuns, authorizationManifests: [{
      runId: "run_write", allowedRoots: [scope.projectRuns[0].run.cwd], taskKinds: ["implementation"],
      mutatesWorkspace: true, sideEffectPolicies: ["workspace"], sandboxCeiling: "workspace-write",
      networkAccess: false, workspaceModes: ["worktree"],
    }] });
    const created = scope.registry.createGlobalRunGraph(expanded);
    assert.equal(created.revision.revision, 2);
    assert.equal(created.globalRun.currentRevision, 2);
    assert.equal(created.authorizationManifests[0].manifest.mutatesWorkspace, true);
    assert.equal(scope.registry.getTask("task_write").status, "staged");
  } finally { scope.cleanup(); }
});

test("a recorded producer artifact crosses the project boundary only through a validated handoff", () => {
  const scope = fixture();
  try {
    const projectRuns = [
      {
        ...scope.projectRuns[0],
        tasks: [{
          id: "task_a", prompt: "Produce patch", taskKind: "implementation", mutatesWorkspace: true,
          sandbox: "workspace-write", sideEffectPolicy: "workspace", workspaceMode: "worktree",
          integrationStrategy: "patch", outputs: ["patch"],
        }],
      },
      scope.projectRuns[1],
    ];
    const graph = scope.graph({
      projectRuns,
      authorizationManifests: [
        {
          runId: "run_a", allowedRoots: [scope.projectRuns[0].run.cwd], taskKinds: ["implementation"],
          mutatesWorkspace: true, sideEffectPolicies: ["workspace"], sandboxCeiling: "workspace-write",
          networkAccess: false, workspaceModes: ["worktree"],
        },
        {
          runId: "run_b", allowedRoots: [scope.projectRuns[1].run.cwd], taskKinds: ["analysis"],
          mutatesWorkspace: false, sideEffectPolicies: ["none"], sandboxCeiling: "read-only",
          networkAccess: false, workspaceModes: ["shared"],
        },
      ],
      dependencies: [{ id: "patch_to_consumer", producerRunId: "run_a", consumerRunId: "run_b", requiredOutputs: ["patch"] }],
    });
    scope.registry.createGlobalRunGraph(graph);
    scope.registry.releaseGlobalRun("global");
    const producer = scope.registry.claimTask("task_a", "producer");
    scope.registry.updateTask("task_a", { metadata: { integration: { artifact: {
      kind: "patch", strategy: "patch", contentHash: "sha256:artifact", patchPath: "/private/not-transferable.patch",
    } } } });
    scope.registry.completeClaim("task_a", "producer", producer.claimToken, { output: "patch ready" });
    scope.registry.refreshRun("run_a");
    scope.registry.refreshGlobalRun("global");
    const handoff = scope.registry.getCrossProjectHandoff("patch_to_consumer");
    assert.equal(handoff.status, "received");
    assert.deepEqual(handoff.payload.evidence[0].artifact, {
      kind: "patch", strategy: "patch", commit: null, contentHash: "sha256:artifact",
    });
    assert.equal(JSON.stringify(handoff.payload).includes("not-transferable.patch"), false);
    assert.ok(scope.registry.claimTask("task_b", "consumer"));
  } finally { scope.cleanup(); }
});

test("global cancellation preserves already completed integration evidence", () => {
  const scope = fixture();
  try {
    scope.registry.createGlobalRunGraph(scope.graph());
    scope.registry.releaseGlobalRun("global");
    const completed = scope.registry.claimTask("task_a", "integrator");
    scope.registry.updateTask("task_a", { metadata: { integration: {
      status: "recorded", strategy: "patch", artifact: { kind: "patch", contentHash: "sha256:applied" },
    } } });
    scope.registry.completeClaim("task_a", "integrator", completed.claimToken, { output: "integrated" });
    scope.registry.refreshRun("run_a");
    const cancelled = scope.registry.cancelGlobalRun("global");
    assert.equal(cancelled.globalRun.status, "cancelled");
    assert.equal(scope.registry.getRun("run_a").status, "completed");
    assert.equal(scope.registry.getTask("task_a").status, "completed");
    assert.equal(scope.registry.getTask("task_a").metadata.integration.artifact.contentHash, "sha256:applied");
    assert.equal(scope.registry.getTask("task_b").status, "canceled");
  } finally { scope.cleanup(); }
});

test("dependency contract tampering and missing receipts block consumers before attempt", () => {
  const contractTamper = fixture();
  try {
    assert.throws(() => contractTamper.registry.createGlobalRunGraph(contractTamper.graph({ dependencies: [{
      id: "a_to_b", producerRunId: "run_a", consumerRunId: "run_b", requiredOutputs: ["report"], fingerprint: "forged",
    }] })), (error) => error.code === "CROSS_PROJECT_DEPENDENCY_FINGERPRINT_MISMATCH");
    assert.equal(contractTamper.registry.getRun("run_a"), null);
  } finally { contractTamper.cleanup(); }

  const missingReceipt = fixture();
  try {
    const created = missingReceipt.registry.createGlobalRunGraph(missingReceipt.graph({ dependencies: [{
      id: "a_to_b", producerRunId: "run_a", consumerRunId: "run_b", requiredOutputs: ["report"],
    }] }));
    missingReceipt.registry.releaseGlobalRun("global");
    missingReceipt.registry.db.prepare("UPDATE cross_project_dependencies SET status = 'satisfied' WHERE id = 'a_to_b'").run();
    assert.throws(() => missingReceipt.registry.releaseStagedRun("run_b"), (error) => error.code === "CROSS_PROJECT_HANDOFF_NOT_RECEIVED");
    assert.equal(missingReceipt.registry.claimTask("task_b", "worker"), null);
    assert.equal(missingReceipt.registry.getTask("task_b").attempt, 0);
    const handoffs = missingReceipt.registry.listCrossProjectHandoffs(created.revision.id);
    assert.equal(handoffs.length, 1);
    assert.equal(handoffs[0].status, "invalid");
    assert.equal(handoffs[0].validation.code, "CROSS_PROJECT_HANDOFF_OUTPUT_MISSING");
  } finally { missingReceipt.cleanup(); }
});

test("persisted handoff tampering fences the consumer and receipt recovery is idempotent across reopen", () => {
  const tampered = fixture();
  try {
    tampered.registry.createGlobalRunGraph(tampered.graph({ dependencies: [{
      id: "a_to_b", producerRunId: "run_a", consumerRunId: "run_b", requiredOutputs: ["report"],
    }] }));
    tampered.registry.releaseGlobalRun("global");
    const claim = tampered.registry.claimTask("task_a", "producer");
    tampered.registry.completeClaim("task_a", "producer", claim.claimToken, { output: "durable report" });
    tampered.registry.refreshRun("run_a");
    assert.equal(tampered.registry.getCrossProjectHandoff("a_to_b").status, "received");
    tampered.registry.db.prepare("UPDATE cross_project_handoffs SET content_hash = 'forged' WHERE dependency_id = 'a_to_b'").run();
    assert.equal(tampered.registry.claimTask("task_b", "consumer"), null);
    assert.equal(tampered.registry.getTask("task_b").attempt, 0);
    tampered.registry.refreshGlobalRun("global");
    assert.equal(tampered.registry.getCrossProjectHandoff("a_to_b").status, "invalid");
  } finally { tampered.cleanup(); }

  const restart = fixture({ fileBacked: true });
  try {
    restart.registry.createGlobalRunGraph(restart.graph({ dependencies: [{
      id: "a_to_b", producerRunId: "run_a", consumerRunId: "run_b", requiredOutputs: ["report"],
    }] }));
    restart.registry.releaseGlobalRun("global");
    const claim = restart.registry.claimTask("task_a", "producer");
    restart.registry.completeClaim("task_a", "producer", claim.claimToken, { output: "durable report" });
    restart.registry.refreshRun("run_a");
    const receipt = restart.registry.getCrossProjectHandoff("a_to_b").receiptHash;
    restart.registry.db.prepare(`
      UPDATE cross_project_handoffs SET status = 'validated', receipt_hash = NULL, received_at = NULL,
        metadata_json = json_remove(metadata_json, '$.validatedReceiptHash') WHERE dependency_id = 'a_to_b'
    `).run();
    restart.registry.close();
    const reopened = new ControlRegistry({ path: restart.registryPath });
    reopened.recoverGlobalRuns();
    const recovered = reopened.getCrossProjectHandoff("a_to_b");
    assert.equal(recovered.status, "received");
    assert.equal(recovered.receiptHash, receipt);
    assert.equal(reopened.listCrossProjectHandoffs(recovered.revisionId).length, 1);
    reopened.recoverGlobalRuns();
    assert.equal(reopened.listCrossProjectHandoffs(recovered.revisionId).length, 1);
    reopened.close();
  } finally { rmSync(restart.directory, { recursive: true, force: true }); }
});

test("schema v5 reopens transactionally with authorization and handoff storage", () => {
  const directory = mkdtempSync(join(tmpdir(), "global-v5-migration-"));
  const registryPath = join(directory, "registry.sqlite");
  const legacy = new ControlRegistry({ path: registryPath });
  legacy.db.exec("DROP TABLE cross_project_handoffs; DROP TABLE authorization_manifests; PRAGMA user_version = 5");
  legacy.close();
  const upgraded = new ControlRegistry({ path: registryPath });
  try {
    assert.equal(upgraded.schemaVersion, CURRENT_SCHEMA_VERSION);
    const tables = upgraded.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('authorization_manifests', 'cross_project_handoffs') ORDER BY name").all().map((row) => row.name);
    assert.deepEqual(tables, ["authorization_manifests", "cross_project_handoffs"]);
    assert.ok(upgraded.migrationBackupPath);
  } finally {
    upgraded.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
