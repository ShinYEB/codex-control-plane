import assert from "node:assert/strict";
import test from "node:test";
import { assertOutputSchema } from "../src/output-schema.js";
import { PLAN_SCHEMA, SYNTHESIS_SCHEMA } from "../src/planner-engine.js";
import { VALIDATION_SCHEMA } from "../src/result-validator.js";
import { TurnDispatcher } from "../src/turn-dispatcher.js";
import { classifyFailure } from "../src/failure-classifier.js";
import { compileAndValidateExecutionContract } from "../src/execution-contracts.js";

test("all product output schemas satisfy the transport profile", () => {
  for (const schema of [PLAN_SCHEMA, SYNTHESIS_SCHEMA, VALIDATION_SCHEMA]) assert.doesNotThrow(() => assertOutputSchema(schema));
});

test("unsupported nested keyword fails before registry, lease, or thread acquisition", async () => {
  const schema = structuredClone(PLAN_SCHEMA);
  schema.properties.tasks.items.properties.executionCapabilities.uniqueItems = true;
  const dispatcher = new TurnDispatcher({ registry: new Proxy({}, { get() { assert.fail("registry must not be accessed"); } }) });
  await assert.rejects(dispatcher.execute({
    prompt: "plan", runOptions: { outputSchema: schema },
    acquireThread: async () => assert.fail("thread must not be created"),
  }), (error) => error.code === "OUTPUT_SCHEMA_INVALID" && /executionCapabilities.*uniqueItems/.test(error.message));
});

test("schema property names are not confused with schema keywords", () => {
  assert.doesNotThrow(() => assertOutputSchema({ type: "object", additionalProperties: false,
    required: ["uniqueItems"], properties: { uniqueItems: { type: "string" } } }));
  const schema = structuredClone(PLAN_SCHEMA);
  schema.properties.tasks.items.required = [];
  assert.throws(() => assertOutputSchema(schema), /all properties must be required/);
});

test("local and upstream invalid schema failures require repair, never retry", () => {
  for (const error of [
    Object.assign(new Error("unsupported keyword"), { code: "OUTPUT_SCHEMA_INVALID", retryable: true }),
    new Error(JSON.stringify({ error: { code: "invalid_json_schema", message: "uniqueItems is not permitted" }, status: 400 })),
  ]) {
    const failure = classifyFailure(error, "control_dispatch");
    assert.equal(failure.code, "OUTPUT_SCHEMA_INVALID");
    assert.equal(failure.category, "configuration");
    assert.equal(failure.retryable, false);
    assert.equal(failure.nextAction, "repair_contract");
  }
});

test("removing transport uniqueness does not weaken domain validation", () => {
  assert.throws(() => compileAndValidateExecutionContract({
    taskKind: "analysis", mutatesWorkspace: false,
    executionCapabilities: ["process-execution", "process-execution"],
  }), /must not contain duplicates/);
});
