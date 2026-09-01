import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ContextResolver, CONTEXT_RESOLVER_VERSION, contextSnapshotHash } from "../src/context-resolver.js";
import { ControlRegistry } from "../src/registry.js";

function activate(registry, overrides) {
  const claim = registry.createContextClaim({
    id: overrides.id, kind: overrides.kind ?? "decision", subject: overrides.subject,
    body: overrides.body, scope: overrides.scope ?? "global",
    projectId: overrides.projectId ?? null,
    authority: overrides.authority ?? "user_explicit", status: "candidate",
  });
  registry.addContextClaimSource(claim.id, { kind: "user_turn", id: `source_${claim.id}` });
  return registry.activateContextClaim(claim.id);
}

test("context resolution is idempotent and freezes selected provenance", () => {
  const registry = new ControlRegistry({ path: ":memory:" });
  try {
    activate(registry, { id: "claim_api", subject: "api-version", body: "Use API v2" });
    const resolver = new ContextResolver(registry);
    const first = resolver.resolve({ objective: "Implement API v2", requiredSubjects: ["api-version"] });
    const repeated = resolver.resolve({ objective: "Implement API v2", requiredSubjects: ["api-version"] });
    assert.equal(first.status, "validated");
    assert.equal(repeated.id, first.id);
    assert.equal(repeated.fingerprint, first.fingerprint);
    assert.deepEqual(first.metadata.selectedClaimIds, ["claim_api"]);

    activate(registry, { id: "claim_logging", subject: "logging", body: "Use structured logs" });
    assert.deepEqual(registry.getContextSnapshot(first.id).metadata.selectedClaimIds, ["claim_api"]);
    const revised = resolver.resolve({ objective: "Implement API v2", requiredSubjects: ["api-version"], objectiveRevision: 2 });
    assert.notEqual(revised.id, first.id);
    assert.ok(revised.metadata.selectedClaimIds.includes("claim_logging"));
  } finally {
    registry.close();
  }
});

test("equal-authority contract conflict creates an invalid terminal snapshot", () => {
  const registry = new ControlRegistry({ path: ":memory:" });
  try {
    activate(registry, { id: "contract_v1", subject: "api-contract", body: "Use contract v1" });
    activate(registry, { id: "contract_v2", subject: "api-contract", body: "Use contract v2" });
    const resolver = new ContextResolver(registry);
    assert.throws(
      () => resolver.resolve({ objective: "Implement the API", requiredSubjects: ["api-contract"] }),
      (error) => error.code === "CONTEXT_SNAPSHOT_INVALID" && error.causeCode === "unresolved_context_conflict" && error.repairable,
    );
    const snapshot = registry.listContextSnapshots()[0];
    assert.equal(snapshot.status, "invalid");
    assert.equal(snapshot.conflicts[0].category, "contract");
    assert.equal(snapshot.conflicts[0].blocking, true);
    assert.equal(snapshot.error.nextAction.length > 0, true);
  } finally {
    registry.close();
  }
});

