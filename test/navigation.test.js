import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { McpControlServer } from "../src/mcp-server.js";
import { ControlRegistry } from "../src/registry.js";

test("default navigation returns host handoff, never a URL or false opened receipt", async () => {
  const server = new McpControlServer({ registry: new ControlRegistry({ path: ":memory:" }), recoverInterruptedTasks: false });
  try {
    const result = await server.openDesktopThread("existing");
    assert.equal(result.navigated, false);
    assert.equal(result.requiresHostNavigation, true);
    assert.deepEqual(result.navigation.arguments, { threadId: "existing" });
    assert.equal(result.navigation.tool, "navigate_to_codex_page");
    assert.equal(result.url, undefined);
  } finally { await server.close(); }
});

test("dashboard click requests host navigation without claiming completion; unknown acknowledgement fails visibly", async () => {
  const html = readFileSync(new URL("../ui/dashboard.html", import.meta.url), "utf8");
  const source = html.slice(html.indexOf("    async function openAgentThread("), html.indexOf("    function bindAgentLinks("));
  const run = new Function("standalone", "state", "callTool", "openaiBridge", "el", "shortId", "navigator", source + '; return openAgentThread("existing");');
  const status = {};
  const sent = [];
  let copied = false;
  const bridge = { sendFollowUpMessage: async request => { sent.push(request); return {}; } };
  const clipboard = { clipboard: { writeText: async () => { copied = true; } } };
  await run(false, { dashboardLeaseToken: "view" }, async () => ({ requiresHostNavigation: true, navigation: { arguments: { threadId: "existing" } } }), bridge, () => status, String, clipboard);
  assert.equal(sent.length, 1);
  assert.match(sent[0].prompt, /navigate_to_codex_page/);
  assert.match(sent[0].prompt, /메시지를 보내거나 실행·재시도하지/);
  assert.equal(status.textContent, "작업 열기를 요청했습니다.");
  assert.equal(copied, false);
  await run(false, { dashboardLeaseToken: "view" }, async () => ({}), bridge, () => status, String, clipboard);
  assert.equal(sent.length, 1);
  assert.equal(copied, true);
  assert.match(status.textContent, /이동 확인을 받지 못했습니다/);
});
