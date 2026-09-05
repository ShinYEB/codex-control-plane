import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { workPanelSnapshot } from "./work-panel.js";

const WORK_PANEL_HTML = readFileSync(new URL("../ui/work-progress.html", import.meta.url), "utf8");

import { buildDashboardDelta, buildDashboardSnapshot, getDashboardDetail } from "./dashboard-model.js";

function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  response.end(body);
}

async function readJson(request, limit = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new Error("Request body is too large");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export class DashboardServer {
  constructor(options) {
    this.registry = options.registry;
    this.html = options.html;
    this.onCancel = options.onCancel;
    this.onCleanupWorktree = options.onCleanupWorktree;
    this.onRegisterAgent = options.onRegisterAgent;
    this.onArchiveRun = options.onArchiveRun;
    this.onUnarchiveRun = options.onUnarchiveRun;
    this.onArchiveAgent = options.onArchiveAgent;
    this.onUnarchiveAgent = options.onUnarchiveAgent;
    this.onRepairTask = options.onRepairTask;
    this.getGraph = options.getGraph;
    this.host = options.host ?? "127.0.0.1";
    this.port = options.port ?? 0;
    this.token = options.token ?? randomBytes(24).toString("hex");
    this.ownerId = options.ownerId ?? `dashboard_${process.pid}`;
    this.leaseKey = options.leaseKey ?? "__control_plane_dashboard__";
    this.leaseTtlMs = options.leaseTtlMs ?? 30_000;
    this.lease = null;
    this.leaseTimer = null;
    this.startPromise = null;
    this.server = null;
    this.connections = new Set();
    this.progressViews = new Map();
  }

  async start() {
    if (this.server?.listening) return this.url();
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.#startOnce();
    try {
      return await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  async #startOnce() {
    this.lease = typeof this.registry.acquireDashboardLease === "function"
      ? this.registry.acquireDashboardLease(this.leaseKey, this.ownerId, { ttlMs: this.leaseTtlMs })
      : { token: this.token };
    if (!this.lease) throw new Error("The control-plane dashboard is owned by another live daemon");
    this.server = createServer((request, response) => void this.#handle(request, response));
    try {
      await new Promise((resolve, reject) => {
        this.server.once("error", reject);
        this.server.listen(this.port, this.host, () => {
          this.server.off("error", reject);
          this.server.unref?.();
          resolve();
        });
      });
    } catch (error) {
      this.registry.releaseDashboardLease?.(this.leaseKey, this.ownerId, this.lease.token);
      this.lease = null;
      throw error;
    }
    this.leaseTimer = setInterval(() => {
      const renewed = this.registry.renewDashboardLease?.(this.leaseKey, this.ownerId, this.lease?.token, this.leaseTtlMs);
      if (renewed) this.lease = renewed;
      else void this.close();
    }, Math.max(1_000, Math.floor(this.leaseTtlMs / 3)));
    this.leaseTimer.unref?.();
    return this.url();
  }

  url(options = {}) {
    const address = this.server?.address();
    if (!address || typeof address === "string") return null;
    const url = new URL(`http://${this.host}:${address.port}/`);
    url.searchParams.set("token", this.token);
    if (options.cwd) url.searchParams.set("cwd", options.cwd);
    if (options.runId) url.searchParams.set("runId", options.runId);
    if (options.scope) url.searchParams.set("scope", options.scope);
    return url.toString();
  }

  async close() {
    this.progressViews.clear();
    clearInterval(this.leaseTimer);
    this.leaseTimer = null;
    for (const response of this.connections) response.end();
    this.connections.clear();
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    await new Promise((resolve) => server.close(resolve));
    if (this.lease) this.registry.releaseDashboardLease?.(this.leaseKey, this.ownerId, this.lease.token);
    this.lease = null;
  }

  #authorized(url) {
    return url.searchParams.get("token") === this.token;
  }

  progressUrl(runId) {
    if (!this.registry.getRun(runId)) throw new Error("Work not found");
    const base = this.url();
    if (!base) throw new Error("Work panel server is not running");
    for (const [token, view] of this.progressViews) if (view.expiresAt <= Date.now()) this.progressViews.delete(token);
    let entry = [...this.progressViews].find(([, view]) => view.runId === runId);
    if (!entry) {
      if (this.progressViews.size >= 1000) throw new Error("Too many work panels");
      entry = [randomBytes(24).toString("hex"), { runId, expiresAt: Date.now() + 24 * 60 * 60_000 }];
      this.progressViews.set(...entry);
    }
    const url = new URL("/progress", base);
    url.searchParams.set("viewToken", entry[0]);
    return url.toString();
  }

  #ownsLease() {
    if (typeof this.registry.getDashboardLease !== "function") return true;
    const current = this.registry.getDashboardLease(this.leaseKey);
    return Boolean(current
      && current.ownerId === this.ownerId
      && current.token === this.lease?.token
      && new Date(current.expiresAt).valueOf() > Date.now());
  }

  #snapshot(url) {
    const cwd = url.searchParams.get("cwd") || undefined;
    const requestedRunId = url.searchParams.get("runId") || undefined;
    const scope = url.searchParams.get("scope") || undefined;
    const sinceRevision = url.searchParams.has("sinceRevision") ? Number(url.searchParams.get("sinceRevision")) : null;
    const options = { cwd, runId: requestedRunId, scope, getGraph: this.getGraph };
    return sinceRevision === null
      ? buildDashboardSnapshot(this.registry, options)
      : buildDashboardDelta(this.registry, { ...options, sinceRevision });
  }

  async #handle(request, response) {
    const url = new URL(request.url ?? "/", `http://${this.host}`);
    if (!this.#ownsLease()) {
      sendJson(response, 503, { error: "Dashboard ownership lease was lost; reconnect to the active Control Plane daemon" });
      void this.close();
      return;
    }
    // Run-bound view tokens never authorize the full dashboard or mutations.
    if (["/progress", "/api/progress"].includes(url.pathname)) {
      const view = this.progressViews.get(url.searchParams.get("viewToken"));
      if (!view || view.expiresAt <= Date.now()) return sendJson(response, 403, { error: "현황 패널 연결이 만료됐습니다. 패널을 다시 열어주세요." });
      if (request.method !== "GET") return sendJson(response, 405, { error: "Read-only work panel" });
      const snapshot = workPanelSnapshot(this.registry, view.runId);
      if (!snapshot) return sendJson(response, 404, { error: "작업을 찾을 수 없습니다." });
      if (url.pathname === "/api/progress") return sendJson(response, 200, snapshot);
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer",
        "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'",
      });
      response.end(WORK_PANEL_HTML);
      return;
    }
    if (!this.#authorized(url)) {
      sendJson(response, 403, { error: "Invalid dashboard token" });
      return;
    }

    if (request.method === "GET" && url.pathname === "/") {
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-security-policy": "default-src 'self' 'unsafe-inline'; connect-src 'self'",
      });
      response.end(this.html);
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/snapshot") {
      sendJson(response, 200, this.#snapshot(url));
      return;
    }

    const detailMatch = request.method === "GET" && url.pathname.match(/^\/api\/details\/(agent|task|run|graph|plan|worktree|memory|context_snapshot|global_run)\/([^/]+)$/);
    if (detailMatch) {
      const detail = getDashboardDetail(this.registry, detailMatch[1], decodeURIComponent(detailMatch[2]), { getGraph: this.getGraph });
      if (!detail) sendJson(response, 404, { error: "Dashboard detail not found" });
      else sendJson(response, 200, { entityType: detailMatch[1], detail });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/events") {
      response.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
      });
      response.write("retry: 1000\n\n");
      this.connections.add(response);
      let lastEventId = Number(url.searchParams.get("after") ?? 0);
      let lastHeartbeatAt = Date.now();
      const push = () => {
        const events = this.registry.listEvents({ afterId: lastEventId, limit: 200 });
        if (events.length) {
          lastEventId = events.at(-1).id;
          const deltaUrl = new URL(url);
          deltaUrl.searchParams.set("sinceRevision", String(Number(url.searchParams.get("revision") ?? 0)));
          const delta = this.#snapshot(deltaUrl);
          url.searchParams.set("revision", String(delta.revision));
          response.write(`id: ${lastEventId}\nevent: update\ndata: ${JSON.stringify({ events, delta })}\n\n`);
          lastHeartbeatAt = Date.now();
        } else if (Date.now() - lastHeartbeatAt >= 30_000) {
          response.write(": heartbeat\n\n");
          lastHeartbeatAt = Date.now();
        }
      };
      push();
      // The web fallback has at most one dashboard. A two-second safety read is
      // responsive enough without continuously waking SQLite while idle.
      const timer = setInterval(push, 2_000);
      timer.unref?.();
      request.on("close", () => {
        clearInterval(timer);
        this.connections.delete(response);
      });
      return;
    }

    const cancelMatch = request.method === "POST" && url.pathname.match(/^\/api\/runs\/([^/]+)\/cancel$/);
    if (cancelMatch) {
      try {
        const result = await this.onCancel?.(decodeURIComponent(cancelMatch[1]), { source: "dashboard" });
        sendJson(response, 200, result ?? { cancelled: true });
      } catch (error) {
        sendJson(response, 400, { error: error.message });
      }
      return;
    }

    const repairTaskMatch = request.method === "POST" && url.pathname.match(/^\/api\/tasks\/([^/]+)\/repair$/);
    if (repairTaskMatch) {
      try {
        const body = await readJson(request);
        if (!this.onRepairTask) throw new Error("Task contract repair is not configured");
        const result = await this.onRepairTask({ taskId: decodeURIComponent(repairTaskMatch[1]), ...body }, { source: "dashboard" });
        sendJson(response, 200, result ?? { repaired: true });
      } catch (error) {
        sendJson(response, 400, { error: error.message });
      }
      return;
    }

    const runArchiveMatch = request.method === "POST" && url.pathname.match(/^\/api\/runs\/([^/]+)\/(archive|unarchive)$/);
    if (runArchiveMatch) {
      try {
        const runId = decodeURIComponent(runArchiveMatch[1]);
        const handler = runArchiveMatch[2] === "archive" ? this.onArchiveRun : this.onUnarchiveRun;
        if (!handler) throw new Error(`Run ${runArchiveMatch[2]} is not configured`);
        const result = await handler(runId, { source: "dashboard" });
        sendJson(response, 200, result ?? { archived: runArchiveMatch[2] === "archive" });
      } catch (error) {
        sendJson(response, 400, { error: error.message });
      }
      return;
    }

    const agentArchiveMatch = request.method === "POST" && url.pathname.match(/^\/api\/agents\/([^/]+)\/(archive|unarchive)$/);
    if (agentArchiveMatch) {
      try {
        const agentId = decodeURIComponent(agentArchiveMatch[1]);
        const handler = agentArchiveMatch[2] === "archive" ? this.onArchiveAgent : this.onUnarchiveAgent;
        if (!handler) throw new Error(`Agent ${agentArchiveMatch[2]} is not configured`);
        const result = await handler(agentId, { source: "dashboard" });
        sendJson(response, 200, result ?? { archived: agentArchiveMatch[2] === "archive" });
      } catch (error) {
        sendJson(response, 400, { error: error.message });
      }
      return;
    }


    const cleanupMatch = request.method === "POST" && url.pathname.match(/^\/api\/worktrees\/([^/]+)\/cleanup$/);
    if (cleanupMatch) {
      try {
        const result = await this.onCleanupWorktree?.(decodeURIComponent(cleanupMatch[1]), { source: "dashboard" });
        sendJson(response, 200, result ?? { cleaned: true });
      } catch (error) {
        sendJson(response, 400, { error: error.message });
      }
      return;
    }

    const registerMatch = request.method === "POST" && url.pathname.match(/^\/api\/agents\/([^/]+)\/profile$/);
    if (registerMatch) {
      try {
        const body = await readJson(request);
        const result = await this.onRegisterAgent?.(decodeURIComponent(registerMatch[1]), body, { source: "dashboard" });
        sendJson(response, 200, result ?? { registered: true });
      } catch (error) {
        sendJson(response, 400, { error: error.message });
      }
      return;
    }

    sendJson(response, 404, { error: "Not found" });
  }
}
