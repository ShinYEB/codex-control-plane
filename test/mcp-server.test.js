import assert from "node:assert/strict";
import test from "node:test";

import { McpControlServer } from "../src/mcp-server.js";
import { ControlRegistry } from "../src/registry.js";

function fakeServer(control, options = {}) {
  return new McpControlServer({
    controlFactory: () => ({ client: { close: async () => {} }, control }),
    registry: new ControlRegistry({ path: ":memory:" }),
    recoverInterruptedTasks: false,
    ...options,
  });
}

async function waitUntil(predicate, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for condition");
}

test("MCP initialize advertises tools and safety instructions", async () => {
  const server = fakeServer({ connect: async () => {} });
  const initialized = await server.handleRequest({ method: "initialize", params: { protocolVersion: "2025-06-18" } });
  const listed = await server.handleRequest({ method: "tools/list" });
  assert.equal(initialized.serverInfo.name, "codex-control-plane");
  assert.match(initialized.instructions, /single Codex session writer/);
  assert.match(initialized.instructions, /compatible reusable Data Plane session/);
  assert.match(initialized.instructions, /durable Orchestrator session/);
  assert.deepEqual(listed.tools.map((tool) => tool.name), [
    "list_agents",
    "archive_agent",
    "unarchive_agent",
    "inspect_agent",
    "register_agent_profile",
    "upsert_project_memory",
    "list_project_memories",
    "get_project_context",
    "delete_project_memory",
    "route_agent",
    "spawn_agent",
    "fork_agent",
    "run_agent_task",
    "dispatch_agent_task",
    "prepare_agent_run",
    "dispatch_control_request",
    "start_agent_run",
    "mark_dashboard_ready",
    "get_run_graph",
    "list_runs",
    "archive_run",
    "unarchive_run",
    "cancel_run",
    "list_tasks",
    "cancel_task",
    "list_worktree_leases",
    "acquire_worktree_lease",
    "release_worktree_lease",
    "list_events",
    "plan_agent_run",
    "revise_agent_plan",
    "list_plans",
    "get_plan",
    "synthesize_run",
    "list_approvals",
    "resolve_approval",
    "list_managed_worktrees",
    "cleanup_worktree",
    "list_role_templates",
    "upsert_role_template",
    "get_desktop_handoff",
    "get_task",
    "get_dashboard_state",
    "get_dashboard_detail",
    "show_agent_dashboard",
  ]);
});

test("agent profiles persist and influence automatic routing", async () => {
  const agents = [
    { id: "backend_1", name: "Backend", cwd: "/repo", status: "notLoaded", provider: "codex" },
    { id: "ui_1", name: "UI", cwd: "/repo", status: "notLoaded", provider: "codex" },
  ];
  const control = {
    connect: async () => {},
    listAgents: async () => ({ agents, nextCursor: null }),
  };
  const dashboardServer = { start: async () => {}, url: () => "http://127.0.0.1/dashboard", close: async () => {} };
  const server = fakeServer(control, { dashboardServer });
  server.registry.upsertAgent(agents[0]);
  await server.handleRequest({
    method: "tools/call",
    params: {
      name: "register_agent_profile",
      arguments: { threadId: "backend_1", role: "backend", capabilities: ["api", "database"] },
    },
  });
  const routed = await server.handleRequest({
    method: "tools/call",
    params: {
      name: "route_agent",
      arguments: { prompt: "API 데이터베이스를 검토해줘", cwd: "/repo", role: "backend", capabilities: ["api"] },
    },
  });
  assert.equal(routed.structuredContent.decision, "fork");
  assert.equal(routed.structuredContent.selectedAgent.id, "backend_1");
  assert.ok(routed.structuredContent.scoreBreakdown.role > 0);
  assert.equal(routed.structuredContent.confidence.level, "high");
  assert.equal(routed.structuredContent.selectedRequirementMatrix.capabilities.allSatisfied, true);
  assert.equal(routed.structuredContent.provenance.candidateSource, "durable_registry");
});

test("listing agents is registry-only and never wakes App Server", async () => {
  const agents = [
    { id: "existing_1", name: "Existing", cwd: "/repo", status: "notLoaded", provider: "codex" },
    { id: "specialized_1", name: "Specialized", cwd: "/repo", status: "notLoaded", provider: "codex" },
  ];
  let calls = 0;
  const server = fakeServer({
    connect: async () => {},
    listAgents: async () => { calls += 1; return { agents, nextCursor: null }; },
  });
  server.registry.upsertAgent(agents[1], { role: "reviewer", capabilities: ["review"] });

  const listed = await server.handleRequest({
    method: "tools/call",
    params: { name: "list_agents", arguments: { cwd: "/repo" } },
  });

  assert.equal(calls, 0);
  assert.deepEqual(listed.structuredContent.agents.map((agent) => agent.id), ["specialized_1"]);
  assert.equal(listed.structuredContent.source, "registry");
});

