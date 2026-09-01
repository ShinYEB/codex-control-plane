const TRANSIENT_FAILURE_TYPES = new Set(["infrastructure", "coordination", "timeout"]);
const CONTRACT_FAILURE_TYPES = new Set(["configuration", "policy"]);

export function decideTaskRetry({ failure = {}, remaining = 0, feedback = null, duplicateFeedback = false } = {}) {
  const type = failure.type ?? failure.category ?? "worker";
  const requestedAction = failure.nextAction ?? (TRANSIENT_FAILURE_TYPES.has(type) ? "retry" : "manual_intervention");
  if (CONTRACT_FAILURE_TYPES.has(type) || failure.category === "configuration" || failure.category === "policy") {
    return { retry: false, requestedAction, safeReason: "contract_or_policy_failure_requires_revision", mode: "none" };
  }
  if (!failure.retryable) return { retry: false, requestedAction, safeReason: "failure_marked_non_retryable", mode: "none" };
  if (remaining <= 0) return { retry: false, requestedAction, safeReason: "attempt_budget_exhausted", mode: "none" };
  if (TRANSIENT_FAILURE_TYPES.has(type)) {
    return { retry: true, requestedAction: "retry", safeReason: "transient_failure_same_contract", mode: "transient" };
  }
  if (requestedAction === "rework" && feedback) {
    if (duplicateFeedback) return { retry: false, requestedAction, safeReason: "duplicate_validator_feedback", mode: "none" };
    return { retry: true, requestedAction, safeReason: "validator_feedback_revision", mode: "validator_rework" };
  }
  return { retry: false, requestedAction, safeReason: "failure_class_not_automatically_retryable", mode: "none" };
}

export function assertNewContractRevision(previous, next) {
  if (!previous?.fingerprint || !next?.fingerprint) throw Object.assign(new Error("Contract repair requires both previous and next fingerprints"), { code: "CONTRACT_REVISION_FINGERPRINT_REQUIRED" });
  if (previous.fingerprint === next.fingerprint) throw Object.assign(new Error("Contract repair must produce a new configuration fingerprint"), { code: "CONTRACT_REVISION_UNCHANGED" });
  return next;
}
