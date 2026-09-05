import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadProductContractManifest, syncProductContractManifest } from "../src/product-contracts.js";
import { ControlRegistry } from "../src/registry.js";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));

test("the repository product contract is self-consistent on a fresh registry", () => {
  const registry = new ControlRegistry({ path: ":memory:" });
  try {
    const synced = syncProductContractManifest(registry, repositoryRoot);
    assert.equal(synced.manifest.claims.length, 4);
    for (const entry of synced.manifest.claims) {
      assert.equal(registry.getContextClaim(`claim_product_${entry.id}`).status, "active");
    }
  } finally {
    registry.close();
  }
});

test("known historical product claims are superseded when present", () => {
  const directory = mkdtempSync(join(tmpdir(), "product-contract-history-"));
  const registry = new ControlRegistry({ path: ":memory:" });
  try {
    writeFileSync(join(directory, "control-plane.contracts.json"), JSON.stringify({
      version: 1,
      historicalClaimIds: ["claim_product_policy_v1"],
      claims: [{
        id: "policy_v2", kind: "decision", subject: "policy", revision: 2,
        body: "Use policy v2.", supersedes: ["claim_product_policy_v1"],
      }],
    }));
    const project = registry.resolveProject(directory);
    const historical = registry.createContextClaim({
      id: "claim_product_policy_v1", projectId: project.id, kind: "decision", subject: "policy",
      body: "Use policy v1.", scope: "project", authority: "project_contract", status: "candidate",
    });
    registry.addContextClaimSource(historical.id, { kind: "repository_contract", id: "historical_manifest" });
    registry.activateContextClaim(historical.id);

    syncProductContractManifest(registry, directory);
    assert.equal(registry.getContextClaim("claim_product_policy_v1").status, "superseded");
    assert.equal(registry.getContextClaim("claim_product_policy_v2").status, "active");
  } finally {
    registry.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("undeclared supersede targets are rejected before registry mutation", () => {
  const directory = mkdtempSync(join(tmpdir(), "product-contract-invalid-"));
  try {
    writeFileSync(join(directory, "control-plane.contracts.json"), JSON.stringify({
      version: 1,
      historicalClaimIds: ["claim_product_policy_v1"],
      claims: [{
        id: "policy_v3", kind: "decision", subject: "policy", body: "Use policy v3.",
        supersedes: ["policy_v2"],
      }],
    }));
    assert.throws(
      () => loadProductContractManifest(directory),
      (error) => error.code === "PRODUCT_CONTRACT_SUPERSEDE_UNKNOWN" && /policy_v2/.test(error.message),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
