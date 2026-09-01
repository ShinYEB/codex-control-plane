import assert from "node:assert/strict";
import test from "node:test";

import { evaluateReinstallState, isCacheBackedProxy, validateSelector } from "../scripts/prepare-reinstall.mjs";
import { assertRuntimeHealth } from "../scripts/runtime-deployment.mjs";

test("reinstall preflight requires an exact safe plugin selector", () => {
  assert.equal(validateSelector("codex-agent-control-plane", "personal"), "codex-agent-control-plane@personal");
  assert.throws(() => validateSelector("../control-plane", "personal"), /Unsafe plugin selector/);
  assert.throws(() => validateSelector("control-plane", "personal;rm"), /Unsafe plugin selector/);
});

test("reinstall is blocked by active work, draining state, or live versioned proxies", () => {
  const state = evaluateReinstallState({
    daemon: { activeTasks: 2, draining: true, targetBuildId: "next" },
    proxies: [{ pid: 10, cwd: "/cache/old" }],
    cacheVersions: ["old", "new"],
  });
  assert.equal(state.safeToReinstall, false);
  assert.deepEqual(state.blockers.map((item) => item.code), ["DAEMON_ACTIVE_TASKS", "DAEMON_ALREADY_DRAINING", "LIVE_PLUGIN_PROXIES"]);
  assert.ok(state.preservedData.every((path) => path.includes("control-plane")));
});

test("idle daemon with no cache-backed proxy is safe and preserves durable state", () => {
  const state = evaluateReinstallState({ daemon: { activeTasks: 0, draining: false }, proxies: [], cacheVersions: ["current"] });
  assert.equal(state.safeToReinstall, true);
  assert.equal(state.blockers.length, 0);
  assert.deepEqual(state.cacheVersions, ["current"]);
  assert.match(state.preservedData[0], /registry\.sqlite/);
});

test("proxy detection follows executable command and open files even when cwd is outside cache", () => {
  const cache = "/Users/test/.codex/plugins/cache/personal/control-plane";
  assert.equal(isCacheBackedProxy({ command: `node ${cache}/1/runtime/src/mcp-proxy.js`, cwd: "/repo" }, cache), true);
  assert.equal(isCacheBackedProxy({ command: "node mcp-proxy.js", cwd: "/repo", openFiles: [`${cache}/1/runtime/src/mcp-proxy.js`] }, cache), true);
  assert.equal(isCacheBackedProxy({ command: "node /repo/src/mcp-proxy.js", cwd: "/repo" }, cache), false);
});

test("runtime deployment verifies path, build, and protocol after deploy or rollback", () => {
  const expected = { runtimePath: "/runtime/src/daemon.js", buildId: "build-1", protocolVersion: 3 };
  assert.equal(assertRuntimeHealth({ ok: true, ...expected }, expected).buildId, "build-1");
  assert.throws(() => assertRuntimeHealth({ ok: true, ...expected, buildId: "wrong" }, expected), { code: "RUNTIME_BUILD_MISMATCH" });
  assert.throws(() => assertRuntimeHealth({ ok: true, ...expected, runtimePath: "/old/daemon.js" }, expected), { code: "RUNTIME_PATH_MISMATCH" });
});
