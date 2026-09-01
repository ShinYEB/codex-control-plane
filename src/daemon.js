#!/usr/bin/env node

import { chmodSync, closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runtimeIdentity } from "./build-info.js";

import { DEFAULT_DAEMON_SOCKET } from "./daemon-client.js";
import { McpControlServer } from "./mcp-server.js";

function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  response.end(body);
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

export class ControlPlaneDaemon {
  constructor(options = {}) {
    this.socketPath = options.socketPath ?? DEFAULT_DAEMON_SOCKET;
    this.lockPath = `${this.socketPath}.lock`;
    this.control = options.control ?? new McpControlServer({ sessionWriter: true });
    this.server = null;
    this.lockOwned = false;
    this.startedAt = null;
    this.draining = false;
    this.drainTargetBuildId = null;
    this.drainTimer = null;
  }

  async start() {
    this.startedAt = new Date().toISOString();
    mkdirSync(dirname(this.socketPath), { recursive: true });
    this.#acquireLock();
    try { unlinkSync(this.socketPath); } catch (error) { if (error.code !== "ENOENT") throw error; }
    this.control.startBackground();
    this.server = createServer((request, response) => void this.#handle(request, response));
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.socketPath, () => {
        this.server.off("error", reject);
        chmodSync(this.socketPath, 0o600);
        resolve();
      });
    });
    return this.socketPath;
  }

  async close() {
    clearInterval(this.drainTimer);
    this.drainTimer = null;
    const server = this.server;
    this.server = null;
    const serverClosed = server ? new Promise((resolve) => server.close(resolve)) : Promise.resolve();
    await this.control.close();
    await serverClosed;
    try { unlinkSync(this.socketPath); } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (this.lockOwned) {
      try { unlinkSync(this.lockPath); } catch (error) { if (error.code !== "ENOENT") throw error; }
      this.lockOwned = false;
    }
  }

  #acquireLock() {
    try {
      const descriptor = openSync(this.lockPath, "wx", 0o600);
      writeFileSync(descriptor, String(process.pid));
      closeSync(descriptor);
      this.lockOwned = true;
      return;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    const pid = Number(readFileSync(this.lockPath, "utf8"));
    if (Number.isInteger(pid) && processExists(pid)) throw new Error(`Control-plane daemon already running (pid ${pid})`);
    unlinkSync(this.lockPath);
    this.#acquireLock();
  }

  async #handle(request, response) {
    const activeTasks = this.#activeTasks();
    if (request.method === "GET" && request.url === "/health") {
      sendJson(response, 200, {
        ok: true,
        pid: process.pid,
        ...runtimeIdentity(fileURLToPath(import.meta.url)),
        startedAt: this.startedAt,
        activeTasks,
        draining: this.draining,
        targetBuildId: this.drainTargetBuildId,
        capabilities: ["execution-contract-v1", "dirty-worktree-snapshot", "artifact-integration", "authorized-build-handover"],
      });
      return;
    }
    if (request.method === "POST" && request.url === "/shutdown") {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      let payload = {};
      try { payload = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}; } catch {}
      if (payload.authority !== "deployment") {
        sendJson(response, 403, { error: { code: "HANDOVER_AUTHORITY_REQUIRED", message: "Daemon handover requires explicit deployment authority" } });
        return;
      }
      if (activeTasks > 0) {
        this.#beginDrain(payload.expectedBuildId ?? null);
        sendJson(response, 202, { ok: true, code: "DAEMON_UPGRADE_PENDING", draining: true, activeTasks, targetBuildId: this.drainTargetBuildId });
        return;
      }
      sendJson(response, 200, { ok: true, draining: true });
      setImmediate(() => void this.close());
      return;
    }
    if (request.method !== "POST" || request.url !== "/rpc") {
      sendJson(response, 404, { error: "Not found" });
      return;
    }
    if (this.draining) {
      sendJson(response, 409, { error: { code: "DAEMON_UPGRADE_PENDING", message: "Daemon is draining and no longer accepts new Control Plane work" } });
      return;
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > 2 * 1024 * 1024) {
        sendJson(response, 413, { error: "Request too large" });
        return;
      }
      chunks.push(chunk);
    }
    try {
      const message = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const result = await this.control.handleRequest({ method: message.method, params: message.params ?? {} });
      sendJson(response, 200, result);
    } catch (error) {
      sendJson(response, 500, { error: { message: error.message, code: error.code ?? -32603 } });
    }
  }

  #activeTasks() {
    return Math.max(this.control.runningTaskIds?.size ?? 0, this.control.activeTaskPromises?.size ?? 0)
      + (this.control.controlDispatches?.size ?? 0)
      + (this.control.runFinalizations?.size ?? 0)
      + (this.control.controlDeliveryFlights?.size ?? 0);
  }

  #beginDrain(targetBuildId) {
    this.draining = true;
    this.drainTargetBuildId = targetBuildId;
    if (this.drainTimer) return;
    this.drainTimer = setInterval(() => {
      if (this.#activeTasks() > 0) return;
      clearInterval(this.drainTimer);
      this.drainTimer = null;
      setImmediate(() => void this.close());
    }, 100);
    this.drainTimer.unref?.();
  }
}

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const daemon = new ControlPlaneDaemon({ socketPath: argument("--socket", DEFAULT_DAEMON_SOCKET) });
  daemon.start().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
  process.once("SIGINT", () => void daemon.close().finally(() => process.exit(0)));
  process.once("SIGTERM", () => void daemon.close().finally(() => process.exit(0)));
}
