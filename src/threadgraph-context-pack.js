import { createHash } from "node:crypto";

const SCHEMA_VERSION = "threadgraph-context-pack/1-alpha";
const CONTENT_NAMESPACE = "threadgraph-context-pack-content/1";
const SELECTION_NAMESPACE = "context-pack-selection/1";
const ID_NAMESPACE = "codex-threadgraph/context-pack-id/1";
const ID_VERSION = "context-pack/1-alpha";
const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
const FORBIDDEN_KEYS = new Set([
  "permissions",
  "sandboxpolicy",
  "sideeffectauthorization",
  "claimtoken",
  "lease",
  "startinstructions",
  "prompt",
]);
const TOP_LEVEL_KEYS = new Set([
  "schemaVersion",
  "packId",
  "buildIdentity",
  "scopeId",
  "graphRevisionId",
  "selectedClaimIds",
  "selectedEvidenceIds",
  "purpose",
  "derivedContent",
  "unresolvedConflicts",
  "missingSources",
  "observationCutoff",
  "generatedAt",
  "contentDigest",
]);

function reject(code, details = {}) {
  return Object.freeze({ decision: "reject", code, mutated: false, ...details });
}

function frame(value) {
  const text = String(value);
  return `${Buffer.byteLength(text, "utf8").toString(16).padStart(8, "0")}:${text}`;
}

function framedHash(namespace, fields) {
  return createHash("sha256").update([namespace, ...fields].map(frame).join(""), "utf8").digest();
}

