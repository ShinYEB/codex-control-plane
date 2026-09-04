import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { ControlRegistry } from "../src/registry.js";
import { ThreadGraphContextPackImporter, validateThreadGraphContextPack } from "../src/threadgraph-context-pack.js";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/threadgraph-context-pack-v1-alpha.json", import.meta.url), "utf8"));
const conflictedFixture = {
  ...fixture,
  packId: "ctx_txk4pwvkrckn27fl2grxdeivv3av6sm2mlmgayi47g2zl6op35ha",
  unresolvedConflicts: ["storage decision conflicts"],
  contentDigest: "sha256:6effce7081ecec3acb0d2c46fa63ff6a589e750891f6449bfe61ba54b65fb238",
};
const missingSourceFixture = {
  ...fixture,
  packId: "ctx_s3ptjwddyj5dshvyrufb24fbofzbwq2ot7obqvm4g4hw4hw5yhmq",
  missingSources: ["evidence_optional"],
  contentDigest: "sha256:95911f9758e33a6cc78b9e170fdfa6627c3240b3895faca4f766de4bbff244d2",
};
const validationOptions = { scopeId: "project:alpha", currentTime: "2026-09-04T02:00:00.000Z" };

function counts(registry) {
  return {
    claims: registry.db.prepare("SELECT COUNT(*) count FROM context_claims").get().count,
    sources: registry.db.prepare("SELECT COUNT(*) count FROM context_claim_sources").get().count,
    snapshots: registry.db.prepare("SELECT COUNT(*) count FROM context_snapshots").get().count,
  };
}

test("independent consumer validates the producer compatibility fixture", () => {
  assert.deepEqual(validateThreadGraphContextPack(fixture, validationOptions), {
    decision: "allow",
    code: null,
    mutated: false,
    provenanceOnly: true,
    executionAuthority: false,
    packId: fixture.packId,
    warnings: [],
  });
});

test("invalid packs are rejected before registry mutation", () => {
  const registry = new ControlRegistry({ path: ":memory:" });
  try {
    const importer = new ThreadGraphContextPackImporter(registry);
    const invalid = [
      [{ ...fixture, schemaVersion: "threadgraph-context-pack/0" }, "CONTEXT_PACK_VERSION_UNSUPPORTED"],
      [{ ...fixture, scopeId: "project:other" }, "CONTEXT_PACK_SCOPE_MISMATCH"],
      [{ ...fixture, contentDigest: "sha256:forged" }, "CONTEXT_PACK_DIGEST_MISMATCH"],
      [{ ...fixture, packId: "ctx_forged" }, "CONTEXT_PACK_ID_MISMATCH"],
      [{ ...fixture, buildIdentity: "unknown-producer/1" }, "CONTEXT_PACK_SOURCE_UNTRUSTED"],
      [{ ...fixture, derivedContent: { summary: fixture.derivedContent.summary, permissions: ["write"] } }, "CONTEXT_PACK_AUTHORITY_FORBIDDEN"],
      [conflictedFixture, "CONTEXT_PACK_CONFLICTED"],
      [missingSourceFixture, "CONTEXT_PACK_SOURCE_MISSING"],
    ];
    const before = counts(registry);
    for (const [pack, code] of invalid) {
      const result = importer.import(pack, validationOptions);
      assert.equal(result.decision, "reject");
      assert.equal(result.code, code);
      assert.equal(result.mutated, false);
      assert.deepEqual(counts(registry), before);
    }
    assert.equal(importer.import(fixture, { ...validationOptions, currentTime: "2026-11-04T00:00:00.000Z" }).code, "CONTEXT_PACK_STALE");
    assert.deepEqual(counts(registry), before);
  } finally {
    registry.close();
  }
});

test("accepted import is idempotent provenance and never execution authority", () => {
  const registry = new ControlRegistry({ path: ":memory:" });
  try {
    const importer = new ThreadGraphContextPackImporter(registry);
    const first = importer.import(fixture, validationOptions);
    const second = importer.import(fixture, validationOptions);
    assert.equal(first.decision, "allow");
    assert.equal(first.claimStatus, "candidate");
    assert.equal(second.claimId, first.claimId);
    assert.equal(second.claimStatus, "candidate");
    assert.deepEqual(counts(registry), { claims: 1, sources: 1, snapshots: 0 });

    const claim = registry.getContextClaim(first.claimId);
    assert.equal(claim.authority, "observed_thread");
    assert.equal(claim.status, "candidate");
    assert.equal(claim.metadata.provenanceOnly, true);
    assert.equal(claim.metadata.executionAuthority, false);
    assert.equal(claim.metadata.permissions, undefined);
    assert.equal(claim.metadata.sandboxPolicy, undefined);
    assert.equal(claim.metadata.sideEffectAuthorization, undefined);
    assert.deepEqual(registry.listContextClaimSources(claim.id).map((source) => source.kind), ["threadgraph_context_pack"]);
    assert.equal(registry.listContextSnapshots().length, 0);
  } finally {
    registry.close();
  }
});

test("missing sources require explicit partial-import policy and still remain candidate", () => {
  const registry = new ControlRegistry({ path: ":memory:" });
  try {
    const importer = new ThreadGraphContextPackImporter(registry);
    assert.equal(importer.import(missingSourceFixture, validationOptions).decision, "reject");
    const accepted = importer.import(missingSourceFixture, { ...validationOptions, allowMissingSources: true });
    assert.equal(accepted.decision, "partial");
    assert.equal(accepted.claimStatus, "candidate");
    assert.equal(accepted.executionAuthority, false);
    assert.deepEqual(accepted.warnings, [{ code: "CONTEXT_PACK_SOURCE_MISSING", source: "evidence_optional" }]);
    assert.deepEqual(counts(registry), { claims: 1, sources: 1, snapshots: 0 });
  } finally {
    registry.close();
  }
});