test("archive tools filter terminal runs and idle agents without touching active identities", async () => {
  const calls = [];
  const control = {
    connect: async () => {},
    archiveAgent: async (id) => { calls.push(["archive", id]); },
    unarchiveAgent: async (id) => { calls.push(["unarchive", id]); },
  };
  const server = fakeServer(control);
  server.registry.upsertAgent({ id: "idle_archive", cwd: "/repo", status: "idle" });
  server.registry.upsertAgent({ id: "busy_archive", cwd: "/repo", status: "running" });
  server.registry.createRun({ id: "done_archive", cwd: "/repo", status: "completed" });
  server.registry.createRun({ id: "live_archive", cwd: "/repo", status: "running" });
  const archivedAgent = await server.handleRequest({ method: "tools/call", params: { name: "archive_agent", arguments: { threadId: "idle_archive" } } });
  assert.ok(archivedAgent.structuredContent.archivedAt);
  const rejectedAgent = await server.handleRequest({ method: "tools/call", params: { name: "archive_agent", arguments: { threadId: "busy_archive" } } });
  assert.equal(rejectedAgent.isError, true);
  assert.equal(rejectedAgent.structuredContent.code, "ARCHIVE_ACTIVE_AGENT");
  await server.handleRequest({ method: "tools/call", params: { name: "archive_run", arguments: { runId: "done_archive" } } });
  const rejectedRun = await server.handleRequest({ method: "tools/call", params: { name: "archive_run", arguments: { runId: "live_archive" } } });
  assert.equal(rejectedRun.structuredContent.code, "ARCHIVE_ACTIVE_RUN");
  const archived = await server.handleRequest({ method: "tools/call", params: { name: "list_agents", arguments: { cwd: "/repo", scope: "archived" } } });
  const archivedRuns = await server.handleRequest({ method: "tools/call", params: { name: "list_runs", arguments: { cwd: "/repo", scope: "archived" } } });
  assert.deepEqual(archived.structuredContent.agents.map((agent) => agent.id), ["idle_archive"]);
  assert.deepEqual(archivedRuns.structuredContent.runs.map((run) => run.id), ["done_archive"]);
  await server.handleRequest({ method: "tools/call", params: { name: "unarchive_agent", arguments: { threadId: "idle_archive" } } });
  await server.handleRequest({ method: "tools/call", params: { name: "unarchive_run", arguments: { runId: "done_archive" } } });
  assert.deepEqual(calls, [["archive", "idle_archive"], ["unarchive", "idle_archive"]]);
  await server.close();
});

test("task routing provenance and capability/tool matrix persist with scheduler identity", async () => {
  const source = { id: "route_source", name: "Backend", cwd: "/repo", status: "idle", provider: "codex" };
  const control = {
    connect: async () => {},
    listAgents: async () => ({ agents: [source], nextCursor: null }),
    forkAgent: async () => ({ id: "route_worker", cwd: "/repo", status: "idle", provider: "codex", forkedFromId: source.id }),
    nameAgent: async () => {},
    pinAgent: async () => {},
    runTask: async (_id, _prompt, options = {}) => {
      options.onStarted?.({ turnId: "turn_route" });
      return { output: "done", turnId: "turn_route", turn: { status: "completed" } };
    },
  };
  const server = fakeServer(control, { instanceId: "daemon_scheduler_1" });
  server.registry.upsertAgent(source, { role: "backend", capabilities: ["api"], metadata: { tools: ["node"] } });
  const result = await server.handleRequest({ method: "tools/call", params: { name: "run_agent_task", arguments: {
    prompt: "implement api", cwd: "/repo", role: "backend", capabilities: ["api"], tools: ["node"], routingMode: "auto",
  } } });
  const task = server.registry.getTask(result.structuredContent.taskId);
  assert.equal(task.routing.provenance.decisionSource, "agent_router");
  assert.equal(task.routing.provenance.taskId, task.id);
  assert.equal(task.routing.selectedRequirementMatrix.capabilities.allSatisfied, true);
  assert.equal(task.routing.assignmentRequirementMatrix.tools.allSatisfied, true);
  assert.deepEqual(task.routing.schedulerIdentity, { type: "daemon_scheduler", instanceId: "daemon_scheduler_1" });
  assert.equal(task.routing.orchestratorSessionIdentity, null);
  await server.close();
});

test("plugin initialization performs no App Server synchronization", async () => {
  let connected = 0;
  const server = fakeServer({
    connect: async () => { connected += 1; },
    listAgents: async () => { throw new Error("must not list"); },
  });
  await server.handleRequest({ method: "initialize", params: { protocolVersion: "2025-06-18" } });
  assert.equal(connected, 0);
  assert.deepEqual(server.registry.listAgents(), []);
});

test("a standalone MCP server refuses to become a second Codex session writer", async () => {
  const server = new McpControlServer({
    registry: new ControlRegistry({ path: ":memory:" }),
    sessionWriter: false,
    recoverInterruptedTasks: false,
  });
  const response = await server.handleRequest({
    method: "tools/call",
    params: { name: "spawn_agent", arguments: { cwd: "/repo" } },
  });
  assert.equal(response.isError, true);
  assert.equal(response.structuredContent.code, "DAEMON_SESSION_WRITER_REQUIRED");
  await server.close();
});

test("project memory tools build an auditable context pack", async () => {
  const server = fakeServer({ connect: async () => {} });
  const stored = await server.handleRequest({
    method: "tools/call",
    params: {
      name: "upsert_project_memory",
      arguments: { cwd: "/repo", kind: "decision", title: "API", content: "REST API는 v2 경로를 사용한다", tags: ["api"] },
    },
  });
  const context = await server.handleRequest({
    method: "tools/call",
    params: { name: "get_project_context", arguments: { cwd: "/repo", prompt: "API 경로를 구현해줘", role: "backend" } },
  });
  assert.equal(context.structuredContent.memories[0].id, stored.structuredContent.id);
  assert.ok(context.structuredContent.memories[0].selectionReasons.length > 0);
  assert.equal(server.registry.getMemory(stored.structuredContent.id).lastUsedAt, null);
});

