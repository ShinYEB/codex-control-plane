export const RUN_STATUSES = Object.freeze([
  "draft", "accepted", "planning", "preparing", "agents_prepared", "awaiting_user_start",
  "running", "completed", "failed", "cancelled",
]);

export const GLOBAL_RUN_STATUSES = Object.freeze([
  "accepted", "resolving_context", "planning", "preparing", "running", "waiting",
  "completed", "failed", "cancelled", "attention_required",
]);

export const TASK_STATUSES = Object.freeze([
  "staged", "blocked", "queued", "waiting_for_lease", "retry_waiting",
  "running", "approval_waiting", "agent_done", "validating", "integration_pending", "upgrade_pending",
  "recovery_attention", "completed", "completed_with_warnings", "skipped", "rejected",
  "validation_failed", "failed", "canceled", "interrupted", "blocked_by_policy", "integration_blocked",
]);

export const AGENT_STATUSES = Object.freeze(["unknown", "available", "idle", "leased", "running", "validating", "approval_waiting"]);
export const LEASE_STATUSES = Object.freeze(["active", "released", "expired"]);
export const DELIVERY_STATUSES = Object.freeze(["pending", "delivering", "retry_waiting", "pending_attention", "direct_delivered", "delivered"]);
export const TURN_DISPATCH_STATUSES = Object.freeze([
  "prepared", "thread_acquiring", "thread_created", "turn_submitting", "turn_running",
  "cancelling", "completed", "failed", "interrupted", "cancelled", "recovery_attention",
]);

export const TERMINAL_RUN_STATUSES = new Set(["completed", "failed", "cancelled"]);
export const TERMINAL_GLOBAL_RUN_STATUSES = new Set(["completed", "failed", "cancelled", "attention_required"]);
export const ACTIVE_GLOBAL_RUN_STATUSES = new Set(GLOBAL_RUN_STATUSES.filter((status) => !TERMINAL_GLOBAL_RUN_STATUSES.has(status)));
export const ACTIVE_RUN_STATUSES = new Set(RUN_STATUSES.filter((status) => !TERMINAL_RUN_STATUSES.has(status) && status !== "draft"));
export const SUCCESSFUL_TASK_STATUSES = new Set(["completed", "completed_with_warnings", "skipped"]);
export const TERMINAL_TASK_STATUSES = new Set([
  ...SUCCESSFUL_TASK_STATUSES,
  "rejected", "validation_failed", "failed", "canceled", "interrupted",
  "blocked_by_policy", "integration_blocked", "recovery_attention",
]);
export const FAILED_TASK_STATUSES = new Set([
  "rejected", "validation_failed", "failed", "interrupted", "blocked_by_policy", "integration_blocked", "recovery_attention",
]);
export const ACTIVE_TASK_STATUSES = new Set(["running", "approval_waiting", "agent_done", "validating", "integration_pending", "upgrade_pending"]);
export const WAITING_TASK_STATUSES = new Set(["staged", "blocked", "queued", "retry_waiting", "waiting_for_lease"]);
export const REPAIRABLE_TASK_STATUSES = new Set([
  "rejected", "validation_failed", "failed", "interrupted", "canceled", "blocked_by_policy", "integration_blocked", "recovery_attention",
]);
export const ATTENTION_TASK_STATUSES = new Set(["recovery_attention", "blocked_by_policy", "integration_blocked"]);
export const RETRYABLE_TASK_STATUSES = new Set(["retry_waiting", "waiting_for_lease"]);
export const ACTIVE_AGENT_STATUSES = new Set(["leased", "running", "validating", "approval_waiting"]);
export const TERMINAL_LEASE_STATUSES = new Set(["released", "expired"]);
export const TERMINAL_DELIVERY_STATUSES = new Set(["direct_delivered", "delivered"]);
export const WAITING_DELIVERY_STATUSES = new Set(["pending", "retry_waiting", "pending_attention"]);
export const TERMINAL_TURN_DISPATCH_STATUSES = new Set(["completed", "failed", "interrupted", "cancelled", "recovery_attention"]);
export const ACTIVE_TURN_DISPATCH_STATUSES = new Set(TURN_DISPATCH_STATUSES.filter((status) => !TERMINAL_TURN_DISPATCH_STATUSES.has(status)));

const RUN_TRANSITIONS = new Map([
  ["draft", new Set(["accepted", "planning", "preparing", "running", "failed", "cancelled"])],
  ["accepted", new Set(["planning", "failed", "cancelled"])],
  ["planning", new Set(["preparing", "failed", "cancelled"])],
  ["preparing", new Set(["agents_prepared", "awaiting_user_start", "running", "failed", "cancelled"])],
  ["agents_prepared", new Set(["running", "failed", "cancelled"])],
  ["awaiting_user_start", new Set(["preparing", "running", "failed", "cancelled"])],
  ["running", new Set(["completed", "failed", "cancelled"])],
  ["completed", new Set()],
  ["failed", new Set()],
  ["cancelled", new Set()],
]);

