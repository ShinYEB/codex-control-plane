import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ControlPlaneDaemonClient } from "../src/daemon-client.js";
import { ControlPlaneDaemon } from "../src/daemon.js";
import { McpControlServer } from "../src/mcp-server.js";
import { ControlRegistry } from "../src/registry.js";

test("daemon serves multiple MCP clients through one durable owner", async () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-control-daemon-"));
  const socketPath = join(directory, "control.sock");
  const control = new McpControlServer({
    registry: new ControlRegistry({ path: ":memory:" }),
    controlFactory: () => ({ client: { close: async () => {} }, control: { connect: async () => {} } }),
    recoverInterruptedTasks: false,
    schedulerConcurrency: 0,
  });
  const daemon = new ControlPlaneDaemon({ socketPath, control });
  await daemon.start();
  const first = new ControlPlaneDaemonClient({ socketPath });
  const second = new ControlPlaneDaemonClient({ socketPath });
  const [health, ping, initialized] = await Promise.all([
    first.health(),
    first.call("ping"),
    second.call("initialize", { protocolVersion: "2025-06-18" }),
  ]);
  assert.equal(health.pid, process.pid);
  assert.deepEqual(ping, {});
  assert.equal(initialized.serverInfo.name, "codex-control-plane");
  await daemon.close();
});

test("daemon drains control tasks before waiting for active HTTP connections to close", async () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-control-daemon-close-"));
  const events = [];
  let finishServerClose;
  const control = { close: async () => { events.push("control.close"); finishServerClose(); } };
  const daemon = new ControlPlaneDaemon({ socketPath: join(directory, "control.sock"), control });
  daemon.server = { close: (callback) => { events.push("server.stop_accepting"); finishServerClose = callback; } };
  await daemon.close();
  assert.deepEqual(events, ["server.stop_accepting", "control.close"]);
});