test("run_agent_task forks an existing agent by default", async () => {
  const calls = [];
  const control = {
    connect: async () => calls.push(["connect"]),
    forkAgent: async (id, options) => {
      calls.push(["fork", id, options]);
      return { id: "forked_1" };
    },
    runTask: async (id, prompt) => {
      calls.push(["run", id, prompt]);
      return { output: "done" };
    },
  };
  const dashboardServer = { start: async () => {}, url: () => "http://127.0.0.1/dashboard", close: async () => {} };
  const server = fakeServer(control, { dashboardServer });
  const response = await server.handleRequest({
    method: "tools/call",
    params: { name: "run_agent_task", arguments: { threadId: "source_1", prompt: "review" } },
  });
  assert.equal(response.structuredContent.mode, "forked");
  assert.deepEqual(calls.map((entry) => entry[0]), ["connect", "fork", "run"]);
  assert.equal(calls[1][2].sandbox, "read-only");
});

test("run_agent_task injects project context and records its result", async () => {
  let deliveredPrompt = "";
  const control = {
    connect: async () => {},
    spawnAgent: async () => ({ id: "agent_context", cwd: "/repo", status: "idle", provider: "codex" }),
    runTask: async (id, prompt, options) => {
      deliveredPrompt = prompt;
      options.onStarted?.({ turnId: "turn_context" });
      return { output: "v2 구현 완료", turnId: "turn_context", turn: { status: "completed" } };
    },
  };
  const server = fakeServer(control);
  server.registry.upsertMemory({ id: "api_decision", cwd: "/repo", kind: "decision", title: "API", content: "v2 API를 사용한다", source: "user" });
  const response = await server.handleRequest({
    method: "tools/call",
    params: { name: "run_agent_task", arguments: { prompt: "API 구현", cwd: "/repo", role: "backend", routingMode: "new" } },
  });
  assert.match(deliveredPrompt, /Authoritative project context/);
  assert.match(deliveredPrompt, /v2 API를 사용한다/);
  assert.equal(response.structuredContent.contextPack.memories[0].id, "api_decision");
  assert.equal(response.structuredContent.resultMemory.kind, "task_result");
  assert.match(server.registry.getAgent("agent_context").summary, /v2 구현 완료/);
});

test("acceptance criteria keep a task validating until the validator accepts", async () => {
  const transitions = [];
  const control = {
    connect: async () => {},
    spawnAgent: async () => ({ id: "worker_validated", cwd: "/repo", status: "idle", provider: "codex" }),
    runTask: async (_id, _prompt, options) => {
      options.onStarted?.({ turnId: "turn_validated" });
      return { output: "tests: 12 passed", turnId: "turn_validated", turn: { status: "completed" } };
    },
  };
  const resultValidator = {
    validate: async () => {
      transitions.push("validator-called");
      return { decision: "accept", summary: "All tests passed", evidence: ["12 passed"], unmetCriteria: [] };
    },
  };
  const server = fakeServer(control, { resultValidator });
  const response = await server.handleRequest({
    method: "tools/call",
    params: { name: "run_agent_task", arguments: { prompt: "구현", cwd: "/repo", routingMode: "new", acceptanceCriteria: ["테스트 통과"] } },
  });
  assert.deepEqual(transitions, ["validator-called"]);
  assert.equal(response.structuredContent.record.status, "completed");
  assert.equal(response.structuredContent.record.metadata.validation.decision, "accept");
  assert.equal(response.structuredContent.validation.summary, "All tests passed");
});

test("a completed turn with a non-zero real test command is persisted as failed", async () => {
  const control = {
    connect: async () => {},
    spawnAgent: async () => ({ id: "worker_bad_test", cwd: "/repo", status: "idle", provider: "codex" }),
    runTask: async (_id, _prompt, options) => {
      options.onStarted?.({ turnId: "turn_bad_test" });
      return {
        output: "test run finished",
        turnId: "turn_bad_test",
        turn: { status: "completed" },
        executionItems: [{ id: "cmd_test", type: "commandExecution", command: "node --test", exitCode: 2, status: "completed" }],
      };
    },
  };
  const server = fakeServer(control);
  const response = await server.handleRequest({
    method: "tools/call",
    params: { name: "run_agent_task", arguments: { prompt: "run tests", cwd: "/repo", routingMode: "new" } },
  });
  assert.equal(response.structuredContent.record.status, "failed");
  assert.equal(response.structuredContent.record.metadata.failure.type, "test");
  assert.equal(response.structuredContent.record.metadata.failure.cause, "node --test exited with code 2");
  assert.equal(response.structuredContent.record.metadata.failure.retryable, true);
  assert.equal(response.structuredContent.record.metadata.failure.exhausted, true);
  assert.deepEqual(response.structuredContent.record.metadata.failure.attemptBudget, { used: 1, max: 1, remaining: 0 });
  await server.close();
});

test("read-only tools are marked read-only", async () => {
  const server = fakeServer({ connect: async () => {} });
  const listed = await server.handleRequest({ method: "tools/list" });
  assert.equal(listed.tools.find((tool) => tool.name === "list_agents").annotations.readOnlyHint, true);
  assert.equal(listed.tools.find((tool) => tool.name === "run_agent_task").annotations.readOnlyHint, false);
});