const GLOBAL_RUN_TRANSITIONS = new Map([
  ["accepted", new Set(["resolving_context", "failed", "cancelled"])],
  ["resolving_context", new Set(["planning", "failed", "attention_required", "cancelled"])],
  ["planning", new Set(["preparing", "failed", "attention_required", "cancelled"])],
  ["preparing", new Set(["running", "failed", "attention_required", "cancelled"])],
  ["running", new Set(["waiting", "completed", "failed", "attention_required", "cancelled"])],
  ["waiting", new Set(["running", "failed", "attention_required", "cancelled"] )],
  ["completed", new Set()], ["failed", new Set()], ["cancelled", new Set()], ["attention_required", new Set()],
]);

const EXECUTION_TERMINALS = [
  "completed", "completed_with_warnings", "rejected", "validation_failed", "failed", "canceled",
  "interrupted", "blocked_by_policy", "integration_blocked", "recovery_attention",
];
const TASK_TRANSITIONS = new Map([
  ["staged", new Set(["blocked", "queued", "canceled", "failed", "blocked_by_policy"])],
  ["blocked", new Set(["queued", "skipped", "failed", "canceled", "blocked_by_policy", "recovery_attention"])],
  ["queued", new Set(["running", "failed", "canceled", "blocked_by_policy", "recovery_attention"])],
  ["waiting_for_lease", new Set(["running", "failed", "canceled", "recovery_attention"])],
  ["retry_waiting", new Set(["running", "failed", "canceled", "recovery_attention"])],
  ["running", new Set(["approval_waiting", "agent_done", "integration_pending", "retry_waiting", "waiting_for_lease", ...EXECUTION_TERMINALS])],
  ["approval_waiting", new Set(["running", "agent_done", "integration_pending", "retry_waiting", ...EXECUTION_TERMINALS])],
  ["agent_done", new Set(["validating", "retry_waiting", ...EXECUTION_TERMINALS])],
  ["validating", new Set(["integration_pending", "retry_waiting", ...EXECUTION_TERMINALS])],
  ["integration_pending", new Set(EXECUTION_TERMINALS)],
  ["upgrade_pending", new Set(["queued", "running", "failed", "canceled", "recovery_attention"])],
  ["recovery_attention", new Set(["canceled"])],
  ["completed", new Set()],
  ["completed_with_warnings", new Set()],
  ["skipped", new Set()],
  ["rejected", new Set()],
  ["validation_failed", new Set()],
  ["failed", new Set()],
  ["canceled", new Set()],
  ["interrupted", new Set()],
  ["blocked_by_policy", new Set()],
  ["integration_blocked", new Set()],
]);

const AGENT_TRANSITIONS = new Map([
  ["unknown", new Set(["available", "idle", "leased", "running", "approval_waiting"])],
  ["available", new Set(["unknown", "idle", "leased", "running", "approval_waiting"])],
  ["idle", new Set(["unknown", "available", "leased", "running", "validating", "approval_waiting"])],
  ["leased", new Set(["unknown", "available", "idle", "running", "approval_waiting"])],
  ["running", new Set(["unknown", "available", "idle", "validating", "approval_waiting"])],
  ["validating", new Set(["unknown", "available", "idle", "running", "approval_waiting"])],
  ["approval_waiting", new Set(["unknown", "available", "idle", "running", "validating"])],
]);

const LEASE_TRANSITIONS = new Map([
  ["active", new Set(["released", "expired"])],
  ["released", new Set(["active"])],
  ["expired", new Set(["active", "released"])],
]);

const DELIVERY_TRANSITIONS = new Map([
  ["pending", new Set(["delivering", "retry_waiting", "pending_attention", "direct_delivered", "delivered"])],
  ["delivering", new Set(["retry_waiting", "pending_attention", "direct_delivered", "delivered"])],
  ["retry_waiting", new Set(["delivering", "retry_waiting", "pending_attention", "direct_delivered", "delivered"])],
  ["pending_attention", new Set(["delivering", "retry_waiting", "direct_delivered", "delivered"])],
  ["direct_delivered", new Set()],
  ["delivered", new Set()],
]);

const TURN_DISPATCH_TRANSITIONS = new Map([
  ["prepared", new Set(["thread_acquiring", "cancelling", "failed", "cancelled", "recovery_attention"])],
  ["thread_acquiring", new Set(["thread_created", "cancelling", "failed", "cancelled", "recovery_attention"])],
  ["thread_created", new Set(["turn_submitting", "cancelling", "failed", "cancelled", "recovery_attention"])],
  ["turn_submitting", new Set(["turn_running", "completed", "failed", "interrupted", "cancelling", "cancelled", "recovery_attention"])],
  ["turn_running", new Set(["completed", "failed", "interrupted", "cancelling", "recovery_attention"])],
  ["cancelling", new Set(["completed", "failed", "interrupted", "cancelled", "recovery_attention"])],
  ["completed", new Set()], ["failed", new Set()], ["interrupted", new Set()],
  ["cancelled", new Set()], ["recovery_attention", new Set()],
]);

