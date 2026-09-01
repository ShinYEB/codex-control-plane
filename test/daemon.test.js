import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ControlPlaneDaemonClient } from "../src/daemon-client.js";
import { ControlPlaneDaemon } from "../src/daemon.js";
import { McpControlServer } from "../src/mcp-server.js";
import { ControlRegistry } from "../src/registry.js";

function socketRequest(socketPath, path, payload = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const request = httpRequest({ socketPath, path, method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) } }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }));
    });
    request.once("error", reject);
    request.end(body);
  });
}

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
  assert.equal(health.protocolVersion, 2);
  assert.match(health.buildId, /^0\.14\.0\+[a-f0-9]{12}$/);
  assert.match(health.runtimePath, /src\/daemon\.js$/);
  assert.ok(Array.isArray(health.capabilities));
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

test("build handover rejects new work, drains active tasks, and releases the socket for the next daemon", async () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-control-daemon-handover-"));
  const socketPath = join(directory, "control.sock");
  const runningTaskIds = new Set(["active"]);
  const control = { runningTaskIds, activeTaskPromises: new Set(), controlDispatches: new Map(), startBackground() {}, async close() {} };
  const daemon = new ControlPlaneDaemon({ socketPath, control });
  await daemon.start();
  const unauthorized = await socketRequest(socketPath, "/shutdown", { expectedBuildId: "future-build" });
  assert.equal(unauthorized.status, 403);
  assert.equal(unauthorized.body.error.code, "HANDOVER_AUTHORITY_REQUIRED");
  assert.equal((await new ControlPlaneDaemonClient({ socketPath }).health()).ok, true);
  const shutdown = await socketRequest(socketPath, "/shutdown", { expectedBuildId: "future-build", authority: "deployment" });
  assert.equal(shutdown.status, 202);
  assert.equal(shutdown.body.code, "DAEMON_UPGRADE_PENDING");
  const rejected = await socketRequest(socketPath, "/rpc", { method: "ping", params: {} });
  assert.equal(rejected.status, 409);
  runningTaskIds.clear();
  const client = new ControlPlaneDaemonClient({ socketPath });
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline && existsSync(socketPath)) await new Promise((resolve) => setTimeout(resolve, 20));
  await assert.rejects(client.health());

  const replacement = new ControlPlaneDaemon({ socketPath, control: { runningTaskIds: new Set(), activeTaskPromises: new Set(), controlDispatches: new Map(), startBackground() {}, async close() {} } });
  await replacement.start();
  assert.equal((await client.health()).ok, true);
  await replacement.close();
});

test("daemon client reports upgrade_pending instead of reusing a mismatched active build", async () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-control-daemon-mismatch-"));
  const socketPath = join(directory, "control.sock");
  const runningTaskIds = new Set(["active"]);
  const control = { runningTaskIds, activeTaskPromises: new Set(), controlDispatches: new Map(), startBackground() {}, async close() {} };
  const daemon = new ControlPlaneDaemon({ socketPath, control });
  await daemon.start();
  let spawned = false;
  const client = new ControlPlaneDaemonClient({
    socketPath,
    expectedBuildId: "future-build",
    upgradeTimeoutMs: 40,
    allowBuildHandover: true,
    spawnProcess: () => { spawned = true; throw new Error("must not spawn while old build is active"); },
  });
  await assert.rejects(client.ensureStarted(), (error) => error.code === "DAEMON_UPGRADE_PENDING");
  assert.equal(spawned, false);
  const health = await client.health();
  assert.equal(health.draining, true);
  assert.equal(health.targetBuildId, "future-build");
  runningTaskIds.clear();
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline && existsSync(socketPath)) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(existsSync(socketPath), false);
});

test("ordinary stale clients cannot stop or replace a different active build", async () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-control-daemon-stale-client-"));
  const socketPath = join(directory, "control.sock");
  const control = { runningTaskIds: new Set(), activeTaskPromises: new Set(), controlDispatches: new Map(), startBackground() {}, async close() {} };
  const daemon = new ControlPlaneDaemon({ socketPath, control });
  await daemon.start();
  let spawned = false;
  const stale = new ControlPlaneDaemonClient({
    socketPath,
    expectedBuildId: "stale-build",
    spawnProcess: () => { spawned = true; throw new Error("stale client must not spawn"); },
  });
  await assert.rejects(stale.ensureStarted(), (error) => error.code === "CLIENT_UPGRADE_REQUIRED"
    && error.activeIdentity.buildId
    && error.expectedIdentity.buildId === "stale-build");
  assert.equal(spawned, false);
  const relocated = new ControlPlaneDaemonClient({ socketPath, expectedRuntimePath: join(directory, "deleted-cache", "daemon.js") });
  await assert.rejects(relocated.ensureStarted(), (error) => error.code === "CLIENT_UPGRADE_REQUIRED"
    && error.activeIdentity.runtimePath
    && error.expectedIdentity.runtimePath.endsWith("deleted-cache/daemon.js"));
  assert.equal((await new ControlPlaneDaemonClient({ socketPath }).health()).ok, true);
  await daemon.close();
});
