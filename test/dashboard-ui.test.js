import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const dashboardPath = new URL("../ui/dashboard.html", import.meta.url);

test("600px, 800px, and 1000px embedded widths use a one-column non-overlapping flow", async () => {
  const html = await readFile(dashboardPath, "utf8");
  assert.match(html, /data-visual-regression-widths="600 800 1000"/);
  assert.match(html, /@media \(max-width: 1040px\)[\s\S]*?\.plane-map \{ grid-template-columns:1fr; \}/);
  assert.match(html, /@media \(max-width: 1040px\)[\s\S]*?\.row, \.row\.agent-row \{ grid-template-columns:1fr;/);
  assert.match(html, /@media \(max-width: 1040px\)[\s\S]*?\.graph-board \{ display:grid;[^}]*min-width:0;[^}]*height:auto !important;/);
  assert.match(html, /\.plane-help \{[^}]*word-break:keep-all;[^}]*overflow-wrap:break-word;/);
  assert.match(html, /\.plane-state, \.plane-step > \.button-link \{ grid-column:2;/);
  assert.match(html, /\.graph-summary-title strong \{[^}]*word-break:keep-all;[^}]*overflow-wrap:break-word;/);
  assert.match(html, /\.row-actions \{[^}]*flex-wrap:wrap;[^}]*min-width:0;/);
});

test("dashboard renders backend failure, routing, identity, and archive contracts", async () => {
  const html = await readFile(dashboardPath, "utf8");
  assert.match(html, /실패 판정과 다음 조치/);
  assert.match(html, /Routing provenance와 충족 행렬/);
  assert.match(html, /DAEMON SCHEDULER/);
  assert.match(html, /ORCHESTRATOR CODEX SESSION/);
  assert.match(html, /id="archive-scope"/);
  assert.match(html, /callTool\(action === "archive" \? "archive_run" : "unarchive_run"/);
  assert.match(html, /callTool\(action === "archive" \? "archive_agent" : "unarchive_agent"/);
  assert.doesNotMatch(html, /archive[^\n]{0,120}start_agent_run/);
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
  assert.match(html, /unchangedPolls === 0 \? 5_000 : unchangedPolls === 1 \? 10_000 : 30_000/);
  assert.match(html, /if \(standalone \|\| document\.hidden \|\| isTerminalView\(\)\) return;/);
  assert.match(html, /document\.addEventListener\("visibilitychange"/);
  assert.match(html, /window\.addEventListener\("pagehide"/);
});

test("chat links are terminal-only and escape the embedded frame", async () => {
  const html = await readFile(dashboardPath, "utf8");
  assert.match(html, /const terminalStatuses = new Set/);
  assert.match(html, /target="_top" rel="noopener" href="codex:\/\/threads\//);
  assert.match(html, /row\.agent\?\.id && isTerminalStatus\(row\.status\)/);
  assert.match(html, /세션 소유권을 보호하기 위해 채팅 열기가 잠깁니다/);
});