function assertKnown(status, values, entity) {
  if (!values.includes(status)) throw Object.assign(new Error(`Unsupported ${entity} status: ${status}`), { code: "STATE_INVALID" });
  return status;
}

export function assertRunStatus(status) {
  return assertKnown(status, RUN_STATUSES, "Run");
}

export function assertGlobalRunStatus(status) {
  return assertKnown(status, GLOBAL_RUN_STATUSES, "Global Run");
}

export function assertTaskStatus(status) {
  return assertKnown(status, TASK_STATUSES, "Task");
}

export function assertAgentStatus(status) {
  return assertKnown(status, AGENT_STATUSES, "Agent");
}

export function normalizeAgentStatus(status, activeFlags = []) {
  if (status === "notLoaded") return "available";
  if (status === "systemError") return "unknown";
  if (status === "active") {
    return activeFlags.includes("waitingOnApproval") || activeFlags.includes("waitingOnUserInput")
      ? "approval_waiting"
      : "running";
  }
  return status ?? "unknown";
}

export function assertLeaseStatus(status) {
  return assertKnown(status, LEASE_STATUSES, "Lease");
}

export function assertDeliveryStatus(status) {
  return assertKnown(status, DELIVERY_STATUSES, "Delivery");
}

export function assertTurnDispatchStatus(status) {
  return assertKnown(status, TURN_DISPATCH_STATUSES, "TurnDispatch");
}

function transition(from, to, transitions, assertStatus, entity, options = {}) {
  assertStatus(from);
  assertStatus(to);
  if (from === to) return to;
  if (options.allowSync) return to;
  if (!transitions.get(from)?.has(to)) throw Object.assign(new Error(`Illegal ${entity} transition: ${from} -> ${to}`), { code: `${entity.toUpperCase()}_STATE_TRANSITION_INVALID` });
  return to;
}

export function transitionRun(from, to, options = {}) {
  assertRunStatus(from);
  assertRunStatus(to);
  if (from === to) return to;
  if (options.allowRepair && TERMINAL_RUN_STATUSES.has(from) && to === "running") return to;
  return transition(from, to, RUN_TRANSITIONS, assertRunStatus, "Run", options);
}

export function transitionGlobalRun(from, to, options = {}) {
  return transition(from, to, GLOBAL_RUN_TRANSITIONS, assertGlobalRunStatus, "GlobalRun", options);
}

export function transitionTask(from, to, options = {}) {
  assertTaskStatus(from);
  assertTaskStatus(to);
  if (from === to) return to;
  if (options.allowRepair && REPAIRABLE_TASK_STATUSES.has(from) && to === "blocked") return to;
  return transition(from, to, TASK_TRANSITIONS, assertTaskStatus, "Task", options);
}

export function transitionAgent(from, to, options = {}) {
  return transition(from, to, AGENT_TRANSITIONS, assertAgentStatus, "Agent", options);
}

export function transitionLease(from, to, options = {}) {
  return transition(from, to, LEASE_TRANSITIONS, assertLeaseStatus, "Lease", options);
}

export function transitionDelivery(from, to, options = {}) {
  return transition(from, to, DELIVERY_TRANSITIONS, assertDeliveryStatus, "Delivery", options);
}

export function transitionTurnDispatch(from, to, options = {}) {
  if (from === "recovery_attention" && options.observedTerminal === true && ["completed", "failed", "interrupted"].includes(to)) return to;
  return transition(from, to, TURN_DISPATCH_TRANSITIONS, assertTurnDispatchStatus, "TurnDispatch", options);
}

export const assertRunTransition = transitionRun;
export const assertTaskTransition = transitionTask;