function encodeBase32(buffer) {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

function canonicalize(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Context Pack numbers must be finite");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value && typeof value === "object" && [Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    return `{${Object.keys(value).sort().map((key) => {
      if (value[key] === undefined) throw new TypeError("Context Pack values cannot be undefined");
      return `${JSON.stringify(key)}:${canonicalize(value[key])}`;
    }).join(",")}}`;
  }
  throw new TypeError("Context Pack must contain only JSON-compatible values");
}

function fingerprint(namespace, value) {
  return `sha256:${framedHash(namespace, [canonicalize(value)]).toString("hex")}`;
}

function contentAddressedId(fields) {
  return `ctx_${encodeBase32(framedHash(ID_NAMESPACE, fields))}`;
}

function walkForAuthority(value) {
  if (Array.isArray(value)) return value.forEach(walkForAuthority);
  if (!value || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key.toLowerCase())) throw Object.assign(new Error(`Context Pack cannot contain ${key}`), { code: "CONTEXT_PACK_AUTHORITY_FORBIDDEN" });
    walkForAuthority(nested);
  }
}

function validString(value, maxLength = 500) {
  return typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= maxLength;
}

function validStringList(value, maxItems = 500) {
  return Array.isArray(value)
    && value.length <= maxItems
    && value.every((entry) => validString(entry));
}

function parseCanonicalTimestamp(value) {
  if (typeof value !== "string") return null;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) return null;
  return timestamp;
}

function preimage(pack) {
  return {
    schemaVersion: SCHEMA_VERSION,
    buildIdentity: pack.buildIdentity,
    scopeId: pack.scopeId,
    graphRevisionId: pack.graphRevisionId,
    selectedClaimIds: [...new Set(pack.selectedClaimIds)].sort(),
    selectedEvidenceIds: [...new Set(pack.selectedEvidenceIds)].sort(),
    purpose: pack.purpose,
    derivedContent: pack.derivedContent,
    unresolvedConflicts: [...pack.unresolvedConflicts],
    missingSources: [...pack.missingSources],
    observationCutoff: pack.observationCutoff,
    generatedAt: pack.generatedAt,
  };
}

function expectedPackId(pack) {
  const selectionDigest = fingerprint(SELECTION_NAMESPACE, {
    claims: [...pack.selectedClaimIds].sort(),
    evidence: [...pack.selectedEvidenceIds].sort(),
    purpose: pack.purpose,
  });
  return contentAddressedId([pack.graphRevisionId, selectionDigest, pack.contentDigest, ID_VERSION]);
}

export function validateThreadGraphContextPack(pack, options = {}) {
  if (!pack || typeof pack !== "object" || Array.isArray(pack)) return reject("CONTEXT_PACK_INVALID");
  try { walkForAuthority(pack); } catch (error) { return reject(error.code ?? "CONTEXT_PACK_INVALID"); }
  if (Object.keys(pack).some((key) => !TOP_LEVEL_KEYS.has(key))) return reject("CONTEXT_PACK_FIELD_UNSUPPORTED");
  if (pack.schemaVersion !== SCHEMA_VERSION) return reject("CONTEXT_PACK_VERSION_UNSUPPORTED");
  if (!validString(options.scopeId) || pack.scopeId !== options.scopeId) return reject("CONTEXT_PACK_SCOPE_MISMATCH");
  if (!validString(pack.packId, 256)
    || !validString(pack.buildIdentity)
    || !validString(pack.graphRevisionId)
    || !validString(pack.purpose, 1_000)
    || !validStringList(pack.selectedClaimIds)
    || !validStringList(pack.selectedEvidenceIds)
    || !validStringList(pack.unresolvedConflicts, 100)
    || !validStringList(pack.missingSources, 100)
    || !pack.derivedContent
    || typeof pack.derivedContent !== "object"
    || Array.isArray(pack.derivedContent)
    || Object.keys(pack.derivedContent).some((key) => key !== "summary")
    || !validString(pack.derivedContent.summary, 6_000)
    || !validString(pack.contentDigest, 128)) return reject("CONTEXT_PACK_INVALID");
  const trustedBuildIdentities = options.trustedBuildIdentities ?? null;
  if (trustedBuildIdentities
    ? !trustedBuildIdentities.includes(pack.buildIdentity)
    : !/^codex-threadgraph\/[0-9A-Za-z][0-9A-Za-z.+-]*$/.test(pack.buildIdentity)) return reject("CONTEXT_PACK_SOURCE_UNTRUSTED");
  let expectedDigest;
  try { expectedDigest = fingerprint(CONTENT_NAMESPACE, preimage(pack)); } catch { return reject("CONTEXT_PACK_INVALID"); }
  if (pack.contentDigest !== expectedDigest) return reject("CONTEXT_PACK_DIGEST_MISMATCH");
  if (pack.packId !== expectedPackId(pack)) return reject("CONTEXT_PACK_ID_MISMATCH");
  const cutoff = parseCanonicalTimestamp(pack.observationCutoff);
  const generated = parseCanonicalTimestamp(pack.generatedAt);
  const current = options.currentTime ? parseCanonicalTimestamp(options.currentTime) : Date.now();
  if (cutoff === null || generated === null || current === null || cutoff > generated) return reject("CONTEXT_PACK_TIME_INVALID");
  const maxFutureSkewMs = options.maxFutureSkewMs ?? 5 * 60 * 1_000;
  if (generated > current + maxFutureSkewMs) return reject("CONTEXT_PACK_TIME_INVALID");
  if (current - cutoff > (options.maxAgeMs ?? 30 * 24 * 60 * 60 * 1_000)) return reject("CONTEXT_PACK_STALE");
  if (pack.unresolvedConflicts.length > 0) return reject("CONTEXT_PACK_CONFLICTED");
  if (pack.missingSources.length > 0 && options.allowMissingSources !== true) return reject("CONTEXT_PACK_SOURCE_MISSING");
  return Object.freeze({
    decision: pack.missingSources.length ? "partial" : "allow",
    code: null,
    mutated: false,
    provenanceOnly: true,
    executionAuthority: false,
    packId: pack.packId,
    warnings: pack.missingSources.map((source) => ({ code: "CONTEXT_PACK_SOURCE_MISSING", source })),
  });
}

export class ThreadGraphContextPackImporter {
  constructor(registry) {
    this.registry = registry;
  }

  import(pack, options = {}) {
    const validation = validateThreadGraphContextPack(pack, options);
    if (validation.decision === "reject") return validation;
    const claimId = `claim_threadgraph_${pack.packId.slice(4)}`;
    this.registry.db.exec("BEGIN IMMEDIATE");
    try {
      const claim = this.registry.createContextClaim({
        id: claimId,
        projectId: options.projectId ?? null,
        kind: "note",
        subject: `threadgraph:${pack.purpose}`,
        body: pack.derivedContent.summary,
        scope: options.projectId ? "project" : "global",
        authority: "observed_thread",
        status: "candidate",
        metadata: {
          importKind: "threadgraph_context_pack",
          provenanceOnly: true,
          executionAuthority: false,
          buildIdentity: pack.buildIdentity,
          scopeId: pack.scopeId,
          graphRevisionId: pack.graphRevisionId,
          observationCutoff: pack.observationCutoff,
          selectedClaimIds: pack.selectedClaimIds,
          selectedEvidenceIds: pack.selectedEvidenceIds,
          missingSources: pack.missingSources,
        },
      });
      this.registry.addContextClaimSource(claim.id, {
        kind: "threadgraph_context_pack",
        id: pack.packId,
        revision: pack.graphRevisionId,
        digest: pack.contentDigest,
        metadata: { buildIdentity: pack.buildIdentity, scopeId: pack.scopeId, generatedAt: pack.generatedAt },
      });
      this.registry.db.exec("COMMIT");
      return Object.freeze({
        ...validation,
        mutated: true,
        claimId: claim.id,
        claimStatus: this.registry.getContextClaim(claim.id).status,
      });
    } catch (error) {
      this.registry.db.exec("ROLLBACK");
      throw error;
    }
  }
}

export const THREADGRAPH_CONTEXT_PACK_SCHEMA_VERSION = SCHEMA_VERSION;
