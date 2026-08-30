import assert from "node:assert/strict";
import test from "node:test";

import { ContextManager } from "../src/context-manager.js";
import { PLAN_SCHEMA, PlannerEngine } from "../src/planner-engine.js";
import { ControlRegistry } from "../src/registry.js";
import { RoleTemplateManager } from "../src/role-templates.js";

test("planner owns a persistent plan and revision loop", async () => {
  const registry = new ControlRegistry({ path: ":memory:" });
  const roles = new RoleTemplateManager(registry);
  roles.seedBuiltins();
  let calls = 0;
  const control = {
    spawnAgent: async () => ({ id: "planner_thread", cwd: "/repo", provider: "codex" }),
    resumeAgent: async () => ({ id: "planner_thread", cwd: "/repo", provider: "codex" }),
    runTask: async () => {
      calls += 1;
      return { output: JSON.stringify({ summary: `v${calls}`, risks: [], tasks: [{ key: "review", title: "Review", prompt: "Review safely", role: "reviewer", capabilities: ["review"], tools: [], dependsOn: [], workspaceMode: "shared", acceptanceCriteria: ["report"] }] }) };
    },
  };
  const planner = new PlannerEngine({
    registry,
    contextManager: new ContextManager(registry),
    roleTemplates: roles,
    getControl: async () => control,
    decorateAgent: async () => {},
  });
  const initial = await planner.plan({ objective: "Review the repo", cwd: "/repo", requestKey: "objective-1" });
  assert.equal(initial.status, "planned");
  assert.equal(initial.plannerAgentId, "planner_thread");
  const revised = await planner.revise(initial.id, "Add explicit evidence");
  assert.equal(revised.version, 2);
  assert.equal(revised.plan.summary, "v2");
  assert.deepEqual(registry.listPlanRevisions(initial.id).map((revision) => revision.plan.summary), ["v1", "v2"]);
  assert.equal((await planner.plan({ objective: "duplicate", cwd: "/repo", requestKey: "objective-1" })).id, initial.id);
  registry.close();
});

test("planner resumes an interrupted planning record instead of returning a null graph", async () => {
  const registry = new ControlRegistry({ path: ":memory:" });
  const roles = new RoleTemplateManager(registry);
  roles.seedBuiltins();
  registry.createPlan({ id: "plan_interrupted", requestKey: "resume-key", objective: "Resume planning", cwd: "/repo" });
  let calls = 0;
  const control = {
    spawnAgent: async () => ({ id: "planner_resumed", cwd: "/repo", provider: "codex" }),
    runTask: async () => {
      calls += 1;
      return { output: JSON.stringify({ summary: "resumed", risks: [], tasks: [{ key: "work", title: "Work", prompt: "Do work", role: "implementer", capabilities: [], tools: [], dependsOn: [], workspaceMode: "shared", acceptanceCriteria: ["done"] }] }) };
    },
  };
  const planner = new PlannerEngine({
    registry,
    contextManager: new ContextManager(registry),
    roleTemplates: roles,
    getControl: async () => control,
    decorateAgent: async () => {},
  });
  const result = await planner.plan({ objective: "Resume planning", cwd: "/repo", requestKey: "resume-key" });
  assert.equal(result.id, "plan_interrupted");
  assert.equal(result.status, "planned");
  assert.equal(result.plan.tasks.length, 1);
  assert.equal(calls, 1);
  registry.close();
});

test("planner rejects a schema-shaped null graph before dispatch reads tasks", async () => {
  const registry = new ControlRegistry({ path: ":memory:" });
  const roles = new RoleTemplateManager(registry);
  roles.seedBuiltins();
  const planner = new PlannerEngine({
    registry,
    contextManager: new ContextManager(registry),
    roleTemplates: roles,
    getControl: async () => ({ spawnAgent: async () => ({ id: "planner_null", cwd: "/repo" }), runTask: async () => ({ output: "null" }) }),
    decorateAgent: async () => {},
  });
  await assert.rejects(() => planner.plan({ objective: "Invalid", cwd: "/repo", requestKey: "null-key" }), /invalid graph without tasks/);
  assert.equal(registry.listPlans({ limit: 10 }).find((plan) => plan.requestKey === "null-key").status, "failed");
  registry.close();
});

test("planner output schema marks every declared property as required", () => {
  assert.deepEqual(new Set(PLAN_SCHEMA.required), new Set(Object.keys(PLAN_SCHEMA.properties)));
  const task = PLAN_SCHEMA.properties.tasks.items;
  assert.deepEqual(new Set(task.required), new Set(Object.keys(task.properties)));
});
