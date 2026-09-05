import assert from "node:assert/strict";
import test from "node:test";

import { agentDisplayName, roleIcon } from "../src/agent-names.js";
import { classifyTaskGraph } from "../src/dispatch-policy.js";

test("agent titles include one role icon inside brackets", () => {
  assert.equal(agentDisplayName("qa", "전체 테스트"), "🤖 전체 테스트");
  assert.equal(agentDisplayName("orchestrator", "결제 기능"), "🤖 결제 기능");
  assert.equal(roleIcon("unknown-role"), "🤖");
});

test("dispatch policy sends one independent task directly", () => {
  const estimate = classifyTaskGraph([{ key: "work", role: "implementer", dependsOn: [] }]);
  assert.equal(estimate.dispatchPath, "direct");
  assert.equal(estimate.level, "low");
});

test("dispatch policy routes a dependency graph through an orchestrator", () => {
  const estimate = classifyTaskGraph([
    { key: "build", role: "implementer", dependsOn: [], workspaceMode: "worktree" },
    { key: "review", role: "reviewer", dependsOn: ["build"] },
  ]);
  assert.equal(estimate.dispatchPath, "orchestrated");
  assert.ok(estimate.score >= 25);
  assert.match(estimate.reasons.join(" "), /선후 의존성/);
});
