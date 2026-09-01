import { createHash } from "node:crypto";
import { authorityRank } from "./context-claims.js";

export const CONTEXT_RESOLVER_VERSION = "context-resolver/v1";

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function hash(value) {
  return createHash("sha256").update(typeof value === "string" ? value : stable(value)).digest("hex");
}

function tokens(value) {
  return new Set(String(value ?? "").toLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) ?? []);
}

function overlap(left, right) {
  let count = 0;
  for (const token of left) if (right.has(token)) count += 1;
  return count;
}

function conflictCategory(claim) {
  const subject = String(claim.subject ?? "").toLowerCase();
  if (/(auth|permission|sandbox|side.?effect|승인|권한)/.test(subject)) return "authorization";
  if (/(workspace|worktree|repo|branch|cwd|작업.?공간|브랜치)/.test(subject)) return "workspace";
  if (/(contract|schema|api|version|architecture|constraint|계약|스키마|설계)/.test(subject) || ["constraint", "decision", "architecture"].includes(claim.kind)) return "contract";
  if (["fact", "result", "task_result", "artifact"].includes(claim.kind)) return "factual";
  return "preference";
}

function invalidSnapshotError(snapshot) {
  const detail = snapshot.error ?? {};
  const error = new Error(detail.message ?? "Context snapshot is invalid");
  error.code = "CONTEXT_SNAPSHOT_INVALID";
  error.category = detail.category ?? "configuration";
  error.causeCode = detail.cause ?? "unresolved_context_conflict";
  error.repairable = detail.repairable ?? true;
  error.nextAction = detail.nextAction ?? "Resolve the conflicting or missing context claims, then create a new snapshot revision.";
  error.contextSnapshotId = snapshot.id;
  return error;
}

export class ContextResolver {
  constructor(registry, options = {}) {
    this.registry = registry;
    this.version = options.version ?? CONTEXT_RESOLVER_VERSION;
    this.defaultBudget = options.defaultBudget ?? 12_000;
  }