test("dashboard resource uses the MCP Apps MIME type", async () => {
  const server = fakeServer({ connect: async () => {} });
  const resources = await server.handleRequest({ method: "resources/list" });
  const result = await server.handleRequest({
    method: "resources/read",
    params: { uri: resources.resources[0].uri },
  });
  assert.equal(result.contents[0].mimeType, "text/html;profile=mcp-app");
  assert.match(result.contents[0].text, /멀티 에이전트 작업 현황/);
  assert.match(result.contents[0].text, /data-tab="graph"/);
  assert.match(result.contents[0].text, /모든 세션은 플러그인을 실행할 때 자동으로 등록/);
  assert.match(result.contents[0].text, /request\("ui\/message"/);
  assert.match(result.contents[0].text, /graph-board/);
  assert.match(result.contents[0].text, /실행 구조/);
  assert.match(result.contents[0].text, /CONTROL PLANE/);
  assert.match(result.contents[0].text, /DAEMON SCHEDULER/);
  assert.match(result.contents[0].text, /ORCHESTRATOR CODEX SESSION/);
  assert.match(result.contents[0].text, /DATA PLANE/);
  assert.match(result.contents[0].text, /plane-map/);
  assert.match(result.contents[0].text, /컨트롤 플레인 작업함/);
  assert.match(result.contents[0].text, /요청을 접수하면 각 실행이 백그라운드/);
});

test("show_agent_dashboard returns agents and task state", async () => {
  const calls = [];
  const control = {
    connect: async () => {},
    listAgents: async (options) => {
      calls.push(options);
      return { agents: [
        { id: "agent_1", cwd: "/repo", status: "idle" },
        { id: "agent_other", cwd: "/another-project", status: "idle" },
      ], nextCursor: null };
    },
  };
  const dashboardServer = { start: async () => {}, url: () => "http://127.0.0.1/dashboard", close: async () => {} };
  const server = fakeServer(control, { dashboardServer });
  const result = await server.handleRequest({
    method: "tools/call",
    params: { name: "show_agent_dashboard", arguments: { cwd: "/repo" } },
  });
  assert.equal(result.structuredContent.agents[0].id, "agent_1");
  assert.equal(result.structuredContent.agents.length, 1);
  assert.equal(calls[0].cwd, "/repo");
  assert.equal(server.registry.getAgent("agent_other").role, "general");
  assert.deepEqual(result.structuredContent.tasks, []);
  assert.equal(result.structuredContent.cwd, "/repo");
  assert.equal(result.structuredContent.dashboardPresentation, "embedded");
  assert.equal(result.content.some((item) => item.type === "resource_link"), false);
  assert.equal(result._meta.ui.resourceUri, "ui://codex-control-plane/agent-dashboard-v2.html");
  assert.equal(result._meta["openai/outputTemplate"], "ui://codex-control-plane/agent-dashboard-v2.html");
  assert.equal(result._meta["openai/widgetAccessible"], true);

  const web = await server.handleRequest({
    method: "tools/call",
    params: { name: "show_agent_dashboard", arguments: { cwd: "/repo", presentation: "web" } },
  });
  assert.equal(web.structuredContent.dashboardPresentation, "web");
  assert.equal(web.content.some((item) => item.type === "resource_link"), true);
  assert.equal(calls.length, 1, "project reconciliation is cached for five minutes");
  await server.close();
});

test("only show_agent_dashboard advertises or returns the output template", async () => {
  const control = {
    connect: async () => {}, listAgents: async () => ({ agents: [], nextCursor: null }),
    spawnAgent: async () => ({ id: "worker_template", cwd: "/repo", status: "idle" }),
    nameAgent: async () => {}, pinAgent: async () => {},
    runTask: async () => ({ output: "READY", turn: { status: "completed" } }),
  };
  const dashboardServer = { start: async () => {}, url: () => "http://127.0.0.1/dashboard", close: async () => {} };
  const server = fakeServer(control, { dashboardServer });
  const listed = await server.handleRequest({ method: "tools/list" });
  assert.deepEqual(listed.tools.filter((tool) => tool._meta?.["openai/outputTemplate"]).map((tool) => tool.name), ["show_agent_dashboard"]);
  const prepared = await server.handleRequest({
    method: "tools/call",
    params: { name: "dispatch_agent_task", arguments: { prompt: "later", cwd: "/repo", waitForDashboard: true, routingMode: "new" } },
  });
  assert.equal(prepared._meta, undefined);
  await server.close();
});

test("dashboard snapshots are lightweight and details load on demand behind a view lease", async () => {
  const control = { connect: async () => {}, listAgents: async () => ({ agents: [], nextCursor: null }) };
  const dashboardServer = { start: async () => {}, url: () => "http://127.0.0.1/dashboard", close: async () => {} };
  const server = fakeServer(control, { dashboardServer });
  server.registry.createRun({ id: "run_light", cwd: "/repo", status: "awaiting_user_start" });
  server.registry.createTask({ id: "task_light", prompt: "a very detailed private prompt", cwd: "/repo", status: "staged", metadata: { runId: "run_light", title: "Summary" } });
  const shown = await server.handleRequest({ method: "tools/call", params: { name: "show_agent_dashboard", arguments: { cwd: "/repo" } } });
  assert.equal(shown.structuredContent.tasks[0].prompt, undefined);
  assert.equal(shown.structuredContent.graph.nodes[0].prompt, undefined);
  assert.equal(typeof shown.structuredContent.revision, "number");
  const detail = await server.handleRequest({ method: "tools/call", params: { name: "get_dashboard_detail", arguments: {
    dashboardLeaseToken: shown.structuredContent.dashboardLeaseToken, entityType: "task", entityId: "task_light",
  } } });
  assert.equal(detail.structuredContent.detail.prompt, "a very detailed private prompt");
  assert.equal(detail._meta, undefined);
  const revision = shown.structuredContent.revision;
  server.registry.updateTask("task_light", { status: "queued" });
  const delta = await server.handleRequest({ method: "tools/call", params: { name: "get_dashboard_state", arguments: {
    dashboardLeaseToken: shown.structuredContent.dashboardLeaseToken, cwd: "/repo", sinceRevision: revision,
  } } });
  assert.equal(delta.structuredContent.kind, "delta");
  assert.equal(delta.structuredContent.tasks[0].status, "queued");
  assert.equal(delta.structuredContent.agents, undefined);
  await server.close();
});

test("data-plane and orchestrator sessions cannot open the dashboard", async () => {
  const control = { connect: async () => {}, listAgents: async () => ({ agents: [], nextCursor: null }) };
  const server = fakeServer(control);
  server.registry.upsertAgent({ id: "worker_1", cwd: "/repo", status: "idle", metadata: { executionPlane: "data" } });
  const result = await server.handleRequest({ method: "tools/call", params: { name: "show_agent_dashboard", arguments: { cwd: "/repo", requesterThreadId: "worker_1" } } });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.code, -32003);
  await server.close();
});

