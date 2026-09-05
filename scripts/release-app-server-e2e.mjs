#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CodexAppServerClient } from "../src/app-server-client.js";
import { CodexControlPlane } from "../src/control-plane.js";
import { McpControlServer } from "../src/mcp-server.js";
import { ControlRegistry } from "../src/registry.js";

const codexPath = process.env.CODEX_BIN ?? "/Applications/ChatGPT.app/Contents/Resources/codex";
const root = mkdtempSync(join(tmpdir(), "ruvora-app-server-e2e-"));
const registryPath = join(root, "registry.sqlite");
const scheduled = process.argv.includes("--scheduled");
let server;
let passed = false;

function git(...args) {
  return execFileSync("/usr/bin/git", args, { cwd: root, encoding: "utf8" }).trim();
}

try {
  writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module", scripts: { test: "node --test" } }, null, 2) + "\n");
  writeFileSync(join(root, "math.js"), "export function add(left, right) {\n  return left - right;\n}\n");
  writeFileSync(join(root, "math.test.js"), [
    'import assert from "node:assert/strict";',
    'import test from "node:test";',
    'import { add } from "./math.js";',
    '',
    'test("add returns the sum", () => {',
    '  assert.equal(add(2, 3), 5);',
    '});',
    '',
  ].join("\n"));
  git("init", "-b", "main");
  git("config", "user.email", "release-e2e@ruvora.local");
  git("config", "user.name", "Ruvora Release E2E");
  git("add", ".");
  git("commit", "-m", "fixture: failing addition");
  assert.throws(() => execFileSync(process.execPath, ["--test"], { cwd: root, stdio: "pipe" }));

  server = new McpControlServer({
    registryPath,
    sessionWriter: true,
    schedulerIntervalMs: scheduled ? 200 : 60_000,
    logger: (message) => process.stderr.write(`[ruvora-e2e] ${message}\n`),
    controlFactory: () => {
      const client = new CodexAppServerClient({ codexPath, cwd: root, turnTimeoutMs: 15 * 60_000 });
      return { client, control: new CodexControlPlane(client) };
    },
  });

  if (scheduled) server.startBackground();
  let response = await server.handleRequest({
    method: "tools/call",
    params: {
      name: scheduled ? "dispatch_agent_task" : "run_agent_task",
      arguments: {
        cwd: root,
        prompt: "Fix the implementation of add in math.js so the existing test passes. Run the test and make no unrelated changes.",
        role: "release-e2e-worker",
        taskKind: "implementation",
        mutatesWorkspace: true,
        sandbox: "workspace-write",
        workspaceMode: "worktree",
        integrationStrategy: "patch",
        routingMode: "new",
        acceptanceCriteria: ["The existing Node test passes", "math.js implements addition"],
      },
    },
  });

  assert.notEqual(response.isError, true, response.structuredContent?.error);
  const taskId = scheduled ? response.structuredContent.id : response.structuredContent.taskId;
  assert.equal(typeof taskId, "string", "execution response must identify the created task");
  if (scheduled) {
    const deadline = Date.now() + 15 * 60_000;
    while (Date.now() < deadline) {
      const record = server.registry.getTask(taskId);
      if (["completed", "failed", "cancelled", "interrupted", "recovery_attention", "blocked_by_policy"].includes(record.status)) break;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    const execution = server.registry.listTurnDispatches({ parentTaskId: taskId, purpose: "execution", limit: 1 })[0];
    response = { structuredContent: { taskId, record: server.registry.getTask(taskId), task: execution?.evidence?.result } };
  }
  const completed = response.structuredContent.record;
  assert.equal(completed.status, "completed");
  assert.equal(completed.metadata.validation.decision, "accept");
  assert.equal(completed.metadata.integration.status, "integrated");
  assert.equal(completed.metadata.completionVerdict.decision, "accept");
  const workerResult = response.structuredContent.task;
  const userMessages = (workerResult.executionItems ?? []).filter(item => item.type === "userMessage");
  assert.ok(userMessages.length, "hydrated native user message is required for conversation UX verification");
  const dispatch = server.registry.listTurnDispatches({ parentTaskId: taskId, purpose: "execution", limit: 1 })[0];
  assert.equal(userMessages[0].clientId, dispatch.id, "native history must retain the client submission identity for recovery");
  assert.equal(userMessages[0].content.filter(part => part.type === "text").map(part => part.text).join("\n"),
    "Fix the implementation of add in math.js so the existing test passes. Run the test and make no unrelated changes.");
  assert.doesNotMatch(workerResult.output, /^\s*(?:```json\s*)?\{\s*"outputs"/);
  assert.equal(readFileSync(join(root, "math.js"), "utf8").includes("left + right"), true);
  execFileSync(process.execPath, ["--test"], { cwd: root, stdio: "pipe" });
  await server.close();
  server = null;

  const reopened = new ControlRegistry({ path: registryPath });
  const durable = reopened.getTask(taskId);
  assert.equal(durable.status, "completed");
  assert.equal(durable.attempt, 1);
  assert.equal(durable.workerId, null);
  assert.equal(durable.claimToken, null);
  assert.equal(durable.heartbeatAt, null);
  reopened.close();

  passed = true;
  process.stdout.write(JSON.stringify({
    result: "pass",
    executionPath: scheduled ? "scheduled" : "foreground",
    taskId,
    workerThreadId: completed.agentId,
    workerTurnId: completed.turnId,
    validatorThreadId: completed.metadata.validationAgentId ?? null,
    validation: completed.metadata.validation.decision,
    integration: completed.metadata.integration.status,
    completion: completed.metadata.completionVerdict.decision,
    attempt: completed.attempt,
    claimReleasedAfterReopen: true,
    naturalUserMessage: true,
    naturalFinalAnswer: true,
  }, null, 2) + "\n");
} finally {
  await server?.close().catch(() => {});
  if (passed) rmSync(root, { recursive: true, force: true });
  else process.stderr.write(`E2E fixture retained for diagnosis: ${root}\n`);
}
