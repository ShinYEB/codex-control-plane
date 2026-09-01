import { createHash } from "node:crypto";

export const CONTEXT_CLAIM_KINDS = Object.freeze(["fact", "decision", "constraint", "assumption", "artifact", "result", "architecture", "note", "task_result"]);
export const CONTEXT_CLAIM_SCOPES = Object.freeze(["global", "project", "workspace", "task"]);
export const CONTEXT_CLAIM_AUTHORITIES = Object.freeze([
  "legacy_unverified",
  "model_inference",
  "observed_thread",
  "validated_task_result",
  "validated_artifact",
  "project_contract",
  "user_explicit",
]);
export const CONTEXT_CLAIM_STATUSES = Object.freeze(["candidate", "active", "disputed", "superseded", "expired", "rejected"]);

const AUTHORITY_RANK = new Map(CONTEXT_CLAIM_AUTHORITIES.map((authority, index) => [authority, index]));

export function authorityRank(authority) {
  const rank = AUTHORITY_RANK.get(authority);
  if (rank === undefined) throw Object.assign(new TypeError(`Unsupported context authority: ${authority}`), { code: "CONTEXT_AUTHORITY_INVALID" });
  return rank;
}

export function contextContentHash(claim) {
  return createHash("sha256").update(JSON.stringify({
    kind: claim.kind,
    subject: claim.subject ?? null,
    body: claim.body,
    scope: claim.scope,
    projectId: claim.projectId ?? null,
  })).digest("hex");
}

export function validateContextClaim(claim, options = {}) {
  if (!claim?.id) throw Object.assign(new TypeError("Context claim id is required"), { code: "CONTEXT_CLAIM_ID_REQUIRED" });
  if (!CONTEXT_CLAIM_KINDS.includes(claim.kind)) throw Object.assign(new TypeError(`Unsupported context claim kind: ${claim.kind}`), { code: "CONTEXT_CLAIM_KIND_INVALID" });
  if (typeof claim.body !== "string" || !claim.body.trim()) throw Object.assign(new TypeError("Context claim body is required"), { code: "CONTEXT_CLAIM_BODY_REQUIRED" });
  if (!CONTEXT_CLAIM_SCOPES.includes(claim.scope)) throw Object.assign(new TypeError(`Unsupported context claim scope: ${claim.scope}`), { code: "CONTEXT_CLAIM_SCOPE_INVALID" });
  authorityRank(claim.authority);
  if (!CONTEXT_CLAIM_STATUSES.includes(claim.status)) throw Object.assign(new TypeError(`Unsupported context claim status: ${claim.status}`), { code: "CONTEXT_CLAIM_STATUS_INVALID" });
  if (options.creating && ["active", "disputed", "superseded"].includes(claim.status)) {
    throw Object.assign(new Error("Context claims must be created as candidates before provenance validation"), { code: "CONTEXT_CLAIM_PREMATURE_ACTIVATION" });
  }
  return claim;
}

export function assertCanSupersede(incoming, target) {
  if (!target) throw Object.assign(new Error("Superseded context claim was not found"), { code: "CONTEXT_SUPERSEDE_TARGET_MISSING" });
  if (!["active", "disputed"].includes(target.status)) {
    throw Object.assign(new Error(`Context claim ${target.id} cannot be superseded from ${target.status}`), { code: "CONTEXT_SUPERSEDE_TARGET_INACTIVE" });
  }
  if (target.authority === "user_explicit" && incoming.authority !== "user_explicit") {
    throw Object.assign(new Error("Only another explicit user claim may supersede an explicit user decision"), { code: "CONTEXT_AUTHORITY_DOWNGRADE" });
  }
  if (authorityRank(incoming.authority) < authorityRank(target.authority)) {
    throw Object.assign(new Error(`Authority ${incoming.authority} cannot supersede ${target.authority}`), { code: "CONTEXT_AUTHORITY_DOWNGRADE" });
  }
  if (incoming.projectId !== target.projectId || incoming.scope !== target.scope || incoming.subject !== target.subject) {
    throw Object.assign(new Error("Superseding claims must have the same project, scope, and subject"), { code: "CONTEXT_SUPERSEDE_SCOPE_MISMATCH" });
  }
}
