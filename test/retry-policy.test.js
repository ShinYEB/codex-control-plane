import assert from "node:assert/strict";
import test from "node:test";

import { assertNewContractRevision, decideTaskRetry } from "../src/retry-policy.js";

test("only transient failures may automatically retry the same contract", () => {
  assert.equal(decideTaskRetry({ failure: { type: "infrastructure", retryable: true }, remaining: 1 }).retry, true);
  const configuration = decideTaskRetry({ failure: { type: "configuration", retryable: true, nextAction: "retry" }, remaining: 3 });
  assert.equal(configuration.retry, false);
  assert.equal(configuration.safeReason, "contract_or_policy_failure_requires_revision");
});

test("validator rework records a distinct feedback revision decision", () => {
  const decision = decideTaskRetry({ failure: { type: "product", retryable: true, nextAction: "rework" }, remaining: 1, feedback: { summary: "fix" } });
  assert.deepEqual({ retry: decision.retry, mode: decision.mode, reason: decision.safeReason }, { retry: true, mode: "validator_rework", reason: "validator_feedback_revision" });
});

test("contract repair cannot reuse the previous fingerprint", () => {
  assert.throws(() => assertNewContractRevision({ fingerprint: "same" }, { fingerprint: "same" }), { code: "CONTRACT_REVISION_UNCHANGED" });
  assert.equal(assertNewContractRevision({ fingerprint: "old" }, { fingerprint: "new" }).fingerprint, "new");
});