  resolve(options) {
    if (!options?.objective?.trim()) throw new TypeError("Context resolution requires an objective");
    let project = options.projectId ? this.registry.getProject(options.projectId) : null;
    if (!project && options.cwd) {
      try {
        project = this.registry.resolveProject(options.cwd);
      } catch (error) {
        if (error.code !== "PROJECT_PATH_UNRESOLVED") throw error;
      }
    }
    const requiredSubjects = [...new Set(options.requiredSubjects ?? [])].map(String).sort();
    const excludedClaimIds = [...new Set(options.excludedClaimIds ?? [])].map(String).sort();
    const requestedThreadIds = [...new Set(options.requestedThreadIds ?? [])].map(String).sort();
    const requestedThreads = requestedThreadIds.map((threadId) => {
      const knowledge = this.registry.listThreadKnowledgeSnapshots({ threadId, status: "current", limit: 1 })[0] ?? null;
      return { threadId, snapshotId: knowledge?.id ?? null, sourceDigest: knowledge?.sourceDigest ?? null, status: knowledge?.status ?? "missing", topics: knowledge?.topics ?? [] };
    });
    const requestedScope = {
      projectId: project?.id ?? null,
      cwd: project?.canonicalRoot ?? options.cwd ?? null,
      requiredSubjects,
      excludedClaimIds,
      requestedThreads,
      maxContextBudget: options.maxContextBudget ?? this.defaultBudget,
    };
    const objectiveHash = hash(options.objective.trim());
    const requestedScopeHash = hash(requestedScope);
    const revision = options.objectiveRevision ?? 1;
    const resolutionKey = hash({ objectiveHash, requestedScopeHash, resolverVersion: this.version, revision });
    let snapshot = this.registry.getContextSnapshotByResolutionKey(resolutionKey);
    if (snapshot?.status === "validated") return this.assertSnapshot(snapshot);
    if (snapshot?.status === "invalid") throw invalidSnapshotError(snapshot);
    snapshot ??= this.registry.createContextSnapshot({
      resolutionKey, projectId: project?.id ?? null, objectiveHash, requestedScopeHash,
      resolverVersion: this.version, revision, metadata: { requestedScope, objective: options.objective.trim() },
    });

    const all = this.registry.listContextClaims({ statuses: ["active", "disputed"], limit: 10_000 });
    const candidates = all.filter((claim) => claim.scope === "global" || (project?.id && claim.projectId === project.id));
    const excludedSet = new Set(excludedClaimIds);
    const objectiveTokens = tokens(`${options.objective} ${requiredSubjects.join(" ")}`);
    const evaluated = candidates.map((claim) => {
      const relevance = overlap(objectiveTokens, tokens(`${claim.subject ?? ""} ${claim.body}`));
      const required = claim.subject && requiredSubjects.includes(claim.subject);
      return {
        claim,
        score: authorityRank(claim.authority) * 100 + relevance * 10 + (required ? 1_000 : 0),
        reasons: [required ? "required_subject" : null, relevance ? `objective_overlap:${relevance}` : null, `authority:${claim.authority}`].filter(Boolean),
      };
    });

    const conflicts = [];
    const conflictClaimIds = new Set();
    const groups = new Map();
    for (const item of evaluated) {
      if (!item.claim.subject || excludedSet.has(item.claim.id)) continue;
      const key = `${item.claim.projectId ?? "global"}\0${item.claim.scope}\0${item.claim.subject}`;
      const group = groups.get(key) ?? [];
      group.push(item);
      groups.set(key, group);
    }
    for (const group of groups.values()) {
      if (new Set(group.map((item) => item.claim.contentHash)).size < 2) continue;
      const highestRank = Math.max(...group.map((item) => authorityRank(item.claim.authority)));
      const top = group.filter((item) => authorityRank(item.claim.authority) === highestRank);
      if (new Set(top.map((item) => item.claim.contentHash)).size < 2) continue;
      const category = conflictCategory(top[0].claim);
      const blocking = ["authorization", "contract", "workspace"].includes(category)
        || (category === "factual" && requiredSubjects.includes(top[0].claim.subject));
      const claimIds = top.map((item) => item.claim.id).sort();
      const fingerprint = hash({ projectId: top[0].claim.projectId, scope: top[0].claim.scope, subject: top[0].claim.subject, category, claimIds, hashes: top.map((item) => item.claim.contentHash).sort() });
      conflicts.push({ projectId: top[0].claim.projectId, subject: top[0].claim.subject, scope: top[0].claim.scope, category, blocking, status: "unresolved", claimIds, fingerprint });
      if (blocking) for (const claimId of claimIds) conflictClaimIds.add(claimId);
    }

    const availableSubjects = new Set(evaluated.filter((item) => !excludedSet.has(item.claim.id)).map((item) => item.claim.subject).filter(Boolean));
    const missingSubjects = requiredSubjects.filter((subject) => !availableSubjects.has(subject));
    const missingThreadIds = requestedThreads.filter((thread) => thread.status !== "current" || !thread.sourceDigest).map((thread) => thread.threadId);
    const blockingConflicts = conflicts.filter((conflict) => conflict.blocking && conflict.status === "unresolved");
    const invalid = blockingConflicts.length || missingSubjects.length || missingThreadIds.length;
    const budget = requestedScope.maxContextBudget;
    let used = 0;
    const selected = [];
    const excluded = [];
    for (const item of evaluated.sort((a, b) => b.score - a.score || a.claim.id.localeCompare(b.claim.id))) {
      const size = item.claim.body.length + (item.claim.subject?.length ?? 0);
      let reason = null;
      if (excludedSet.has(item.claim.id)) reason = "explicitly_excluded";
      else if (conflictClaimIds.has(item.claim.id)) reason = "blocking_conflict";
      else if (used + size > budget) reason = "context_budget";
      if (reason) excluded.push({ claimId: item.claim.id, score: item.score, reasons: [...item.reasons, reason] });
      else {
        selected.push({ claimId: item.claim.id, score: item.score, reasons: item.reasons });
        used += size;
      }
    }
    const fingerprint = invalid ? null : this.#fingerprint(snapshot, selected, conflicts);
    const error = invalid ? {
      category: blockingConflicts.some((conflict) => conflict.category === "authorization") ? "policy" : "configuration",
      cause: blockingConflicts.length ? "unresolved_context_conflict" : missingSubjects.length ? "required_context_missing" : "requested_thread_knowledge_missing",
      message: blockingConflicts.length
        ? `Context resolution found ${blockingConflicts.length} blocking conflict(s)`
        : missingSubjects.length
          ? `Required context subjects are missing: ${missingSubjects.join(", ")}`
          : `Requested thread knowledge is missing: ${missingThreadIds.join(", ")}`,
      repairable: true,
      nextAction: "Resolve or supersede the conflicting claims, or provide the missing required context, then create a new objective revision.",
      conflictIds: blockingConflicts.map((conflict) => conflict.fingerprint), missingSubjects, missingThreadIds,
    } : null;
    const finalized = this.registry.finalizeContextSnapshot(snapshot.id, {
      status: invalid ? "invalid" : "validated", fingerprint, selected, excluded, conflicts, error,
      metadata: { ...snapshot.metadata, selectedClaimIds: selected.map((item) => item.claimId), excludedClaimIds: excluded.map((item) => item.claimId), usedBudget: used },
    });
    if (invalid) throw invalidSnapshotError(finalized);
    return finalized;
  }

