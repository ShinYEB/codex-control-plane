import assert from "node:assert/strict";
import test from "node:test";

import { ContextManager } from "../src/context-manager.js";
import { assertSingleRunStart, PLAN_SCHEMA, PlannerEngine } from "../src/planner-engine.js";
import { ControlRegistry } from "../src/registry.js";
import { RoleTemplateManager } from "../src/role-templates.js";

function activateContextClaim(registry, id, body) {
  registry.createContextClaim({ id, kind: "constraint", subject: "execution-contract", body, scope: "global", authority: "user_explicit", status: "candidate" });
  registry.addContextClaimSource(id, { kind: "user_turn", id: `source_${id}` });
  registry.activateContextClaim(id);
}

test("planner blocks conflicting context before creating or resuming an Agent", async () => {
  const registry = new ControlRegistry({ path: ":memory:" });
  const roles = new RoleTemplateManager(registry);
  roles.seedBuiltins();
  activateContextClaim(registry, "contract_a", "Use contract A");
  activateContextClaim(registry, "contract_b", "Use contract B");
  let controlCalls = 0;
  const planner = new PlannerEngine({
    registry,
    contextManager: new ContextManager(registry),
    roleTemplates: roles,
    getControl: async () => { controlCalls += 1; return {}; },
    decorateAgent: async () => {},
  });
  await assert.rejects(
    () => planner.plan({ objective: "Implement", cwd: "/repo", requestKey: "context-conflict", requiredContextSubjects: ["execution-contract"] }),
    (error) => error.code === "CONTEXT_SNAPSHOT_INVALID",
  );
  assert.equal(controlCalls, 0);
  assert.equal(registry.listAgents().length, 0);
  assert.equal(registry.listPlans({ status: "failed" }).length, 1);
  registry.close();
});

test("planner indexes explicitly requested thread history before spawning its Agent", async () => {
  const registry = new ControlRegistry({ path: ":memory:" });
  const roles = new RoleTemplateManager(registry);
  roles.seedBuiltins();
  const calls = [];
  const control = {
    inspectAgent: async (threadId) => { calls.push(`read:${threadId}`); return { thread: { turns: [{ id: "turn_old", prompt: "Billing architecture", output: "Use billing API" }] } }; },
    spawnAgent: async () => { calls.push("spawn"); return { id: "planner_indexed", cwd: "/repo" }; },
    runTask: async () => ({ output: JSON.stringify({ summary: "indexed", risks: [], tasks: [{ key: "review", title: "Review", prompt: "Review", role: "reviewer", capabilities: [], tools: [], dependsOn: [], workspaceMode: "shared", acceptanceCriteria: [] }] }) }),
  };
  const planner = new PlannerEngine({ registry, contextManager: new ContextManager(registry), roleTemplates: roles, getControl: async () => control, decorateAgent: async () => {} });
  const plan = await planner.plan({ objective: "Review billing", cwd: "/repo", requestedThreadIds: ["thread_old"] });
  assert.deepEqual(calls.slice(0, 2), ["read:thread_old", "spawn"]);
  const snapshot = registry.getContextSnapshot(plan.metadata.contextSnapshotId);
  assert.equal(snapshot.metadata.requestedScope.requestedThreads[0].threadId, "thread_old");
  assert.ok(snapshot.metadata.requestedScope.requestedThreads[0].sourceDigest);
  assert.ok(snapshot.metadata.requestedScope.requestedThreads[0].topics.includes("billing"));
  registry.close();
});

test("an unreadable requested thread fails planning before Agent creation", async () => {
  const registry = new ControlRegistry({ path: ":memory:" });
  const roles = new RoleTemplateManager(registry);
  roles.seedBuiltins();
  let spawnCalls = 0;
  const control = {
    inspectAgent: async () => { throw new Error("thread unavailable"); },
    spawnAgent: async () => { spawnCalls += 1; return { id: "must_not_spawn" }; },
  };
  const planner = new PlannerEngine({ registry, contextManager: new ContextManager(registry), roleTemplates: roles, getControl: async () => control, decorateAgent: async () => {} });
  await assert.rejects(
    () => planner.plan({ objective: "Use old context", cwd: "/repo", requestedThreadIds: ["missing_thread"] }),
    (error) => error.code === "THREAD_KNOWLEDGE_READ_FAILED" && Boolean(error.nextAction),
  );
  assert.equal(spawnCalls, 0);
  assert.equal(registry.listAgents().length, 0);
  assert.equal(registry.listPlans({ status: "failed" }).length, 1);
  registry.close();
});

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