test("project reconciliation is five-minute TTL single-flight", async () => {
  let calls = 0;
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const control = {
    connect: async () => {},
    listAgents: async () => { calls += 1; await pending; return { agents: [{ id: "once", cwd: "/repo", status: "idle" }], nextCursor: null }; },
  };
  const dashboardServer = { start: async () => {}, url: () => "http://127.0.0.1/dashboard", close: async () => {} };
  const server = fakeServer(control, { dashboardServer, reconciliationTtlMs: 300_000 });
  const first = server.handleRequest({ method: "tools/call", params: { name: "show_agent_dashboard", arguments: { cwd: "/repo" } } });
  const second = server.handleRequest({ method: "tools/call", params: { name: "show_agent_dashboard", arguments: { cwd: "/repo" } } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  release();
  await Promise.all([first, second]);
  await server.handleRequest({ method: "tools/call", params: { name: "show_agent_dashboard", arguments: { cwd: "/repo" } } });
  assert.equal(calls, 1);
  await server.close();
});

test("prepare_agent_run creates no session until Start and then binds a leased session per task", async () => {
  const calls = [];
  const dashboardServer = {
    start: async () => {},
    url: ({ runId }) => `http://127.0.0.1/dashboard?runId=${runId}`,
    close: async () => {},
  };
  const control = {
    connect: async () => {},
    spawnAgent: async () => ({ id: "agent_prepared", cwd: "/repo", status: "idle", ephemeral: false }),
    nameAgent: async (id, name) => calls.push(["name", id, name]),
    pinAgent: async (id) => calls.push(["pin", id]),
    runTask: async (id, prompt) => {
      calls.push(["initialize", id, prompt]);
      return { output: "READY", turn: { status: "completed" } };
    },
  };
  const server = fakeServer(control, { dashboardServer, schedulerConcurrency: 1, schedulerIntervalMs: 5 });
  const prepared = await server.handleRequest({
    method: "tools/call",
    params: {
      name: "prepare_agent_run",
      arguments: {
        name: "검증 작업",
        cwd: "/repo",
        tasks: [{ key: "review", title: "API 검토", prompt: "review", role: "Backend", routingMode: "new" }],
      },
    },
  });
  assert.equal(prepared.structuredContent.status, "awaiting_user_start");
  assert.equal(prepared.structuredContent.tasks[0].status, "staged");
  assert.deepEqual(prepared.structuredContent.agents, []);
  assert.equal(prepared.structuredContent.tasks[0].agentId, null);
  assert.deepEqual(calls, []);

  const ready = await server.handleRequest({
    method: "tools/call",
    params: { name: "start_agent_run", arguments: { runId: prepared.structuredContent.runId } },
  });
  assert.equal(ready.structuredContent.tasks[0].status, "queued");
  assert.equal(server.registry.getRun(prepared.structuredContent.runId).status, "running");
  const completed = await waitUntil(() => server.registry.listTasks({ runId: prepared.structuredContent.runId, limit: 10 })[0]?.status === "completed");
  assert.equal(completed, true);
  const task = server.registry.listTasks({ runId: prepared.structuredContent.runId, limit: 10 })[0];
  assert.equal(task.agentId, "agent_prepared");
  assert.deepEqual(calls.map((entry) => entry[0]), ["name", "pin", "initialize"]);
  await server.close();
});

test("complex runs create no session during preparation and provision an Orchestrator at Start", async () => {
  let sequence = 0;
  const control = {
    connect: async () => {},
    spawnAgent: async () => ({ id: `agent_${++sequence}`, cwd: "/repo", status: "idle", ephemeral: false }),
    nameAgent: async () => {},
    pinAgent: async () => {},
    resumeAgent: async (id) => ({ id, cwd: "/repo", status: "idle", provider: "codex" }),
    runTask: async () => ({ output: "READY", turn: { status: "completed" } }),
  };
  const dashboardServer = { start: async () => {}, url: ({ runId }) => `http://127.0.0.1/dashboard?runId=${runId}`, close: async () => {} };
  const server = fakeServer(control, { dashboardServer, schedulerConcurrency: 0 });
  const prepared = await server.handleRequest({
    method: "tools/call",
    params: { name: "prepare_agent_run", arguments: {
      name: "복합 기능",
      cwd: "/repo",
      tasks: [
        { key: "build", title: "구현", prompt: "build", role: "implementer", routingMode: "new" },
        { key: "review", title: "검토", prompt: "review", role: "reviewer", dependsOn: ["build"], routingMode: "new" },
      ],
    } },
  });
  assert.equal(prepared.structuredContent.dispatchPath, "orchestrated");
  assert.equal(prepared.structuredContent.orchestrator, null);
  assert.deepEqual(prepared.structuredContent.agents, []);
  assert.equal(sequence, 0);
  const graph = server.runController.graph(prepared.structuredContent.runId);
  assert.equal(graph.run.orchestrator, null);
  assert.equal(graph.run.complexity.taskCount, 2);
  await server.handleRequest({ method: "tools/call", params: { name: "start_agent_run", arguments: { runId: prepared.structuredContent.runId } } });
  const started = server.runController.graph(prepared.structuredContent.runId);
  assert.equal(started.run.orchestrator.id, "agent_1");
  assert.deepEqual(started.run.orchestratorSession, { type: "codex_session", agentId: "agent_1" });
  assert.equal(sequence, 1, "Start creates only the Orchestrator before workers are scheduled");
  await server.close();
});

test("prepared run records an actual Orchestrator session separately from the Daemon Scheduler", async () => {
  const control = { connect: async () => {} };
  const dashboardServer = { start: async () => {}, url: ({ runId }) => `http://127.0.0.1/dashboard?runId=${runId}`, close: async () => {} };
  const server = fakeServer(control, { dashboardServer, schedulerConcurrency: 0, instanceId: "daemon_identity" });
  server.registry.upsertAgent({ id: "orchestrator_identity", cwd: "/repo", status: "idle" }, { role: "orchestrator" });
  const prepared = await server.handleRequest({ method: "tools/call", params: { name: "prepare_agent_run", arguments: {
    cwd: "/repo", orchestratorThreadId: "orchestrator_identity", tasks: [{ key: "work", prompt: "work", routingMode: "new" }],
  } } });
  const graph = server.runController.graph(prepared.structuredContent.runId);
  assert.deepEqual(graph.run.scheduler, { type: "daemon_scheduler", instanceId: "daemon_identity" });
  assert.deepEqual(graph.run.orchestratorSession, { type: "codex_session", agentId: "orchestrator_identity" });
  assert.equal(graph.run.orchestrator.id, "orchestrator_identity");
  assert.notEqual(graph.run.scheduler.instanceId, graph.run.orchestrator.id);
  assert.deepEqual(prepared.structuredContent.orchestrator, { id: "orchestrator_identity", type: "codex_session" });
  await server.close();
});

test("dispatch_control_request returns before planning and always waits for explicit Start", async () => {
  let releasePlan;
  const planning = new Promise((resolve) => { releasePlan = resolve; });
  const planner = { plan: async () => planning };
  let nextAgent = 0;
  const control = {
    connect: async () => {},
    listAgents: async () => ({ agents: [], nextCursor: null }),
    spawnAgent: async () => ({ id: `agent_async_${++nextAgent}`, cwd: "/repo", status: "idle", provider: "codex" }),
    nameAgent: async () => {},
    pinAgent: async () => {},
    runTask: async (_id, _prompt, options = {}) => {
      options.onStarted?.({ turnId: `turn_${nextAgent}` });
      return { output: "READY", turnId: `turn_${nextAgent}`, turn: { status: "completed" } };
    },
  };
  const dashboardServer = { start: async () => {}, url: ({ runId }) => `http://127.0.0.1/dashboard?runId=${runId}`, close: async () => {} };
  const server = fakeServer(control, { planner, dashboardServer, schedulerConcurrency: 0 });

  const accepted = await server.handleRequest({
    method: "tools/call",
    params: { name: "dispatch_control_request", arguments: { objective: "두 작업을 병렬 검증", cwd: "/repo" } },
  });
  assert.equal(accepted.structuredContent.status, "accepted");
  assert.equal(accepted.structuredContent.controlPlaneStatus, "available");
  assert.equal(accepted.structuredContent.autoStart, false);
  assert.equal(accepted.structuredContent.requiresExplicitStart, true);
  assert.equal(server.registry.listTasks({ runId: accepted.structuredContent.runId, limit: 10 }).length, 0);

  releasePlan({
    id: "plan_async",
    version: 1,
    plan: {
      summary: "병렬 검증",
      tasks: [
        { key: "one", title: "첫 작업", prompt: "첫 작업", role: "qa", dependsOn: [], acceptanceCriteria: [] },
        { key: "two", title: "둘째 작업", prompt: "둘째 작업", role: "reviewer", dependsOn: [], acceptanceCriteria: [] },
      ],
    },
  });
  const running = await waitUntil(() => {
    const run = server.registry.getRun(accepted.structuredContent.runId);
    return run?.status === "awaiting_user_start" ? run : null;
  });
  assert.equal(running.metadata.dispatchPath, "orchestrated");
  assert.equal(server.registry.listTasks({ runId: running.id, limit: 10 }).length, 2);
  assert.equal(running.metadata.orchestratorAgentId, undefined);
  assert.equal(nextAgent, 0, "planning may use its injected planner, but run preparation must not create worker sessions");
});

test("registry task preserves failed and interrupted App Server turn status", async () => {
  for (const turnStatus of ["failed", "interrupted"]) {
    const control = {
      connect: async () => {},
      spawnAgent: async () => ({ id: `agent_${turnStatus}`, cwd: "/repo", status: "idle", provider: "codex" }),
      nameAgent: async () => {},
      pinAgent: async () => {},
      runTask: async (_id, _prompt, options = {}) => {
        options.onStarted?.({ turnId: `turn_${turnStatus}` });
        return { output: "partial", turnId: `turn_${turnStatus}`, turn: { status: turnStatus } };
      },
    };
    const server = fakeServer(control);
    const response = await server.handleRequest({
      method: "tools/call",
      params: { name: "run_agent_task", arguments: { prompt: "work", cwd: "/repo", routingMode: "new" } },
    });
    assert.equal(response.structuredContent.record.status, turnStatus);
    assert.equal(server.registry.getTask(response.structuredContent.taskId).status, turnStatus);
    await server.close();
  }
});

test("dependent data-plane tasks receive upstream results as A2A handoff", async () => {
  const prompts = [];
  let nextAgent = 0;
  const control = {
    connect: async () => {},
    listAgents: async () => ({ agents: [], nextCursor: null }),
    spawnAgent: async () => ({ id: `agent_handoff_${++nextAgent}`, cwd: "/repo", status: "idle", provider: "codex" }),
    forkAgent: async (id) => ({ id: `${id}_fork`, cwd: "/repo", status: "idle", provider: "codex", forkedFromId: id }),
    resumeAgent: async (id) => ({ id, cwd: "/repo", status: "idle", provider: "codex" }),
    nameAgent: async () => {},
    pinAgent: async () => {},
    runTask: async (id, prompt, options = {}) => {
      prompts.push({ id, prompt });
      options.onStarted?.({ turnId: `turn_${prompts.length}` });
      return { output: prompt.includes("첫 결과를 생성") ? "UPSTREAM_RESULT" : "done", turnId: `turn_${prompts.length}`, turn: { status: "completed" } };
    },
  };
  const dashboardServer = { start: async () => {}, url: ({ runId }) => `http://127.0.0.1/dashboard?runId=${runId}`, close: async () => {} };
  const server = fakeServer(control, { dashboardServer, schedulerConcurrency: 1, schedulerIntervalMs: 5 });
  server.startBackground();
  const prepared = await server.handleRequest({
    method: "tools/call",
    params: { name: "prepare_agent_run", arguments: { cwd: "/repo", tasks: [
      { key: "first", title: "첫 작업", prompt: "첫 결과를 생성", role: "implementer" },
      { key: "second", title: "후속 작업", prompt: "첫 결과를 검토", role: "reviewer", dependsOn: ["first"] },
    ] } },
  });
  await server.handleRequest({ method: "tools/call", params: { name: "start_agent_run", arguments: { runId: prepared.structuredContent.runId } } });
  await waitUntil(() => server.registry.getRun(prepared.structuredContent.runId)?.status === "completed");
  const downstream = prompts.find((entry) => entry.prompt.includes("[A2A HANDOFF FROM COMPLETED UPSTREAM AGENTS]"));
  assert.ok(downstream);
  assert.match(downstream.prompt, /UPSTREAM_RESULT/);
  assert.ok(server.registry.listEvents({ limit: 100 }).some((event) => event.eventType === "task.a2a_handoff_received"));
  await server.close();
});

test("validator feedback drives bounded rework only after explicit Start", async () => {
  const prompts = [];
  let nextAgent = 0;
  let validations = 0;
  const control = {
    connect: async () => {},
    listAgents: async () => ({ agents: [], nextCursor: null }),
    spawnAgent: async () => ({ id: `agent_rework_${++nextAgent}`, cwd: "/repo", status: "idle", provider: "codex" }),
    forkAgent: async (id) => ({ id: `${id}_fork`, cwd: "/repo", status: "idle", provider: "codex", forkedFromId: id }),
    nameAgent: async () => {},
    pinAgent: async () => {},
    resumeAgent: async (id) => ({ id, cwd: "/repo", status: "idle", provider: "codex" }),
    runTask: async (_id, prompt, options = {}) => {
      prompts.push(prompt);
      options.onStarted?.({ turnId: `turn_rework_${prompts.length}` });
      return { output: `attempt ${prompts.length}`, turnId: `turn_rework_${prompts.length}`, turn: { status: "completed" } };
    },
  };
  const resultValidator = {
    validate: async () => {
      validations += 1;
      return validations === 1
        ? { decision: "reject", summary: "Add retry regression evidence", evidence: [], unmetCriteria: ["retry test passes"] }
        : { decision: "accept", summary: "Retry regression passes", evidence: ["1 passed"], unmetCriteria: [] };
    },
  };
  const dashboardServer = { start: async () => {}, url: ({ runId }) => `http://127.0.0.1/dashboard?runId=${runId}`, close: async () => {} };
  const server = fakeServer(control, { resultValidator, dashboardServer, schedulerConcurrency: 1, schedulerIntervalMs: 5 });
  server.startBackground();
  const prepared = await server.handleRequest({
    method: "tools/call",
    params: { name: "prepare_agent_run", arguments: { cwd: "/repo", tasks: [{
      key: "implementation", prompt: "implement retry", acceptanceCriteria: ["retry test passes"], maxAttempts: 3, retryDelayMs: 0,
    }] } },
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(prompts.length, 0, "preparation and dashboard activity must not execute work");
  await server.handleRequest({ method: "tools/call", params: { name: "start_agent_run", arguments: { runId: prepared.structuredContent.runId } } });
  await waitUntil(() => server.registry.getRun(prepared.structuredContent.runId)?.status === "completed");
  const task = server.registry.listTasks({ runId: prepared.structuredContent.runId, limit: 10 })[0];
  assert.equal(task.status, "completed");
  assert.equal(task.attempt, 2);
  assert.equal(task.metadata.failureHistory.length, 1);
  assert.match(prompts[1], /\[VALIDATOR REWORK FEEDBACK\]/);
  assert.match(prompts[1], /Add retry regression evidence/);
  await server.close();
});

test("periodic reconciliation completes a stale task from thread/read", async () => {
  const control = {
    connect: async () => {},
    inspectAgent: async (threadId, options) => {
      assert.equal(threadId, "agent_stale");
      assert.equal(options.includeTurns, true);
      return { thread: { turns: [{ id: "turn_stale", status: "completed", output: "recovered result" }] } };
    },
  };
  const server = fakeServer(control, { schedulerConcurrency: 0, staleTaskMs: 0 });
  server.registry.upsertAgent({ id: "agent_stale", cwd: "/repo", status: "running" });
  server.registry.createTask({ id: "task_stale", prompt: "recover", cwd: "/repo" });
  const claim = server.registry.claimTask("task_stale", "old_worker");
  server.registry.updateTask("task_stale", { agentId: "agent_stale", turnId: "turn_stale", heartbeatAt: new Date(0).toISOString() });
  const result = await server.reconcileStaleTasks();
  assert.equal(result.reconciled, 1);
  assert.equal(server.registry.getTask("task_stale").status, "completed");
  assert.equal(server.registry.getTask("task_stale").output, "recovered result");
  assert.equal(server.registry.getAgent("agent_stale").status, "idle");
  assert.ok(claim.claimToken);
  await server.close();
});

test("restart reconciliation consumes validator feedback once without duplicate rework", async () => {
  const feedback = { decision: "reject", summary: "Missing restart regression", evidence: [], unmetCriteria: ["restart test"] };
  let inspections = 0;
  const control = {
    connect: async () => {},
    inspectAgent: async (threadId) => {
      inspections += 1;
      assert.equal(threadId, "validator_restart");
      return { thread: { turns: [{ id: "turn_validator_restart", status: "completed", output: JSON.stringify(feedback) }] } };
    },
  };
  const server = fakeServer(control, { schedulerConcurrency: 0, staleTaskMs: 0 });
  server.registry.createTask({ id: "task_restart_validation", prompt: "work", cwd: "/repo", maxAttempts: 3, retryDelayMs: 0, metadata: { acceptanceCriteria: ["restart test"] } });
  const claim = server.registry.claimTask("task_restart_validation", "old_daemon");
  server.registry.markClaimAgentDone("task_restart_validation", "old_daemon", claim.claimToken, { output: "worker result", turnId: "turn_worker" });
  server.registry.markClaimValidating("task_restart_validation", "old_daemon", claim.claimToken);
  server.registry.updateTask("task_restart_validation", { heartbeatAt: new Date(0).toISOString(), metadata: { validationInProgress: { agentId: "validator_restart", turnId: "turn_validator_restart" } } });

  const first = await server.reconcileStaleTasks();
  const second = await server.reconcileStaleTasks();
  const task = server.registry.getTask("task_restart_validation");
  assert.equal(first.reconciled, 1);
  assert.equal(second.checked, 0);
  assert.equal(inspections, 1);
  assert.equal(task.status, "retry_waiting");
  assert.equal(task.metadata.failureHistory.length, 1);
  assert.equal(task.metadata.rework.feedbackHashes.length, 1);
  await server.close();
});

test("close drains then interrupts an active Data Plane turn", async () => {
  let releaseTurn;
  let interrupted = 0;
  const control = {
    connect: async () => {},
    listAgents: async () => ({ agents: [], nextCursor: null }),
    spawnAgent: async () => ({ id: "agent_shutdown", cwd: "/repo", status: "idle", provider: "codex" }),
    nameAgent: async () => {},
    pinAgent: async () => {},
    runTask: async (_id, _prompt, options = {}) => {
      options.onStarted?.({ turnId: "turn_shutdown" });
      return new Promise((resolve) => { releaseTurn = () => resolve({ output: "", turnId: "turn_shutdown", turn: { status: "interrupted" } }); });
    },
    interruptTask: async () => { interrupted += 1; releaseTurn(); },
  };
  const server = fakeServer(control, { schedulerConcurrency: 1, schedulerIntervalMs: 5, shutdownDrainMs: 5 });
  server.registry.createTask({ id: "task_shutdown", prompt: "long work", cwd: "/repo" });
  server.startBackground();
  await waitUntil(() => server.registry.getTask("task_shutdown")?.turnId === "turn_shutdown");
  await server.close();
  assert.equal(interrupted, 1);
  assert.equal(server.registry.getTask("task_shutdown").status, "interrupted");
});
