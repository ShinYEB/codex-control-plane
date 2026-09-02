import assert from "node:assert/strict";
import test from "node:test";

import { ControlRegistry } from "../src/registry.js";
import { TurnDispatcher, promptFingerprint } from "../src/turn-dispatcher.js";

test("TurnDispatcher persists thread and Turn identity before terminal projection", async () => {
  const registry = new ControlRegistry({ path: ":memory:" });
  registry.createRun({ id: "run_dispatch", status: "running", cwd: "/repo" });
  registry.createTask({ id: "task_dispatch", status: "running", prompt: "work", metadata: { runId: "run_dispatch" } });
  registry.upsertAgent({ id: "thread_dispatch", cwd: "/repo", status: "idle" });
  const seen = [];
  const control = {
    runTask: async (threadId, prompt, options) => {
      options.onStarted({ threadId, turnId: "turn_dispatch" });
      seen.push(registry.listTurnDispatches({ parentTaskId: "task_dispatch" })[0]);
      return { threadId, turnId: "turn_dispatch", output: "done", turn: { id: "turn_dispatch", status: "completed" }, completionMethod: "turn/completed" };
    },
  };
  const dispatcher = new TurnDispatcher({ registry, instanceId: "daemon_a" });
  const result = await dispatcher.execute({
    subjectType: "task", subjectId: "task_dispatch", purpose: "execution",
    parentTaskId: "task_dispatch", parentRunId: "run_dispatch", prompt: "work", control,
    acquireThread: async () => ({ id: "thread_dispatch" }),
  });
  assert.equal(result.output, "done");
  assert.equal(seen[0].status, "turn_running");
  assert.equal(seen[0].threadId, "thread_dispatch");
  assert.equal(seen[0].turnId, "turn_dispatch");
  assert.equal(registry.listTurnDispatches({ parentTaskId: "task_dispatch" })[0].status, "completed");
  assert.equal(registry.getAgent("thread_dispatch").status, "idle");
  registry.close();
});

test("cancellation generation fences a late thread acquisition before turn/start", async () => {
  const registry = new ControlRegistry({ path: ":memory:" });
  registry.createRun({ id: "run_cancel_dispatch", status: "planning", cwd: "/repo" });
  registry.createPlan({ id: "plan_cancel_dispatch", status: "planning", objective: "plan", cwd: "/repo" });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let runCalls = 0;
  const control = { runTask: async () => { runCalls += 1; } };
  const dispatcher = new TurnDispatcher({ registry, instanceId: "daemon_a" });
  const flight = dispatcher.execute({
    subjectType: "plan", subjectId: "plan_cancel_dispatch", purpose: "planning", planId: "plan_cancel_dispatch",
    parentRunId: "run_cancel_dispatch", prompt: "make a plan", control,
    acquireThread: async () => { await gate; return { id: "late_thread" }; },
  });
  await new Promise((resolve) => setImmediate(resolve));
  registry.requestTurnDispatchCancellation({ parentRunId: "run_cancel_dispatch" });
  release();
  await assert.rejects(flight, (error) => error.code === "TURN_DISPATCH_FENCED");
  assert.equal(runCalls, 0);
  assert.equal(registry.listTurnDispatches({ parentRunId: "run_cancel_dispatch" })[0].status, "cancelled");
  registry.close();
});

test("restart reconciliation binds an already submitted Turn without resending the prompt", async () => {
  const registry = new ControlRegistry({ path: ":memory:" });
  registry.createRun({ id: "run_reconcile_dispatch", status: "running", cwd: "/repo" });
  registry.createTask({ id: "task_reconcile_dispatch", status: "running", prompt: "recover", metadata: { runId: "run_reconcile_dispatch" } });
  const created = registry.createTurnDispatch({
    subjectType: "task", subjectId: "task_reconcile_dispatch", purpose: "execution", revision: 1,
    parentRunId: "run_reconcile_dispatch", parentTaskId: "task_reconcile_dispatch",
    promptFingerprint: promptFingerprint("recover"), submissionKey: "submission_recover", threadId: "thread_recover",
    status: "turn_submitting", deadlineAt: new Date(Date.now() + 60_000).toISOString(),
  });
  const claimed = registry.claimTurnDispatch(created.id, "daemon_recovery", 120_000, { forceRecovery: true });
  const control = {
    inspectAgent: async () => ({ thread: { turns: [{
      id: "turn_recover", status: "completed",
      items: [
        { type: "userMessage", content: [{ type: "text", text: "recover" }] },
        { type: "agentMessage", text: "recovered output" },
      ],
    }] } }),
  };
  const dispatcher = new TurnDispatcher({ registry, instanceId: "daemon_recovery" });
  const reconciled = await dispatcher.reconcile(created.id, control, { ownerToken: claimed.ownerToken });
  assert.equal(reconciled.dispatch.status, "completed");
  assert.equal(reconciled.dispatch.turnId, "turn_recover");
  assert.equal(reconciled.result.output, "recovered output");
  registry.close();
});

test("a completed submission is returned durably instead of being sent twice", async () => {
  const registry = new ControlRegistry({ path: ":memory:" });
  registry.createRun({ id: "run_once", status: "running", cwd: "/repo" });
  registry.createTask({ id: "task_once", status: "running", prompt: "once", metadata: { runId: "run_once" } });
  let calls = 0;
  const control = { runTask: async () => { calls += 1; return { output: "once", turnId: "turn_once", turn: { id: "turn_once", status: "completed" } }; } };
  const dispatcher = new TurnDispatcher({ registry, instanceId: "daemon_once" });
  const options = { subjectType: "task", subjectId: "task_once", purpose: "execution", parentTaskId: "task_once", parentRunId: "run_once", prompt: "once", control, acquireThread: async () => ({ id: "thread_once" }) };
  assert.equal((await dispatcher.execute(options)).output, "once");
  assert.equal((await dispatcher.execute(options)).output, "once");
  assert.equal(calls, 1);
  registry.close();
});
