import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const dashboardPath = new URL("../ui/dashboard.html", import.meta.url);

test("360px through 1200px widths use staged responsive layouts", async () => {
  const html = await readFile(dashboardPath, "utf8");
  assert.match(html, /data-visual-regression-widths="360 480 600 800 1000 1200"/);
  assert.match(html, /\.dependency-grid \{ display:grid; grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/);
  assert.match(html, /@media \(max-width: 1180px\)[\s\S]*?\.plane-map \{ grid-template-columns:1fr; \}/);
  assert.match(html, /@media \(max-width: 1180px\)[\s\S]*?\.dependency-grid \{ grid-template-columns:repeat\(2,minmax\(0,1fr\)\); \}/);
  assert.match(html, /@media \(max-width: 900px\)[\s\S]*?\.row, \.row\.agent-row \{ grid-template-columns:1fr;/);
  assert.match(html, /@media \(max-width: 720px\)[\s\S]*?\.dependency-grid \{ grid-template-columns:1fr; \}/);
  assert.match(html, /@media \(max-width: 520px\)[\s\S]*?\.toolbar \{ display:grid; grid-template-columns:minmax\(0,1fr\) auto;/);
  assert.match(html, /@media \(max-width: 520px\)[\s\S]*?dialog \{ width:calc\(100vw - 16px\); max-height:92vh; \}/);
  assert.match(html, /@media \(max-width: 380px\)[\s\S]*?\.run-actions \{ grid-template-columns:1fr; \}/);
  assert.doesNotMatch(html, /@media \(max-width: 380px\)[\s\S]*?\.metrics \{ grid-template-columns:1fr; \}/);
  assert.match(html, /\.run-lanes \{ display:grid;[^}]*overflow-x:hidden;/);
  assert.match(html, /\.run-card \{ width:100%; min-width:0;/);
  assert.match(html, /\.run-card-name \{[^}]*min-height:2\.7em;[^}]*-webkit-line-clamp:2;/);
  assert.match(html, /\.dispatch-track \{[^}]*width:100%;[^}]*min-width:0;[^}]*overflow:hidden;/);
  assert.match(html, /\.graph-progress-row \{[^}]*grid-template-columns:minmax\(0,1fr\) auto;[^}]*min-width:0;/);
  assert.match(html, /\.graph-progress \{ width:100%; min-width:0;[^}]*overflow:hidden;/);
  assert.match(html, /\.plane-help \{[^}]*word-break:keep-all;[^}]*overflow-wrap:break-word;/);
  assert.match(html, /\.plane-state, \.plane-step > \.button-link \{ grid-column:2;/);
  assert.match(html, /\.graph-summary-title strong \{[^}]*word-break:keep-all;[^}]*overflow-wrap:anywhere;/);
  assert.match(html, /\.row-actions \{[^}]*flex-wrap:wrap;[^}]*min-width:0;/);
  assert.match(html, /@media \(max-width: 720px\)[\s\S]*?\.run-card-name \{[^}]*-webkit-line-clamp:3;/);
  assert.match(html, /@media \(max-width: 720px\)[\s\S]*?\.graph-node-head \{ display:grid; grid-template-columns:minmax\(0,1fr\); \}/);
});

