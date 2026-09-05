import { createHash } from "node:crypto";

export const THREAD_LIFECYCLE_STATUSES = Object.freeze(["candidate", "active", "idle", "compacted", "superseded", "archived"]);
export const THREAD_TYPES = Object.freeze(["durable_specialist", "run_orchestrator", "ephemeral_worker"]);
export const THREAD_BUDGET_VERSION = 1;
export function isControlPlaneAgent(agent) {
  return Boolean(agent?.metadata?.controlPlane || agent?.metadata?.orchestrationPlane
    || ["control", "orchestrator"].includes(agent?.metadata?.executionPlane)
    || (agent?.metadata?.controlPlaneManaged && ["planner", "validator", "synthesizer", "orchestrator"].includes(agent.role)));
}
export const DEFAULT_THREAD_BUDGET = Object.freeze({
  version: THREAD_BUDGET_VERSION,
  maxProjectThreads: 8,
  maxRoleThreads: 3,
  maxLineageForks: 4,
  maxReuseCount: 12,
  minContextHealth: 0.25,
  queueWhenBusy: true,
});

const TRANSITIONS = new Map([
  ["candidate", new Set(["active", "idle", "archived"])],
  ["active", new Set(["idle"])],
  ["idle", new Set(["active", "compacted", "superseded", "archived"])],
  ["compacted", new Set(["superseded", "archived"])],
  ["superseded", new Set(["archived"])],
  ["archived", new Set(["idle"])],
]);

function lifecycleError(message, code = "THREAD_LIFECYCLE_INVALID") {
  return Object.assign(new Error(message), { code });
}

export function assertThreadLifecycleStatus(status) {
  if (!THREAD_LIFECYCLE_STATUSES.includes(status)) throw lifecycleError(`Unsupported thread lifecycle status: ${status}`);
  return status;
}

export function transitionThreadLifecycle(from, to) {
  assertThreadLifecycleStatus(from);
  assertThreadLifecycleStatus(to);
  if (from === to) return to;
  if (!TRANSITIONS.get(from)?.has(to)) throw lifecycleError(`Illegal thread lifecycle transition: ${from} -> ${to}`, "THREAD_LIFECYCLE_TRANSITION_INVALID");
  return to;
}

export function validateThreadBudget(input = {}) {
  const policy = {
    version: input.version ?? THREAD_BUDGET_VERSION,
    maxProjectThreads: input.maxProjectThreads ?? DEFAULT_THREAD_BUDGET.maxProjectThreads,
    maxRoleThreads: input.maxRoleThreads ?? DEFAULT_THREAD_BUDGET.maxRoleThreads,
    maxLineageForks: input.maxLineageForks ?? DEFAULT_THREAD_BUDGET.maxLineageForks,
    maxReuseCount: input.maxReuseCount ?? DEFAULT_THREAD_BUDGET.maxReuseCount,
    minContextHealth: input.minContextHealth ?? DEFAULT_THREAD_BUDGET.minContextHealth,
    queueWhenBusy: input.queueWhenBusy ?? DEFAULT_THREAD_BUDGET.queueWhenBusy,
  };
  if (policy.version !== THREAD_BUDGET_VERSION) throw lifecycleError(`Unsupported thread budget version: ${policy.version}`, "THREAD_BUDGET_VERSION_UNSUPPORTED");
  for (const field of ["maxProjectThreads", "maxRoleThreads", "maxLineageForks", "maxReuseCount"]) {
    if (!Number.isInteger(policy[field]) || policy[field] < 0) throw lifecycleError(`${field} must be a non-negative integer`, "THREAD_BUDGET_INVALID");
  }
  if (typeof policy.minContextHealth !== "number" || policy.minContextHealth < 0 || policy.minContextHealth > 1) throw lifecycleError("minContextHealth must be between 0 and 1", "THREAD_BUDGET_INVALID");
  if (typeof policy.queueWhenBusy !== "boolean") throw lifecycleError("queueWhenBusy must be boolean", "THREAD_BUDGET_INVALID");
  return Object.freeze(policy);
}

export function threadBudgetFingerprint(policy) {
  const validated = validateThreadBudget(policy);
  return createHash("sha256").update(JSON.stringify(Object.fromEntries(Object.entries(validated).sort(([a], [b]) => a.localeCompare(b))))).digest("hex");
}

export function estimateContextHealth(agent, knowledge = null) {
  if (["compacted", "superseded", "archived"].includes(agent.lifecycle?.status)) return 0;
  let score = 0.35;
  if (knowledge?.id) score += 0.25;
  if (knowledge?.claimIds?.length) score += Math.min(knowledge.claimIds.length * 0.04, 0.2);
  const timestamp = agent.metadata?.contextUpdatedAt ?? agent.lastTaskAt ?? agent.updatedAt;
  if (timestamp) {
    const ageDays = Math.max((Date.now() - new Date(timestamp).valueOf()) / 86_400_000, 0);
    if (ageDays <= 7) score += 0.15;
    else if (ageDays > 90) score -= 0.2;
  }
  score -= Math.min(Number(agent.metadata?.reuseCount ?? 0) * 0.015, 0.25);
  return Math.max(0, Math.min(1, Number(score.toFixed(3))));
}

export function isEphemeralTask(request = {}) {
  const contract = request.executionContract ?? {};
  return ["analysis", "review"].includes(contract.taskKind)
    && contract.sideEffectPolicy === "none"
    && !contract.mutatesWorkspace
    && !(request.capabilities?.length)
    && !(request.tools?.length);
}