test("planner automatically retries a graph that asks for another Start", async () => {
  const registry = new ControlRegistry({ path: ":memory:" });
  const roles = new RoleTemplateManager(registry);
  roles.seedBuiltins();
  const prompts = [];
  const outputs = [
    { summary: "invalid", risks: [], tasks: [{ key: "qa", title: "QA", prompt: "Wait for a separate Start before testing.", role: "e2e tester", capabilities: [], tools: ["node"], dependsOn: [], workspaceMode: "shared", authorizationScope: "parent_run", acceptanceCriteria: ["A second Start is required"] }] },
    { summary: "corrected", risks: [], tasks: [{ key: "qa", title: "QA", prompt: "The parent Run is already authorized; run tests immediately without another Start.", role: "e2e tester", capabilities: [], tools: ["node"], dependsOn: [], workspaceMode: "shared", authorizationScope: "parent_run", acceptanceCriteria: ["No additional Start is required"] }] },
  ];
  const planner = new PlannerEngine({
    registry,
    contextManager: new ContextManager(registry),
    roleTemplates: roles,
    getControl: async () => ({
      spawnAgent: async () => ({ id: "planner_contract", cwd: "/repo" }),
      runTask: async (_id, prompt) => {
        prompts.push(prompt);
        return { output: JSON.stringify(outputs[prompts.length - 1]) };
      },
    }),
    decorateAgent: async () => {},
  });

  const result = await planner.plan({ objective: "Run QA", cwd: "/repo", requestKey: "single-start" });
  assert.equal(result.plan.summary, "corrected");
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /violated the Run authorization contract/);
  assert.match(prompts[0], /applies exactly once to the parent Run/);
  registry.close();
});

test("single-Run Start lint accepts explicit Korean prohibitions from planner tasks", () => {
  const task = {
    key: "T05",
    authorizationScope: "parent_run",
    prompt: "부모 Run 권한을 상속하며 추가 Start·승인·Run/task 생성·retry/rework를 호출하지 않고 전용 worktree에서 커밋한다.",
    acceptanceCriteria: ["추가 Start를 요청하지 않는다.", "별도 승인 없이 즉시 실행한다."],
  };
  assert.doesNotThrow(() => assertSingleRunStart({ tasks: [task] }));
});

test("single-Run Start lint still rejects explicit Korean additional Start gates", () => {
  const task = {
    key: "T05",
    authorizationScope: "parent_run",
    prompt: "테스트 전에 별도 Start 승인을 받아야 한다.",
    acceptanceCriteria: [],
  };
  assert.throws(() => assertSingleRunStart({ tasks: [task] }), (error) => error.code === "PLAN_ADDITIONAL_START");
});

test("planner compiles execution contracts before persisting the graph and retries invalid policy", async () => {
  const registry = new ControlRegistry({ path: ":memory:" });
  const roles = new RoleTemplateManager(registry);
  roles.seedBuiltins();
  const prompts = [];
  const task = (sideEffectPolicy) => ({
    key: "daemon-health", title: "Daemon health", prompt: "Observe local daemon health", role: "reviewer",
    capabilities: [], tools: [], dependsOn: [], dependencyPolicy: "all_success", workspaceMode: "shared",
    acceptanceCriteria: ["health is reported"], taskKind: "test", mutatesWorkspace: false,
    networkAccess: false, sideEffectPolicy, authorizationScope: "parent_run", outputs: ["report"], integrationStrategy: "none",
  });
  const outputs = [
    { summary: "misclassified", risks: [], tasks: [task("external")] },
    { summary: "corrected", risks: [], tasks: [task("none")] },
  ];
  const planner = new PlannerEngine({
    registry,
    contextManager: new ContextManager(registry),
    roleTemplates: roles,
    getControl: async () => ({
      spawnAgent: async () => ({ id: "planner_preflight", cwd: "/repo" }),
      runTask: async (_id, prompt) => {
        prompts.push(prompt);
        return { output: JSON.stringify(outputs[prompts.length - 1]) };
      },
    }),
    decorateAgent: async () => {},
  });

  const result = await planner.plan({ objective: "Read daemon health", cwd: "/repo", requestKey: "planner-preflight" });
  assert.equal(result.plan.summary, "corrected");
  assert.equal(result.plan.tasks[0].sideEffectPolicy, "none");
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /violated the Run authorization contract/);
  assert.match(prompts[0], /local-runtime means lifecycle changes limited to this product's local daemon/);
  registry.close();
});
