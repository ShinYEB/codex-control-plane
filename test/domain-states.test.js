import assert from "node:assert/strict";
import test from "node:test";

import {
  AGENT_STATUSES,
  GLOBAL_RUN_STATUSES,
  DELIVERY_STATUSES,
  LEASE_STATUSES,
  RUN_STATUSES,
  TASK_STATUSES,
  deriveRunStatus,
  deriveGlobalRunStatus,
  statusSemantics,
  TERMINAL_TASK_STATUSES,
  transitionAgent,
  transitionDelivery,
  transitionLease,
  transitionRun,
  transitionGlobalRun,
  transitionTask,
} from "../src/domain-states.js";

test("domain state transitions reject illegal rewinds and allow explicit repair", () => {
  assert.equal(transitionTask("queued", "running"), "running");
  assert.throws(() => transitionTask("completed", "queued"), /Illegal Task transition/);
  assert.equal(transitionTask("failed", "blocked", { allowRepair: true }), "blocked");
  assert.throws(() => transitionRun("completed", "running"), /Illegal Run transition/);
  assert.equal(transitionRun("completed", "running", { allowRepair: true }), "running");
  assert.equal(transitionAgent("idle", "leased"), "leased");
  assert.throws(() => transitionAgent("idle", "validating"), /Illegal Agent transition/);
  assert.equal(transitionLease("active", "released"), "released");
  assert.throws(() => transitionLease("released", "expired"), /Illegal Lease transition/);
  assert.equal(transitionDelivery("pending", "delivering"), "delivering");
  assert.equal(transitionDelivery("delivering", "direct_delivered"), "direct_delivered");
  assert.throws(() => transitionDelivery("delivered", "retry_waiting"), /Illegal Delivery transition/);
});

test("Global Run transitions and required/optional aggregation are centralized", () => {
  assert.equal(transitionGlobalRun("accepted", "resolving_context"), "resolving_context");
  assert.throws(() => transitionGlobalRun("completed", "running"), /Illegal GlobalRun transition/);
  assert.equal(deriveGlobalRunStatus([{ required: true, status: "completed" }, { required: false, status: "failed" }]), "completed");
  assert.equal(deriveGlobalRunStatus([{ required: true, status: "failed" }, { required: false, status: "completed" }]), "failed");
  assert.equal(deriveGlobalRunStatus([{ required: true, status: "cancelled" }]), "failed");
  assert.equal(deriveGlobalRunStatus([{ required: true, status: "completed" }], { cancellationRequested: true }), "cancelled");
  assert.equal(deriveGlobalRunStatus([{ required: true, status: "failed", attentionRequired: true }]), "attention_required");
});

test("recovery attention is terminal and mixed cancellation never reports success", () => {
  assert.equal(TERMINAL_TASK_STATUSES.has("recovery_attention"), true);
  assert.equal(deriveRunStatus([{ status: "completed" }, { status: "canceled" }]), "cancelled");
  assert.equal(deriveRunStatus([{ status: "completed" }, { status: "recovery_attention" }]), "failed");
});

test("every centralized state declares terminal, retry, recovery, and attention semantics", () => {
  for (const [entity, statuses] of Object.entries({
    run: RUN_STATUSES,
    global_run: GLOBAL_RUN_STATUSES,
    task: TASK_STATUSES,
    agent: AGENT_STATUSES,
    lease: LEASE_STATUSES,
    delivery: DELIVERY_STATUSES,
  })) {
    for (const status of statuses) {
      const semantics = statusSemantics(entity, status);
      assert.equal(typeof semantics.terminal, "boolean", `${entity}.${status}.terminal`);
      assert.equal(typeof semantics.retry, "string", `${entity}.${status}.retry`);
      assert.equal(typeof semantics.recovery, "string", `${entity}.${status}.recovery`);
      assert.equal(typeof semantics.attention, "boolean", `${entity}.${status}.attention`);
    }
  }
});