test("run cards select details directly and obsolete management controls are absent", async () => {
  const html = await readFile(dashboardPath, "utf8");
  assert.match(html, /data-run-id=/);
  assert.match(html, /state\.runId = card\.dataset\.runId;[\s\S]*?state\.run = null;[\s\S]*?state\.graph = null;[\s\S]*?state\.revision = 0;/);
  assert.doesNotMatch(html, /id="run-select"/);
  assert.doesNotMatch(html, /data-tab="approvals"/);
  assert.doesNotMatch(html, /class="advanced-nav"/);
  assert.doesNotMatch(html, /resolve_approval/);
  assert.doesNotMatch(html, /id="start-run"/);
  assert.doesNotMatch(html, /callTool\("start_agent_run"/);
  assert.doesNotMatch(html, /approval_waiting/);
  assert.doesNotMatch(html, /awaiting_user_start/);
  assert.match(html, /실패 범주/);
});

test("work navigator keeps the run list and selected run structure visible by default", async () => {
  const html = await readFile(dashboardPath, "utf8");
  assert.match(html, /<div class="run-label">선택한 작업<\/div>/);
  assert.match(html, /id="focus-now"/);
  assert.match(html, /id="focus-result-summary"/);
  assert.match(html, /<details class="secondary-section" id="history-drawer" open>/);
  assert.match(html, /<details class="secondary-section" id="inspector" open>/);
  assert.match(html, /id="open-inspector">구조 보기/);
  assert.match(html, /el\("inspector"\)\.open = true/);
  assert.match(html, /<h1>작업 목록<\/h1>/);
});

test("dashboard copy omits redundant helper text", async () => {
  const html = await readFile(dashboardPath, "utf8");
  assert.doesNotMatch(html, /필요할 때만/);
  assert.doesNotMatch(html, /자동 갱신/);
  assert.doesNotMatch(html, /확인이 필요할 때만 알려드립니다/);
  assert.doesNotMatch(html, /class="metric-help"/);
  assert.doesNotMatch(html, /진행 흐름 · 스레드 · 진단/);
});

test("dashboard defaults to orchestration structure and separates work, threads, and results", async () => {
  const html = await readFile(dashboardPath, "utf8");
  assert.match(html, /data-tab="graph" class="tab active">구조/);
  assert.match(html, /data-tab="progress">작업/);
  assert.match(html, /data-tab="sessions">스레드/);
  assert.match(html, /data-tab="results">결과/);
  assert.match(html, /tab: "graph"/);
  assert.match(html, /id="diagnostics"/);
  assert.match(html, /Turn Dispatch/);
  assert.match(html, /id="open-diagnostics"[^>]*>고급 진단/);
  assert.match(html, /Context Snapshot/);
  assert.match(html, /Global Run/);
  assert.match(html, /get_dashboard_detail[^\n]+context_snapshot/);
  assert.match(html, /notificationLabels = \{ completed: "완료", failed: "실패", attention_required: "판단 필요", policy_blocked: "정책 중단" \}/);
  assert.doesNotMatch(html, /세션/);
  assert.doesNotMatch(html, /data-tab="(?:plans|worktrees|roles|memories|events)"/);
});

test("task flow keeps dependency stages visible without an overflowing canvas", async () => {
  const html = await readFile(dashboardPath, "utf8");
  assert.match(html, /class="dependency-level"/);
  assert.match(html, /class="dependency-connector"/);
  assert.match(html, /선행 작업 ·/);
  assert.match(html, /선행 단계 완료 후 시작/);
  assert.match(html, /const agentLabel = "하위 작업"/);
  assert.doesNotMatch(html, /class="graph-edges"/);
  assert.doesNotMatch(html, /style="left:\$\{position\.x\}px/);
});

test("dashboard renders backend failure, routing, identity, and archive contracts", async () => {
  const html = await readFile(dashboardPath, "utf8");
  assert.match(html, /실패 판정과 다음 조치/);
  assert.match(html, /Routing provenance와 충족 행렬/);
  assert.doesNotMatch(html, /DAEMON SCHEDULER|ORCHESTRATOR CODEX THREAD/);
  assert.match(html, /aria-label="전체 작업과 하위 작업"/);
  assert.match(html, /id="archive-scope"/);
  assert.match(html, /callTool\(action === "archive" \? "archive_run" : "unarchive_run"/);
  assert.match(html, /callTool\(action === "archive" \? "archive_agent" : "unarchive_agent"/);
  assert.doesNotMatch(html, /archive[^\n]{0,120}start_agent_run/);
  assert.match(html, /실행 준비 실패/);
  assert.match(html, /작업을 준비하고 있습니다/);
});

test("embedded dashboard script remains syntactically valid", async () => {
  const html = await readFile(dashboardPath, "utf8");
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  assert.doesNotThrow(() => new Function(script));
});

test("embedded dashboard polling is single-flight, adaptive, and visibility-aware", async () => {
  const html = await readFile(dashboardPath, "utf8");
  assert.match(html, /if \(refreshFlight\) return refreshFlight;/);
  assert.match(html, /unchangedPolls === 0 \? 10_000 : unchangedPolls === 1 \? 30_000 : 60_000/);
  assert.match(html, /if \(!pageActive \|\| standalone \|\| document\.hidden \|\| isTerminalView\(\)\) return;/);
  assert.match(html, /document\.addEventListener\("visibilitychange"/);
  assert.match(html, /window\.addEventListener\("pagehide"/);
  assert.match(html, /pageActive = false;/);
  assert.match(html, /const generation = lifecycleGeneration;[\s\S]*?await refresh\(\);[\s\S]*?generation !== lifecycleGeneration/);
  assert.match(html, /pagehide[\s\S]*?lifecycleGeneration \+= 1;/);
});

test("dashboard navigation links target actual work without message or clipboard fallbacks", async () => {
  const html = await readFile(dashboardPath, "utf8");
  assert.match(html, /const terminalStatuses = new Set/);
  assert.match(html, /data-thread-id=/);
  assert.match(html, /href="codex:\/\/threads\//);
  assert.doesNotMatch(html, /request\("ui\/message"/);
  assert.match(html, /전체 작업/);
  assert.match(html, /하위 작업/);
  assert.doesNotMatch(html, /navigator\.clipboard/);
  assert.match(html, /readOnly: !resultSession\.available/);
  assert.match(html, /state\.runThreads/);
  assert.match(html, /run-card-actors/);
  assert.match(html, /executionParticipants/);
  assert.match(html, /node\.resultSession\?\.threadId[\s\S]*?openAgentThread\(node\.resultSession\.threadId\)/);
  assert.match(html, /row\.resultSession\?\.threadId[\s\S]*?openAgentThread\(row\.resultSession\.threadId\)/);
});
