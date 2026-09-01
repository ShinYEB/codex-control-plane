import assert from "node:assert/strict";
import test from "node:test";

import { ControlRegistry } from "../src/registry.js";
import { AgentRouter } from "../src/router.js";

function candidate(registry, overrides = {}) {
  return registry.createContextClaim({
    id: overrides.id ?? "claim",
    kind: overrides.kind ?? "decision",
    subject: overrides.subject ?? "api-version",
    body: overrides.body ?? "Use API v2",
    scope: overrides.scope ?? "global",
    authority: overrides.authority ?? "observed_thread",
    status: "candidate",
    projectId: overrides.projectId ?? null,
  });
}

test("context claims cannot activate without provenance", () => {
  const registry = new ControlRegistry({ path: ":memory:" });
  try {
    const claim = candidate(registry);
    assert.throws(() => registry.activateContextClaim(claim.id), (error) => error.code === "CONTEXT_PROVENANCE_REQUIRED");
    assert.throws(
      () => registry.db.prepare("UPDATE context_claims SET status = 'active' WHERE id = ?").run(claim.id),
      /requires provenance/,
    );
    registry.addContextClaimSource(claim.id, { kind: "thread_turn", id: "thread:turn" });
    assert.equal(registry.activateContextClaim(claim.id).status, "active");
    assert.throws(
      () => registry.db.prepare("DELETE FROM context_claim_sources WHERE claim_id = ?").run(claim.id),
      /requires provenance/,
    );
  } finally {
    registry.close();
  }
});

test("lower authority cannot supersede an explicit user decision", () => {
  const registry = new ControlRegistry({ path: ":memory:" });
  try {
    const user = candidate(registry, { id: "user_decision", authority: "user_explicit", body: "Use API v2" });
    registry.addContextClaimSource(user.id, { kind: "user_turn", id: "turn_user" });
    registry.activateContextClaim(user.id);

    const observed = candidate(registry, { id: "observed_decision", authority: "observed_thread", body: "Use API v1" });
    registry.addContextClaimSource(observed.id, { kind: "thread_turn", id: "turn_agent" });
    assert.throws(
      () => registry.activateContextClaim(observed.id, { supersedes: [user.id] }),
      (error) => error.code === "CONTEXT_AUTHORITY_DOWNGRADE",
    );
    assert.equal(registry.getContextClaim(user.id).status, "active");
    assert.equal(registry.getContextClaim(observed.id).status, "candidate");

    const replacement = candidate(registry, { id: "user_replacement", authority: "user_explicit", body: "Use API v3" });
    registry.addContextClaimSource(replacement.id, { kind: "user_turn", id: "turn_user_2" });
    assert.equal(registry.activateContextClaim(replacement.id, { supersedes: [user.id] }).status, "active");
    assert.equal(registry.getContextClaim(user.id).status, "superseded");
  } finally {
    registry.close();
  }
});

test("thread knowledge snapshots deduplicate source digests and supersede the previous current snapshot", () => {
  const registry = new ControlRegistry({ path: ":memory:" });
  try {
    const claim = candidate(registry, { id: "thread_claim" });
    registry.addContextClaimSource(claim.id, { kind: "thread_turn", id: "thread_1:turn_1" });
    registry.activateContextClaim(claim.id);
    const first = registry.upsertThreadKnowledgeSnapshot({
      threadId: "thread_1",
      throughTurnId: "turn_1",
      sourceDigest: "digest_1",
      extractorVersion: "v1",
      claimIds: [claim.id],
      topics: ["api"],
    });
    const repeated = registry.upsertThreadKnowledgeSnapshot({
      threadId: "thread_1",
      sourceDigest: "digest_1",
      extractorVersion: "v1",
    });
    assert.equal(repeated.id, first.id);

    const second = registry.upsertThreadKnowledgeSnapshot({
      threadId: "thread_1",
      throughTurnId: "turn_2",
      sourceDigest: "digest_2",
      extractorVersion: "v1",
      claimIds: [claim.id],
    });
    assert.equal(registry.getThreadKnowledgeSnapshot(first.id).status, "superseded");
    assert.equal(registry.getThreadKnowledgeSnapshot(second.id).status, "current");
    assert.deepEqual(registry.getThreadKnowledgeSnapshot(second.id).claimIds, [claim.id]);
  } finally {
    registry.close();
  }
});

test("thread lineage and routing decisions preserve inheritance, evidence, and rejection reasons", () => {
  const registry = new ControlRegistry({ path: ":memory:" });
  try {
    const snapshot = registry.upsertThreadKnowledgeSnapshot({ threadId: "parent", sourceDigest: "parent_digest", extractorVersion: "v1" });
    const lineage = registry.recordThreadLineage({ threadId: "child", parentThreadId: "parent", inheritedSnapshotId: snapshot.id });
    assert.equal(lineage.relationship, "fork");
    assert.equal(lineage.inheritedSnapshotId, snapshot.id);
    assert.throws(() => registry.recordThreadLineage({ threadId: "same", parentThreadId: "same" }), /CHECK constraint failed/);

    const decision = registry.recordRoutingDecision({
      decision: "fork",
      selectedAgentId: "child",
      candidates: [{ agentId: "parent", score: 80 }, { agentId: "other", score: 20 }],
      evidence: ["matching validated claim"],
      rejectionReasons: [{ agentId: "other", reason: "missing capability" }],
      provenance: { version: 2, decisionSource: "agent_router" },
    });
    const persisted = registry.listRoutingDecisions()[0];
    assert.equal(persisted.id, decision.id);
    assert.deepEqual(persisted.evidence, ["matching validated claim"]);
    assert.deepEqual(persisted.rejectionReasons, [{ agentId: "other", reason: "missing capability" }]);
    assert.ok(persisted.fingerprint);
  } finally {
    registry.close();
  }
});

test("router explains provenance-backed thread knowledge in candidate selection", () => {
  const router = new AgentRouter();
  const result = router.select([
    { id: "knowledgeable", status: "idle", role: "backend", capabilities: ["api"], metadata: { tools: ["node"] } },
    { id: "generic", status: "idle", role: "backend", capabilities: ["api"], metadata: { tools: ["node"] } },
  ], {
    prompt: "implement billing api",
    role: "backend",
    capabilities: ["api"],
    tools: ["node"],
    threadKnowledge: {
      knowledgeable: { id: "snapshot_billing", topics: ["billing", "api"], claimIds: ["claim_billing"] },
    },
  });
  assert.equal(result.selectedAgent.id, "knowledgeable");
  assert.equal(result.candidates[0].knowledgeSnapshotId, "snapshot_billing");
  assert.deepEqual(result.candidates[0].knowledgeClaimIds, ["claim_billing"]);
  assert.ok(result.reasons.some((reason) => reason.includes("provenance-backed claim")));
});
