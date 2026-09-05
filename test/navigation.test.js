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

test("dashboard renders safe direct task links without message or clipboard side effects", () => {
  const html = readFileSync(new URL("../ui/dashboard.html", import.meta.url), "utf8");
  const source = html.slice(html.indexOf("    const threadLink ="), html.indexOf("    const dispatchStage"));
  const render = new Function("escapeHtml", source + "; return threadLink;")(value => String(value).replaceAll("<", "&lt;").replaceAll('"', "&quot;"));
  const id = "01a07084-279e-7fa0-96a7-9937bfb80cc4";
  assert.match(render(id), new RegExp('href="codex://threads/' + id + '"'));
  assert.doesNotMatch(render("javascript:alert(1)"), /href=/);
  assert.doesNotMatch(render(null), /href=/);
  assert.match(render(id, "<unsafe>"), /&lt;unsafe>/);
  assert.doesNotMatch(html, /sendFollowUpMessage|navigator.clipboard/);
});
