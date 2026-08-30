import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import { fileURLToPath } from "node:url";

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
  }

  async ensureStarted() {
    try {
      await this.health();
      return;
    } catch {}

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
        await this.health();
        return;
      } catch (error) {
        lastError = error;
      }
    }
    throw new Error(`Control-plane daemon did not start: ${lastError?.message ?? "timeout"}`);
  }

  health() {
    return this.#request("GET", "/health", undefined, 1_000);
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
