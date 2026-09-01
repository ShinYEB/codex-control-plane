export const NOTIFICATION_KINDS = Object.freeze({
  COMPLETED: "completed",
  FAILED: "failed",
  ATTENTION_REQUIRED: "attention_required",
  POLICY_BLOCKED: "policy_blocked",
});

const CANONICAL_KINDS = new Set(Object.values(NOTIFICATION_KINDS));
const LEGACY_KIND_ALIASES = new Map([
  ["run_completed", NOTIFICATION_KINDS.COMPLETED],
  ["run_failed", NOTIFICATION_KINDS.FAILED],
  ["approval_required", NOTIFICATION_KINDS.ATTENTION_REQUIRED],
  ["recovery_attention", NOTIFICATION_KINDS.ATTENTION_REQUIRED],
]);

export function normalizeNotificationKind(kind) {
  const normalized = LEGACY_KIND_ALIASES.get(kind) ?? kind;
  if (!CANONICAL_KINDS.has(normalized)) throw new TypeError(`Unsupported notification kind: ${kind}`);
  return normalized;
}

export function classifyRunNotification(run, tasks = []) {
  if (run?.status === "completed") return NOTIFICATION_KINDS.COMPLETED;
  if (run?.status !== "failed") return null;
  if (tasks.some((task) => task.status === "blocked_by_policy"
    || task.metadata?.failure?.type === "policy"
    || task.metadata?.failure?.category === "policy")) return NOTIFICATION_KINDS.POLICY_BLOCKED;
  if (tasks.some((task) => task.status === "integration_blocked"
    || task.status === "recovery_attention"
    || ["manual_intervention", "repair_contract"].includes(task.metadata?.failure?.nextAction))) return NOTIFICATION_KINDS.ATTENTION_REQUIRED;
  return NOTIFICATION_KINDS.FAILED;
}

export function notificationPresentation(kind) {
  const normalized = normalizeNotificationKind(kind);
  return {
    [NOTIFICATION_KINDS.COMPLETED]: { label: "완료", severity: "success" },
    [NOTIFICATION_KINDS.FAILED]: { label: "실패", severity: "error" },
    [NOTIFICATION_KINDS.ATTENTION_REQUIRED]: { label: "판단 필요", severity: "warning" },
    [NOTIFICATION_KINDS.POLICY_BLOCKED]: { label: "정책 중단", severity: "warning" },
  }[normalized];
}