test("a lower-authority repository contract cannot execute against an explicit user decision", () => {
  const directory = mkdtempSync(join(tmpdir(), "product-contract-conflict-"));
  const registry = new ControlRegistry({ path: ":memory:" });
  try {
    writeFileSync(join(directory, "control-plane.contracts.json"), JSON.stringify({
      version: 1,
      claims: [{ id: "start_v1", kind: "decision", subject: "run_start_policy", body: "Runs start automatically." }],
    }));
    const project = registry.resolveProject(directory);
    activate(registry, {
      id: "explicit_start",
      projectId: project.id,
      scope: "project",
      subject: "run_start_policy",
      body: "Runs start only after an explicit user action.",
    });
    assert.throws(
      () => new ContextResolver(registry).resolve({ objective: "Modify scheduler", cwd: directory }),
      (error) => error.code === "CONTEXT_SNAPSHOT_INVALID" && error.causeCode === "unresolved_context_conflict",
    );
    const snapshot = registry.listContextSnapshots()[0];
    assert.equal(snapshot.conflicts[0].blocking, true);
    assert.equal(snapshot.conflicts[0].claimIds.length, 2);
  } finally {
    registry.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("new active claims invalidate the context resolution cache", () => {
  const registry = new ControlRegistry({ path: ":memory:" });
  try {
    const resolver = new ContextResolver(registry);
    const first = resolver.resolve({ objective: "Inspect API" });
    activate(registry, { id: "new_contract", subject: "api-contract", body: "Use API v2" });
    const second = resolver.resolve({ objective: "Inspect API" });
    assert.notEqual(second.id, first.id);
    assert.ok(second.metadata.selectedClaimIds.includes("new_contract"));
  } finally {
    registry.close();
  }
});

test("an explicit user resolution supersedes conflicting history before a new snapshot can execute", () => {
  const registry = new ControlRegistry({ path: ":memory:" });
  try {
    activate(registry, { id: "historical_v1", subject: "api-contract", body: "Use contract v1" });
    activate(registry, { id: "historical_v2", subject: "api-contract", body: "Use contract v2" });
    const resolver = new ContextResolver(registry);
    assert.throws(
      () => resolver.resolve({ objective: "Implement API", requiredSubjects: ["api-contract"] }),
      (error) => error.code === "CONTEXT_SNAPSHOT_INVALID",
    );
    const resolution = registry.createContextClaim({
      id: "user_resolution_v3", kind: "decision", subject: "api-contract", body: "Use contract v3",
      scope: "global", authority: "user_explicit", status: "candidate",
    });
    registry.addContextClaimSource(resolution.id, { kind: "user_turn", id: "user_resolution_turn" });
    registry.activateContextClaim(resolution.id, {
      supersedes: ["historical_v1", "historical_v2"], reason: "explicit_user_resolution",
    });

    const revised = resolver.resolve({
      objective: "Implement API", requiredSubjects: ["api-contract"], objectiveRevision: 2,
    });
    assert.equal(revised.status, "validated");
    assert.deepEqual(revised.metadata.selectedClaimIds, ["user_resolution_v3"]);
    registry.createTask({ id: "resolved_task", prompt: "Implement API", metadata: {
      contextSnapshotId: revised.id, contextSnapshotFingerprint: revised.fingerprint,
    } });
    const claimed = registry.claimTask("resolved_task", "worker");
    assert.ok(claimed);
    assert.equal(claimed.attempt, 1);
    assert.equal(registry.getContextClaim("historical_v1").status, "superseded");
    assert.equal(registry.getContextClaim("historical_v2").status, "superseded");
  } finally {
    registry.close();
  }
});

test("missing required context is invalid and a persisted fingerprint cannot be forged", () => {
  const registry = new ControlRegistry({ path: ":memory:" });
  try {
    const resolver = new ContextResolver(registry);
    assert.throws(
      () => resolver.resolve({ objective: "Release", requiredSubjects: ["release-contract"] }),
      (error) => error.code === "CONTEXT_SNAPSHOT_INVALID" && error.causeCode === "required_context_missing",
    );
    const valid = resolver.resolve({ objective: "Read repository" });
    registry.db.prepare("UPDATE context_snapshots SET fingerprint = 'forged' WHERE id = ?").run(valid.id);
    assert.throws(() => resolver.assertSnapshot(valid.id), (error) => error.code === "CONTEXT_SNAPSHOT_INVALID" && error.causeCode === "context_snapshot_fingerprint_mismatch");
  } finally {
    registry.close();
  }
});

test("a requested thread without a current knowledge digest cannot produce a validated snapshot", () => {
  const registry = new ControlRegistry({ path: ":memory:" });
  try {
    assert.throws(
      () => new ContextResolver(registry).resolve({ objective: "Use prior context", requestedThreadIds: ["unknown_thread"] }),
      (error) => error.code === "CONTEXT_SNAPSHOT_INVALID" && error.causeCode === "requested_thread_knowledge_missing",
    );
    assert.equal(registry.listContextSnapshots()[0].error.missingThreadIds[0], "unknown_thread");
  } finally {
    registry.close();
  }
});

test("claim refuses a task whose context snapshot marker was tampered", () => {
  const registry = new ControlRegistry({ path: ":memory:" });
  try {
    const snapshot = new ContextResolver(registry).resolve({ objective: "Analyze" });
    registry.createTask({ id: "guarded", prompt: "Analyze", metadata: { contextSnapshotId: snapshot.id, contextSnapshotFingerprint: "forged" } });
    assert.equal(registry.claimTask("guarded", "worker"), null);
    assert.equal(registry.getTask("guarded").attempt, 0);
  } finally {
    registry.close();
  }
});

test("a building snapshot resumes deterministically after registry reopen without a task attempt", () => {
  const directory = mkdtempSync(join(tmpdir(), "context-snapshot-restart-"));
  const path = join(directory, "registry.sqlite");
  try {
    const objective = "Analyze restart safety";
    const objectiveHash = contextSnapshotHash(objective);
    const requestedScope = {
      projectId: null,
      cwd: null,
      requiredSubjects: [],
      excludedClaimIds: [],
      requestedThreads: [],
      maxContextBudget: 12_000,
      productContractFingerprint: null,
      claimCatalogFingerprint: contextSnapshotHash([]),
    };
    const requestedScopeHash = contextSnapshotHash(requestedScope);
    const resolutionKey = contextSnapshotHash({ objectiveHash, requestedScopeHash, resolverVersion: CONTEXT_RESOLVER_VERSION, revision: 1 });
    const first = new ControlRegistry({ path });
    const building = first.createContextSnapshot({ resolutionKey, objectiveHash, requestedScopeHash, resolverVersion: CONTEXT_RESOLVER_VERSION, revision: 1, metadata: { requestedScope, objective } });
    first.close();

    const reopened = new ControlRegistry({ path });
    const resolved = new ContextResolver(reopened).resolve({ objective });
    assert.equal(resolved.id, building.id);
    assert.equal(resolved.status, "validated");
    assert.equal(reopened.listTasks({ limit: 10 }).length, 0);
    reopened.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
