import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { agentDisplayName, publicWorkName } from "../src/agent-names.js";
import { workStatus } from "../src/work-status.js";

test("public names and link labels hide hierarchy without renaming stored history", () => {
  const agent = { id: "existing", name: "[🤖 orchestrator] 요청 처리" };
  const registry = { listTasks: () => [], getAgent: () => agent };
  const run = { id: "r", name: "요청 처리", status: "running", metadata: { orchestratorAgentId: agent.id } };
  assert.equal(agentDisplayName("slave", "파일 검사"), "🤖 파일 검사");
  assert.equal(publicWorkName(agent.name), "요청 처리");
  assert.equal(workStatus(registry, run).master.name, "요청 처리");
  assert.equal(workStatus(registry, run).master.url, undefined);
  assert.deepEqual(workStatus(registry, run).master.navigation, {
    kind: "host_tool", tool: "navigate_to_codex_page", arguments: { threadId: "existing" },
  });
  assert.equal(workStatus(registry, run).master.label, "작업 열기");
  run.status = "completed";
  assert.equal(workStatus(registry, run).master.label, "작업 열기");
  run.metadata.controlResultFinalizedAt = "2026-09-05T00:00:00Z";
  assert.equal(workStatus(registry, run).master.label, "결과 보기");
  assert.equal(agent.name, "[🤖 orchestrator] 요청 처리");
});

test("rendered work structure uses ordinary labels and keeps real navigation", () => {
  const html = readFileSync(new URL("../ui/dashboard.html", import.meta.url), "utf8");
  const source = html.slice(html.indexOf("    function renderRunGraph()"), html.indexOf("    function render()"));
  assert.ok(source.includes("function renderRunGraph"));
  const elements = new Map();
  const el = id => { if (!elements.has(id)) elements.set(id, { style: {} }); return elements.get(id); };
  const state = { graph: { run: { name: "파일 검사", status: "running", dispatchPath: "orchestrated",
    orchestrator: { name: "[🤖 orchestrator] hidden" }, orchestratorSession: { agentId: "actual-thread" } },
    nodes: [{ id: "one", title: "내용 확인", status: "running", agent: { name: "[🤖 slave] hidden" }, dependsOn: [] }],
    summary: { total: 1, completed: 0, finished: 0, active: 1, progress: 0 } } };
  const render = new Function("state", "el", "document", "statusLabel", "escapeHtml", "runStage", "isTerminalStatus", "threadLink", "bindAgentLinks", "failureActionLabel", source + "\nrenderRunGraph();");
  render(state, el, { querySelectorAll: () => [] }, () => "진행 중", String, () => 1, () => false,
    (id, label) => `<a data-thread-id="${id}">${label}</a>`, () => {}, String);
  const output = el("list").innerHTML;
  assert.match(output, /전체 작업/);
  assert.match(output, /하위 작업/);
  assert.match(output, /actual-thread/);
  assert.match(output, /작업 열기/);
  assert.doesNotMatch(output, /master|slave|orchestrator|DAEMON SCHEDULER|CONTROL PLANE|DATA PLANE|hidden/i);
});
