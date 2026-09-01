import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { request as httpRequest } from "node:http";
import { fileURLToPath } from "node:url";
import { DAEMON_PROTOCOL_VERSION, RUNTIME_BUILD_ID } from "./build-info.js";

export const DEFAULT_DAEMON_SOCKET = join(homedir(), ".codex", "control-plane", "control-plane.sock");

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class ControlPlaneDaemonClient {
  constructor(options = {}) {
    this.socketPath = options.socketPath ?? process.env.CODEX_CONTROL_SOCKET ?? DEFAULT_DAEMON_SOCKET;
    this.daemonPath = options.daemonPath ?? fileURLToPath(new URL("./daemon.js", import.meta.url));
    this.spawnProcess = options.spawnProcess ?? spawn;
    this.startTimeoutMs = options.startTimeoutMs ?? 8_000;
    this.upgradeTimeoutMs = options.upgradeTimeoutMs ?? 30 * 60_000;
    this.expectedBuildId = options.expectedBuildId ?? RUNTIME_BUILD_ID;
    this.expectedProtocolVersion = options.expectedProtocolVersion ?? DAEMON_PROTOCOL_VERSION;
    this.expectedRuntimePath = resolve(options.expectedRuntimePath ?? this.daemonPath);
    // Ordinary MCP proxies observe daemon identity but never replace it.
    // Deployment and reinstall tooling must opt into build handover explicitly.
    this.allowBuildHandover = options.allowBuildHandover ?? false;
  }

  async ensureStarted() {
    try {
      const health = await this.health();
      const identityMatches = health.buildId === this.expectedBuildId
        && health.protocolVersion === this.expectedProtocolVersion
        && health.runtimePath
        && resolve(health.runtimePath) === this.expectedRuntimePath;
      if (identityMatches) return;
      if (!this.allowBuildHandover) {
        const error = new Error(`Control-plane client build ${this.expectedBuildId}/${this.expectedProtocolVersion} does not match active daemon ${health.buildId ?? "legacy"}/${health.protocolVersion ?? "legacy"}; reopen Codex with the installed plugin version`);
        error.code = "CLIENT_UPGRADE_REQUIRED";
        error.expectedIdentity = { buildId: this.expectedBuildId, protocolVersion: this.expectedProtocolVersion, runtimePath: this.expectedRuntimePath };
        error.activeIdentity = health;
        throw error;
      }
      await this.#request("POST", "/shutdown", { expectedBuildId: this.expectedBuildId, authority: "deployment" }, 2_000);
      const deadline = Date.now() + this.upgradeTimeoutMs;
      while (Date.now() < deadline) {
        await delay(100);
        try {
          const draining = await this.health();
          if (draining.buildId === this.expectedBuildId
            && draining.protocolVersion === this.expectedProtocolVersion
            && draining.runtimePath
            && resolve(draining.runtimePath) === this.expectedRuntimePath) return;
        } catch { break; }
      }
      if (Date.now() >= deadline) throw Object.assign(new Error("Timed out waiting for the previous daemon to drain"), { code: "DAEMON_UPGRADE_PENDING" });
    } catch (error) {
      if (["DAEMON_UPGRADE_PENDING", "CLIENT_UPGRADE_REQUIRED"].includes(error.code)) throw error;
    }

    const child = this.spawnProcess(process.execPath, [this.daemonPath, "--socket", this.socketPath], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, CODEX_CONTROL_DAEMON: "1" },
    });
    child.unref?.();

    const deadline = Date.now() + this.startTimeoutMs;
    let lastError;
    while (Date.now() < deadline) {
      await delay(80);
      try {
        const health = await this.health();
        if (health.buildId === this.expectedBuildId
          && health.protocolVersion === this.expectedProtocolVersion
          && health.runtimePath
          && resolve(health.runtimePath) === this.expectedRuntimePath) return;
        lastError = new Error(`Unexpected daemon identity: ${health.buildId ?? "legacy"}/${health.protocolVersion ?? "legacy"}/${health.runtimePath ?? "unknown path"}`);
      } catch (error) {
        lastError = error;
      }
    }
    throw new Error(`Control-plane daemon did not start: ${lastError?.message ?? "timeout"}`);
  }

  health() {
    return this.#request("GET", "/health", undefined, 1_000);
  }

  async shutdown(options = {}) {
    const health = await this.health();
    if (!this.allowBuildHandover) {
      throw Object.assign(new Error("Daemon shutdown requires explicit deployment authority"), { code: "HANDOVER_AUTHORITY_REQUIRED" });
    }
    if (health.activeTasks > 0 && options.requireIdle !== false) {
      throw Object.assign(new Error(`Daemon has ${health.activeTasks} active task(s); wait for drain before reinstall`), { code: "DAEMON_ACTIVE_TASKS", activeTasks: health.activeTasks });
    }
    const result = await this.#request("POST", "/shutdown", {
      expectedBuildId: options.expectedBuildId ?? this.expectedBuildId,
      authority: "deployment",
    }, 2_000);
    if (options.wait === false) return result;
    const deadline = Date.now() + (options.timeoutMs ?? this.upgradeTimeoutMs);
    while (Date.now() < deadline) {
      await delay(100);
      try { await this.health(); } catch { return result; }
    }
    throw Object.assign(new Error("Timed out waiting for daemon shutdown"), { code: "DAEMON_UPGRADE_PENDING" });
  }

  async call(method, params = {}) {
    await this.ensureStarted();
    return this.#request("POST", "/rpc", { method, params });
  }

  #request(method, path, payload, timeoutMs = 30 * 60_000) {
    return new Promise((resolve, reject) => {
      const body = payload === undefined ? null : JSON.stringify(payload);
      const request = httpRequest({
        socketPath: this.socketPath,
        path,
        method,
        headers: body ? {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        } : {},
      }, (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let value;
          try {
            value = text ? JSON.parse(text) : {};
          } catch {
            reject(new Error(`Invalid daemon response: ${text.slice(0, 200)}`));
            return;
          }
          if ((response.statusCode ?? 500) >= 400) {
            const error = new Error(value.error?.message ?? value.error ?? `Daemon HTTP ${response.statusCode}`);
            error.code = value.error?.code;
            reject(error);
            return;
          }
          resolve(value);
        });
      });
      request.once("error", reject);
      request.setTimeout(timeoutMs, () => request.destroy(new Error("Control-plane daemon request timed out")));
      if (body) request.write(body);
      request.end();
    });
  }
}
