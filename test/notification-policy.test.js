import assert from "node:assert/strict";
import test from "node:test";

import { classifyRunNotification, NOTIFICATION_KINDS, normalizeNotificationKind, notificationPresentation } from "../src/notification-policy.js";

test("notification policy exposes exactly four canonical user-facing kinds", () => {
  assert.deepEqual(Object.values(NOTIFICATION_KINDS), ["completed", "failed", "attention_required", "policy_blocked"]);
  assert.equal(normalizeNotificationKind("run_completed"), NOTIFICATION_KINDS.COMPLETED);
  assert.equal(normalizeNotificationKind("approval_required"), NOTIFICATION_KINDS.ATTENTION_REQUIRED);
  assert.equal(notificationPresentation(NOTIFICATION_KINDS.POLICY_BLOCKED).label, "정책 중단");
  assert.throws(() => normalizeNotificationKind("progress_update"), /Unsupported notification kind/);
});

test("terminal runs classify failures separately from policy stops", () => {
  assert.equal(classifyRunNotification({ status: "completed" }, []), NOTIFICATION_KINDS.COMPLETED);
  assert.equal(classifyRunNotification({ status: "failed" }, [{ status: "failed" }]), NOTIFICATION_KINDS.FAILED);
  assert.equal(classifyRunNotification({ status: "failed" }, [{ status: "blocked_by_policy" }]), NOTIFICATION_KINDS.POLICY_BLOCKED);
  assert.equal(classifyRunNotification({ status: "failed" }, [{ status: "integration_blocked" }]), NOTIFICATION_KINDS.ATTENTION_REQUIRED);
  assert.equal(classifyRunNotification({ status: "running" }, []), null);
});
