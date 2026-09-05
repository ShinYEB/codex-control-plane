import assert from "node:assert/strict";
import test from "node:test";
import { ControlRegistry } from "../src/registry.js";
import { AgentRouter } from "../src/router.js";
import { TERMINAL_TASK_STATUSES } from "../src/domain-states.js";
import { evaluateTaskCompletion } from "../src/completion-evaluator.js";
import { assertOutputSchema } from "../src/output-schema.js";
import { TurnDispatcher } from "../src/turn-dispatcher.js";
import { finalTurnOutput } from "../src/turn-output.js";
import { McpControlServer } from "../src/mcp-server.js";

test("concurrent allocations cannot both spend the last worker slot", async () => {
  let release;
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  let spawns = 0;
  const control = {
    connect: async () => {}, listAgents: async () => ({ agents: [] }),
    spawnAgent: async () => { spawns++; entered(); await gate; return { id: "allocated", cwd: process.cwd(), status: "idle" }; },
    runTask: async (_id, _prompt, options) => { options.onStarted?.({ turnId: "t" }); return { output: "report", turnId: "t", turn: { status: "completed" } }; },
  };
  const server = new McpControlServer({ registry: new ControlRegistry({ path: ":memory:" }), recoverInterruptedTasks: false,
    controlFactory: () => ({ control, client: { close: async () => {} } }) });
  const request = (prompt) => server.handleRequest({ method: "tools/call", params: { name: "run_agent_task", arguments: {
    cwd: process.cwd(), prompt, role: "reviewer", capabilities: ["review"], taskKind: "analysis", mutatesWorkspace: false,
  } } });
  try {
    server.registry.upsertThreadBudget({ cwd: process.cwd(), policy: { maxProjectThreads: 1 } });
    const first = request("first");
    await started;
    const second = await request("second");
    assert.equal(second.structuredContent.waitingForLease, true);
    assert.equal(spawns, 1);
    release();
    assert.notEqual((await first).isError, true);
  } finally { release(); await server.close(); }
});

test("final output excludes progress commentary in hydrated and legacy turns", () => {
  const items = [{ type: "agentMessage", phase: "commentary", text: "I will read files." },
    { type: "agentMessage", phase: "final_answer", text: '{"outputs":{"report":"evidence"}}' }];
  assert.deepEqual(JSON.parse(finalTurnOutput({ items })).outputs, { report: "evidence" });
  assert.equal(finalTurnOutput({ items: items.map(({ phase, ...item }) => item) }), items[1].text);
});

test("every terminal dependency can release and claim an all-terminal consumer", () => {
  const registry = new ControlRegistry({ path: ":memory:" });
  try {
    for (const status of TERMINAL_TASK_STATUSES) {
      registry.createTask({ id: `p_${status}`, prompt: "upstream", status });
      registry.createTask({ id: `c_${status}`, prompt: "report", status: "blocked", dependsOn: [`p_${status}`], metadata: { dependencyPolicy: "all_terminal" } });
    }
    registry.refreshBlockedTasks();
    const runnable = new Set(registry.listRunnableTasks({ limit: 100 }).map(t => t.id));
    for (const status of TERMINAL_TASK_STATUSES) {
      assert.ok(runnable.has(`c_${status}`), status);
      assert.ok(registry.claimTask(`c_${status}`, "worker"), status);
    }
  } finally { registry.close(); }
});

test("imported personal threads do not consume managed worker capacity", () => {
  const registry = new ControlRegistry({ path: ":memory:" });
  try {
    for (let i = 0; i < 120; i++) registry.upsertAgent({ id: `personal_${i}`, cwd: process.cwd(), status: "idle" }, { metadata: { autoRegistered: true } });
    const before = registry.getThreadBudgetState({ cwd: process.cwd() });
    assert.equal(before.projectCount, 0);
    registry.upsertAgent({ id: "managed", cwd: process.cwd(), status: "idle" }, { metadata: { autoRegistered: true, executionPlane: "data" } });
    assert.equal(registry.getThreadBudgetState({ cwd: process.cwd() }).projectCount, 1);
  } finally { registry.close(); }
});

