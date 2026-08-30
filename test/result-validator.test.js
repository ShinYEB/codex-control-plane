import assert from "node:assert/strict";
import test from "node:test";

import { parseValidationOutput } from "../src/result-validator.js";

const valid = {
  decision: "accept",
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
