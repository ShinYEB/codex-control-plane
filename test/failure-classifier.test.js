import assert from "node:assert/strict";
import test from "node:test";

import { assessTaskResult, classifyFailure } from "../src/failure-classifier.js";

test("failure classification separates infrastructure, coordination, validation, and worker errors", () => {
  assert.deepEqual(classifyFailure(Object.assign(new Error("app-server exited"), { code: "ECONNRESET" })).type, "infrastructure");
  assert.equal(classifyFailure(new Error("thread already has an active writer")).type, "coordination");
  assert.equal(classifyFailure(new Error("criteria missed"), "validation").type, "validation");
  assert.equal(classifyFailure(new Error("implementation crashed")).type, "worker");
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
