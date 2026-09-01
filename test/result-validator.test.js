import assert from "node:assert/strict";
import test from "node:test";

import { ResultValidator, parseValidationOutput } from "../src/result-validator.js";

const valid = {
  decision: "accept",
  failureKind: "none",
  summary: "verified",
  evidence: ["tests passed"],
  unmetCriteria: [],
};

test("validator parser accepts fenced and explanatory structured output", () => {
  assert.deepEqual(parseValidationOutput(`Result follows:\n\`\`\`json\n${JSON.stringify(valid)}\n\`\`\``), valid);
});

test("validator parser selects the last schema-shaped object from concatenated JSON", () => {
  const output = `${JSON.stringify({ note: "draft" })}\n${JSON.stringify(valid)}`;
  assert.deepEqual(parseValidationOutput(output), valid);
});

test("validator parser rejects text without a schema-shaped object", () => {
  assert.throws(() => parseValidationOutput("not json"), /invalid structured output/);
});

test("validator receives the parent Run authorization and never asks for another Start", async () => {
  let prompt;
  const settings = new Map();
  const registry = {
    getSetting: (key) => settings.get(key),
    setSetting: (key, value) => settings.set(key, value),
    upsertAgent: () => {},
    updateTask: () => {},
    recordEvent: () => {},
  };
  const control = {
    spawnAgent: async () => ({ id: "validator_1", cwd: "/repo", status: "idle" }),
    runTask: async (_id, value, options) => {
      prompt = value;
      options.onStarted?.({ turnId: "validator_turn" });
      return { output: JSON.stringify(valid), turnId: "validator_turn" };
    },
  };
  const validator = new ResultValidator({
    registry,
    roleTemplates: { resolve: () => ({ model: null }) },
    getControl: async () => control,
    decorateAgent: async () => {},
  });
  const result = await validator.validate({ taskId: "task_1", cwd: "/repo", prompt: "verify", output: "done", acceptanceCriteria: ["verified"] });
  assert.equal(result.decision, "accept");
  assert.match(prompt, /\[RUN AUTHORIZATION\]/);
  assert.match(prompt, /Do not request another Start confirmation/);
});

test("validator serializes concurrent validations that reuse one workspace agent", async () => {
  const settings = new Map();
  let active = 0;
  let maximumActive = 0;
  let releaseFirst;
  let calls = 0;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const registry = {
    getSetting: (key) => settings.get(key),
    setSetting: (key, value) => settings.set(key, value),
    upsertAgent: () => {}, updateTask: () => {}, recordEvent: () => {},
  };
  const control = {
    spawnAgent: async () => ({ id: "validator_shared", cwd: "/repo", status: "idle" }),
    resumeAgent: async (id) => ({ id, cwd: "/repo", status: "idle" }),
    runTask: async () => {
      calls += 1;
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      if (calls === 1) await firstGate;
      active -= 1;
      return { output: JSON.stringify(valid), turnId: `validator_turn_${calls}` };
    },
  };
  const validator = new ResultValidator({
    registry,
    roleTemplates: { resolve: () => ({ model: null }) },
    getControl: async () => control,
    decorateAgent: async () => {},
  });
  const first = validator.validate({ taskId: "task_1", cwd: "/repo", prompt: "one", output: "done", acceptanceCriteria: ["verified"] });
  const second = validator.validate({ taskId: "task_2", cwd: "/repo", prompt: "two", output: "done", acceptanceCriteria: ["verified"] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  releaseFirst();
  await Promise.all([first, second]);
  assert.equal(calls, 2);
  assert.equal(maximumActive, 1);
});
