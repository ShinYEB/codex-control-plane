import assert from "node:assert/strict";
import test from "node:test";

import { assessTaskResult, classifyFailure } from "../src/failure-classifier.js";

test("failure classification separates infrastructure, coordination, validation, and worker errors", () => {
  assert.deepEqual(classifyFailure(Object.assign(new Error("app-server exited"), { code: "ECONNRESET" })).type, "infrastructure");
  assert.equal(classifyFailure(new Error("thread already has an active writer")).type, "coordination");
  assert.equal(classifyFailure(new Error("criteria missed"), "validation").type, "validation");
  assert.equal(classifyFailure(new Error("implementation crashed")).type, "worker");
});

test("Codex response 404 and exhausted reconnects are stable retryable environment failures", () => {
  const notFound = classifyFailure(new Error("unexpected status 404 Not Found: Unknown error, url: https://chatgpt.com/backend-api/codex/responses"), "orchestrator_kickoff");
  assert.equal(notFound.code, "APP_SERVER_UPSTREAM_404");
  assert.equal(notFound.type, "infrastructure");
  assert.equal(notFound.category, "environment");
  assert.equal(notFound.retryable, true);

  const reconnect = classifyFailure(new Error("Reconnecting... 2/5"), "validation");
  assert.equal(reconnect.code, "APP_SERVER_RECONNECT_INTERRUPTED");
  assert.equal(reconnect.type, "infrastructure");
  assert.equal(reconnect.category, "environment");
  assert.equal(reconnect.retryable, true);
});

test("result assessment rejects completed turns with real command or test failures", () => {
  const commandFailure = assessTaskResult({
    turn: { status: "completed" },
    output: "done",
    executionItems: [{ id: "cmd_1", type: "commandExecution", command: "node --test", status: "completed", exitCode: 7 }],
  });
  assert.equal(commandFailure.type, "test");
  assert.equal(commandFailure.exitCode, 7);
  assert.equal(commandFailure.retryable, true);

  const explicitFailure = assessTaskResult({ turn: { status: "completed" }, output: '{"status":"failed","reason":"lint failed"}' });
  assert.equal(explicitFailure.type, "worker");
  assert.equal(assessTaskResult({ turn: { status: "completed" }, output: "tests: 12 passed" }), null);
});

test("sandbox EPERM in test output is classified as environment instead of product", () => {
  const failure = assessTaskResult({
    turn: { status: "completed" },
    executionItems: [{
      id: "cmd_eperm",
      type: "commandExecution",
      command: "node --test",
      status: "failed",
      exitCode: 1,
      aggregatedOutput: "Error: EPERM: operation not permitted, mkdtemp '/tmp/control-plane-test-'",
    }],
  });
  assert.equal(failure.type, "environment");
  assert.equal(failure.category, "environment");
  assert.equal(failure.retryable, false);
  assert.equal(failure.nextAction, "manual_intervention");
});

test("successful test execution is not overturned by identifiers in narrative output", () => {
  const result = assessTaskResult({
    turn: { status: "completed" },
    output: "42/42 tests passed with exit 0. failed_static_inspection remains a result field name.",
    executionItems: [{ id: "cmd_ok", type: "commandExecution", command: "node --test", status: "completed", exitCode: 0 }],
  });
  assert.equal(result, null);
});

test("standalone machine-shaped failed test summaries remain failures", () => {
  const result = assessTaskResult({ turn: { status: "completed" }, output: "42 tests failed\n" });
  assert.equal(result.type, "test");
  assert.match(result.message, /42 tests failed/);
});
