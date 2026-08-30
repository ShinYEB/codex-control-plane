import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";

import { McpDaemonProxy } from "../src/mcp-proxy.js";

test("MCP proxy attaches the native requester thread to dashboard opens", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let observed;
  const client = { call: async (method, params) => {
    observed = { method, params };
    return { ok: true };
  } };
  const proxy = new McpDaemonProxy({ input, output, client, requesterThreadId: "control_thread" });
  const response = new Promise((resolve) => output.once("data", (chunk) => resolve(JSON.parse(chunk.toString()))));
  proxy.start();
  input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "show_agent_dashboard", arguments: { cwd: "/repo" } } })}\n`);
  assert.deepEqual(await response, { jsonrpc: "2.0", id: 1, result: { ok: true } });
  assert.equal(observed.params.arguments.requesterThreadId, "control_thread");
  proxy.close();
});

test("MCP proxy preserves an explicit requester identity", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let observed;
  const proxy = new McpDaemonProxy({
    input,
    output,
    requesterThreadId: "ambient_thread",
    client: { call: async (_method, params) => { observed = params; return {}; } },
  });
  const response = new Promise((resolve) => output.once("data", resolve));
  proxy.start();
  input.write(`${JSON.stringify({ id: 2, method: "tools/call", params: { name: "show_agent_dashboard", arguments: { requesterThreadId: "explicit_thread" } } })}\n`);
  await response;
  assert.equal(observed.arguments.requesterThreadId, "explicit_thread");
  proxy.close();
});