  assertSnapshot(snapshotOrId) {
    const snapshot = typeof snapshotOrId === "string" ? this.registry.getContextSnapshot(snapshotOrId) : this.registry.getContextSnapshot(snapshotOrId?.id);
    if (!snapshot || snapshot.status !== "validated") throw invalidSnapshotError(snapshot ?? { id: snapshotOrId, error: { message: "Context snapshot is missing or not validated", cause: "context_snapshot_not_validated" } });
    const selected = snapshot.claims.filter((item) => item.disposition === "selected").map((item) => ({ claimId: item.claim.id }));
    const expected = this.#fingerprint(snapshot, selected, snapshot.conflicts);
    if (expected !== snapshot.fingerprint) {
      throw invalidSnapshotError({ ...snapshot, error: { message: "Context snapshot fingerprint does not match its persisted claims", cause: "context_snapshot_fingerprint_mismatch", repairable: true } });
    }
    return snapshot;
  }

  format(snapshotOrId) {
    const snapshot = this.assertSnapshot(snapshotOrId);
    const selected = snapshot.claims.filter((item) => item.disposition === "selected");
    const threadKnowledge = (snapshot.metadata?.requestedScope?.requestedThreads ?? [])
      .filter((thread) => thread.status === "current")
      .map((thread) => `- [thread-index] ${thread.threadId}: topics=${thread.topics.join(", ")} (snapshot=${thread.snapshotId}; digest=${thread.sourceDigest})`);
    const claims = selected.map(({ claim, reasons }) => `- [${claim.authority}/${claim.scope}] ${claim.subject ?? claim.kind}: ${claim.body} (claim=${claim.id}; ${reasons.join(", ")})`);
    return [...threadKnowledge, ...claims].join("\n") || "No validated context claims or requested thread indexes were selected.";
  }

  #fingerprint(snapshot, selected, conflicts) {
    const claimRecords = selected.map((item) => {
      const claim = this.registry.getContextClaim(item.claimId);
      return { id: claim?.id, contentHash: claim?.contentHash, revision: claim?.revision, authority: claim?.authority, status: claim?.status };
    }).sort((a, b) => a.id.localeCompare(b.id));
    return hash({ resolverVersion: snapshot.resolverVersion, objectiveHash: snapshot.objectiveHash, requestedScopeHash: snapshot.requestedScopeHash, revision: snapshot.revision, claims: claimRecords, conflicts: conflicts.map((item) => ({ fingerprint: item.fingerprint, blocking: item.blocking, status: item.status })).sort((a, b) => a.fingerprint.localeCompare(b.fingerprint)) });
  }
}

export { hash as contextSnapshotHash };
