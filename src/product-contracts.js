import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const PRODUCT_CONTRACT_MANIFEST = "control-plane.contracts.json";
export const PRODUCT_CONTRACT_MANIFEST_VERSION = 1;

function manifestError(message, code = "PRODUCT_CONTRACT_MANIFEST_INVALID") {
  return Object.assign(new Error(message), { code });
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

export function loadProductContractManifest(cwd) {
  const path = join(cwd, PRODUCT_CONTRACT_MANIFEST);
  if (!existsSync(path)) return null;
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw manifestError(`Cannot read ${PRODUCT_CONTRACT_MANIFEST}: ${error.message}`);
  }
  if (manifest?.version !== PRODUCT_CONTRACT_MANIFEST_VERSION) {
    throw manifestError(`Unsupported product contract manifest version: ${manifest?.version}`, "PRODUCT_CONTRACT_MANIFEST_VERSION_UNSUPPORTED");
  }
  if (!Array.isArray(manifest.claims) || !manifest.claims.length) throw manifestError("Product contract manifest requires claims");
  const subjects = new Set();
  for (const claim of manifest.claims) {
    if (!claim?.id || !claim?.subject || !claim?.body || !["decision", "constraint", "architecture"].includes(claim.kind)) {
      throw manifestError("Each product contract claim requires id, subject, body, and a contract-bearing kind");
    }
    if (subjects.has(claim.subject)) throw manifestError(`Duplicate product contract subject: ${claim.subject}`);
    subjects.add(claim.subject);
  }
  return { path, manifest, fingerprint: createHash("sha256").update(stable(manifest)).digest("hex") };
}

export function syncProductContractManifest(registry, cwd) {
  const loaded = loadProductContractManifest(cwd);
  if (!loaded) return null;
  const project = registry.resolveProject(cwd);
  for (const entry of loaded.manifest.claims) {
    const claimId = `claim_product_${entry.id}`;
    let claim = registry.getContextClaim(claimId);
    if (!claim) claim = registry.createContextClaim({
      id: claimId,
      projectId: project.id,
      kind: entry.kind,
      subject: entry.subject,
      body: entry.body,
      scope: "project",
      authority: "project_contract",
      status: "candidate",
      revision: entry.revision ?? 1,
      metadata: { manifest: PRODUCT_CONTRACT_MANIFEST, manifestVersion: loaded.manifest.version },
    });
    registry.addContextClaimSource(claim.id, {
      kind: "repository_contract",
      id: loaded.path,
      revision: entry.revision ?? 1,
      digest: loaded.fingerprint,
    });
    if (claim.status === "candidate") registry.activateContextClaim(claim.id, { supersedes: entry.supersedes ?? [] });
  }
  return { ...loaded, projectId: project.id };
}