const SEMANTIC_TABLES = Object.freeze({
  global_run: Object.fromEntries(GLOBAL_RUN_STATUSES.map((status) => [status, {
    terminal: TERMINAL_GLOBAL_RUN_STATUSES.has(status),
    success: status === "completed",
    active: ACTIVE_GLOBAL_RUN_STATUSES.has(status),
    waiting: ["accepted", "resolving_context", "planning", "preparing", "waiting"].includes(status),
    attention: status === "attention_required",
    retry: ["failed", "attention_required"].includes(status) ? "new_revision" : "none",
    recovery: ["resolving_context", "planning", "preparing"].includes(status) ? "resume_pre_side_effect" : ["running", "waiting"].includes(status) ? "derive_from_project_runs" : "none",
  }])),
  run: Object.fromEntries(RUN_STATUSES.map((status) => [status, {
    terminal: TERMINAL_RUN_STATUSES.has(status),
    success: status === "completed",
    active: ACTIVE_RUN_STATUSES.has(status),
    waiting: ["draft", "accepted", "awaiting_user_start"].includes(status),
    attention: status === "failed",
    retry: status === "failed" ? "manual" : "none",
    recovery: ACTIVE_RUN_STATUSES.has(status) ? "derive_from_tasks" : "none",
  }])),
  task: Object.fromEntries(TASK_STATUSES.map((status) => [status, {
    terminal: TERMINAL_TASK_STATUSES.has(status),
    success: SUCCESSFUL_TASK_STATUSES.has(status),
    active: ACTIVE_TASK_STATUSES.has(status),
    waiting: WAITING_TASK_STATUSES.has(status),
    attention: ATTENTION_TASK_STATUSES.has(status),
    retry: RETRYABLE_TASK_STATUSES.has(status) ? "automatic" : REPAIRABLE_TASK_STATUSES.has(status) ? "repair" : "none",
    recovery: status === "integration_pending" || status === "recovery_attention" ? "manual_attention" : ACTIVE_TASK_STATUSES.has(status) ? "reconcile" : "none",
  }])),
  agent: Object.fromEntries(AGENT_STATUSES.map((status) => [status, {
    terminal: false,
    success: ["available", "idle"].includes(status),
    active: ACTIVE_AGENT_STATUSES.has(status),
    waiting: ["unknown", "available", "idle"].includes(status),
    attention: false,
    retry: "none",
    recovery: ACTIVE_AGENT_STATUSES.has(status) ? "lease_reconcile" : "none",
  }])),
  lease: Object.fromEntries(LEASE_STATUSES.map((status) => [status, {
    terminal: TERMINAL_LEASE_STATUSES.has(status),
    success: status === "released",
    active: status === "active",
    waiting: false,
    attention: status === "expired",
    retry: status === "expired" ? "reacquire" : "none",
    recovery: status === "active" ? "ttl_fence" : "none",
  }])),
  delivery: Object.fromEntries(DELIVERY_STATUSES.map((status) => [status, {
    terminal: TERMINAL_DELIVERY_STATUSES.has(status),
    success: ["direct_delivered", "delivered"].includes(status),
    active: status === "delivering",
    waiting: WAITING_DELIVERY_STATUSES.has(status),
    attention: status === "pending_attention",
    retry: ["retry_waiting", "pending_attention"].includes(status) ? "bounded" : "none",
    recovery: status === "delivering" ? "return_to_retry_waiting" : "none",
  }])),
  turn_dispatch: Object.fromEntries(TURN_DISPATCH_STATUSES.map((status) => [status, {
    terminal: TERMINAL_TURN_DISPATCH_STATUSES.has(status),
    success: status === "completed",
    active: ACTIVE_TURN_DISPATCH_STATUSES.has(status),
    waiting: ["prepared", "thread_acquiring", "thread_created", "turn_submitting", "cancelling"].includes(status),
    attention: status === "recovery_attention",
    retry: ["failed", "interrupted"].includes(status) ? "policy_decision" : "none",
    recovery: ["turn_submitting", "turn_running", "cancelling"].includes(status) ? "thread_read_reconcile" : ACTIVE_TURN_DISPATCH_STATUSES.has(status) ? "resume_fenced" : "none",
  }])),
});

export function statusSemantics(entity, status) {
  const table = SEMANTIC_TABLES[entity];
  if (!table) throw Object.assign(new Error(`Unsupported state entity: ${entity}`), { code: "STATE_ENTITY_INVALID" });
  const semantics = table[status];
  if (!semantics) throw Object.assign(new Error(`Unsupported ${entity} status: ${status}`), { code: "STATE_INVALID" });
  return semantics;
}

export function deriveRunStatus(tasks = []) {
  if (!tasks.length || !tasks.every((task) => TERMINAL_TASK_STATUSES.has(task.status))) return null;
  if (tasks.some((task) => FAILED_TASK_STATUSES.has(task.status))) return "failed";
  if (tasks.some((task) => task.status === "canceled")) return "cancelled";
  return "completed";
}

export function deriveGlobalRunStatus(memberships = [], options = {}) {
  if (!memberships.length) return null;
  const terminal = new Set(["completed", "failed", "cancelled"]);
  if (!memberships.every((membership) => terminal.has(membership.status))) return null;
  if (options.cancellationRequested) return "cancelled";
  if (memberships.some((membership) => membership.attentionRequired)) return "attention_required";
  const required = memberships.filter((membership) => membership.required !== false && membership.membership !== "optional");
  if (required.some((membership) => membership.status !== "completed")) return "failed";
  return "completed";
}
