#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { ControlPlaneDaemonClient } from "../src/daemon-client.js";

const DEFAULT_CODEX = "/Applications/ChatGPT.app/Contents/Resources/codex";
const IDENTIFIER = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/;

function argument(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

export function validateSelector(plugin, marketplace) {
  if (!IDENTIFIER.test(plugin) || !IDENTIFIER.test(marketplace)) {
    throw new Error(`Unsafe plugin selector: ${plugin}@${marketplace}`);
  }
  return `${plugin}@${marketplace}`;
}

export function evaluateReinstallState({ daemon = null, proxies = [], cacheVersions = [] } = {}) {
  const blockers = [];
  if ((daemon?.activeTasks ?? 0) > 0) blockers.push({ code: "DAEMON_ACTIVE_TASKS", detail: `${daemon.activeTasks} active task(s)` });
  if (daemon?.draining) blockers.push({ code: "DAEMON_ALREADY_DRAINING", detail: `target ${daemon.targetBuildId ?? "unknown"}` });
  if (proxies.length) blockers.push({ code: "LIVE_PLUGIN_PROXIES", detail: `${proxies.length} MCP proxy process(es) still use the installed cache` });
  return {
    safeToReinstall: blockers.length === 0,
    blockers,
    daemon,
    proxies,
    cacheVersions,
    preservedData: ["~/.codex/control-plane/v2/registry.sqlite", "~/.codex/control-plane/worktrees"],
  };
}

export function isCacheBackedProxy(processInfo, cacheRoot) {
  const root = resolve(cacheRoot);
  const prefix = `${root}${sep}`;
  const command = String(processInfo?.command ?? "");
  if (!/mcp-proxy\.js(?:\s|$)/.test(command)) return false;
  if (command.includes(prefix) || command.includes(root)) return true;
  const paths = [processInfo?.cwd, ...(processInfo?.openFiles ?? [])].filter(Boolean).map((path) => resolve(path));
  return paths.some((path) => path === root || path.startsWith(prefix));
}

function cacheVersions(cacheRoot) {
  if (!existsSync(cacheRoot)) return [];
  return readdirSync(cacheRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
}

function processCwd(pid) {
  try {
    const output = execFileSync("/usr/sbin/lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return output.split("\n").find((line) => line.startsWith("n"))?.slice(1) ?? null;
  } catch {
    return null;
  }
}

function processFiles(pid) {
  try {
    const output = execFileSync("/usr/sbin/lsof", ["-a", "-p", String(pid), "-Fn"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return output.split("\n").filter((line) => line.startsWith("n")).map((line) => line.slice(1));
  } catch {
    return [];
  }
}

export function livePluginProxies(cacheRoot) {
  let output = "";
  try { output = execFileSync("/bin/ps", ["-axo", "pid=,command="], { encoding: "utf8" }); } catch { return []; }
  return output.split("\n").flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(.+)$/);
    if (!match || !/mcp-proxy\.js/.test(match[2])) return [];
    const info = { pid: Number(match[1]), cwd: processCwd(Number(match[1])), command: match[2], openFiles: processFiles(Number(match[1])) };
    return isCacheBackedProxy(info, cacheRoot) ? [info] : [];
  });
}

async function daemonHealth(client) {
  try { return await client.health(); } catch (error) {
    if (["ENOENT", "ECONNREFUSED"].includes(error.code)) return null;
    throw error;
  }
}

export async function main() {
  const plugin = argument("--plugin", "codex-agent-control-plane");
  const marketplace = argument("--marketplace", "personal");
  const selector = validateSelector(plugin, marketplace);
  const cacheRoot = resolve(argument("--cache-root", join(homedir(), ".codex", "plugins", "cache", marketplace, plugin)));
  const expectedRoot = resolve(join(homedir(), ".codex", "plugins", "cache", marketplace, plugin));
  if (cacheRoot !== expectedRoot) throw new Error(`Refusing non-canonical cache root: ${cacheRoot}`);
  const client = new ControlPlaneDaemonClient({ allowBuildHandover: true });
  const before = evaluateReinstallState({
    daemon: await daemonHealth(client),
    proxies: livePluginProxies(cacheRoot),
    cacheVersions: cacheVersions(cacheRoot),
  });
  const report = {
    mode: process.argv.includes("--execute") ? "execute" : "dry-run",
    selector,
    cacheRoot,
    ...before,
    requiredOrder: [
      "Wait until daemon activeTasks is 0",
      "Close every Codex conversation/app process using this plugin cache",
      `Run codex plugin remove ${selector}`,
      `Run codex plugin add ${selector}`,
      "Open a new Codex conversation",
    ],
  };
  if (!process.argv.includes("--execute")) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return report;
  }
  if (!before.safeToReinstall) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    throw Object.assign(new Error("Reinstall blocked; resolve every reported blocker and run again"), { code: "REINSTALL_BLOCKED" });
  }
  if (before.daemon) await client.shutdown({ requireIdle: true, wait: true, timeoutMs: 60_000 });
  const codex = resolve(argument("--codex", process.env.CODEX_CLI_PATH ?? DEFAULT_CODEX));
  if (!existsSync(codex)) throw new Error(`Codex CLI not found: ${codex}`);
  execFileSync(codex, ["plugin", "remove", selector, "--json"], { stdio: "inherit" });
  execFileSync(codex, ["plugin", "add", selector], { stdio: "inherit" });
  const afterVersions = cacheVersions(cacheRoot);
  if (afterVersions.length !== 1) throw new Error(`Expected exactly one installed cache generation, found ${afterVersions.length}`);
  const completed = { ...report, completed: true, installedCacheVersions: afterVersions, daemonStopped: Boolean(before.daemon), nextStep: "Open a new Codex conversation" };
  process.stdout.write(`${JSON.stringify(completed, null, 2)}\n`);
  return completed;
}

const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) main().catch((error) => {
  console.error(`${error.code ? `${error.code}: ` : ""}${error.message}`);
  process.exitCode = 1;
});