test("impossible routing is blocked; busy routing honors queueWhenBusy", () => {
  const router = new AgentRouter();
  const request = { role: "reviewer", capabilities: ["review"], reuseExisting: true,
    threadBudgetState: { canCreateProject: false, canCreateRole: false, canForkLineage: false } };
  assert.equal(router.select([], request).decision, "blocked");
  const agents = [{ id: "busy", role: "reviewer", capabilities: ["review"], status: "running" }];
  assert.equal(router.select(agents, request).decision, "wait");
  assert.equal(router.select(agents, { ...request, threadBudget: { policy: { queueWhenBusy: false } } }).decision, "blocked");
});

test("provider mismatch is never eligible, regardless of score", () => {
  const result = new AgentRouter().select([{ id: "other", role: "reviewer", provider: "other", status: "idle" }],
    { role: "reviewer", provider: "codex", reuseExisting: true, minimumScore: -100 });
  assert.notEqual(result.decision, "reuse");
  assert.equal(result.candidates[0].eligible, false);
});

test("review of tests needs no execution and false artifact claims cannot succeed", () => {
  const result = { turn: { status: "completed", items: [] }, evidenceComplete: true, output: "review" };
  assert.equal(evaluateTaskCompletion({ result, contract: { taskKind: "review", outputs: ["report"] },
    acceptanceCriteria: ["Review tests without running tests"], validation: { decision: "accept" } }).decision, "accept");
  for (const value of [false, true, 0, [], {}, " "]) {
    assert.equal(evaluateTaskCompletion({ result: { ...result, output: JSON.stringify({ outputs: { evidence: value } }) },
      contract: { taskKind: "review", outputs: ["evidence"] } }).decision, "reject");
  }
  assert.equal(evaluateTaskCompletion({ result: { ...result, output: '{"outputs":{"artifact":"exists"}}' },
    contract: { outputs: ["artifact"] } }).decision, "reject");
});

test("unattributed shared workspace changes require inspection without automatic rework", () => {
  const verdict = evaluateTaskCompletion({ result: { turn: { status: "completed" }, evidenceComplete: true, output: "report" },
    contract: { mutatesWorkspace: false, outputs: ["report"] }, workspaceEvidence: { changed: true, attribution: "shared_unattributed" } });
  assert.equal(verdict.decision, "attention");
  assert.equal(verdict.retryable, false);
});

test("transport schema validates types, references, and array bounds", () => {
  for (const child of [{ type: "wrong" }, { $ref: "#/missing" }, { type: "array" }, { type: "array", items: { type: "string" }, minItems: 4, maxItems: 1 }]) {
    assert.throws(() => assertOutputSchema({ type: "object", properties: { x: child }, required: ["x"], additionalProperties: false }), /Invalid output schema/);
  }
});

test("lease waits expire durably and cannot retain a claim token", () => {
  const registry = new ControlRegistry({ path: ":memory:" });
  try {
    registry.createTask({ id: "waiting", prompt: "work", status: "queued", metadata: { waitingSince: "2000-01-01T00:00:00Z" } });
    const claim = registry.claimTask("waiting", "worker");
    const terminal = registry.waitClaimForLease("waiting", "worker", claim.claimToken);
    assert.equal(terminal.status, "recovery_attention");
    assert.equal(terminal.metadata.failure.retryable, false);
    registry.createTask({ id: "short", prompt: "work", status: "queued" });
    const short = registry.claimTask("short", "worker");
    assert.equal(registry.waitClaimForLease("short", "worker", short.claimToken).claimToken, null);
  } finally { registry.close(); }
});

test("expired recovered dispatch is interrupted and parked for inspection", async () => {
  const registry = new ControlRegistry({ path: ":memory:" });
  try {
    const dispatch = registry.createTurnDispatch({ subjectType: "plan", subjectId: "plan", purpose: "planning",
      promptFingerprint: "p", submissionKey: "s", threadId: "thread", turnId: "turn", status: "turn_running", deadlineAt: "2000-01-01T00:00:00Z" });
    let interrupted = 0;
    const result = await new TurnDispatcher({ registry }).reconcile(dispatch.id, {
      inspectAgent: async () => ({ turns: [{ id: "turn", status: "running" }] }),
      interruptTask: async () => { interrupted++; },
    });
    assert.equal(interrupted, 1);
    assert.equal(result.dispatch.status, "recovery_attention");
  } finally { registry.close(); }
});
