import assert from "node:assert/strict";
import { delimiter, dirname } from "node:path";
import test from "node:test";

import { dataPlaneRuntime, runtimePrompt } from "../src/runtime-environment.js";

test("data-plane runtime prepends the daemon Node binary to App Server PATH", () => {
  const runtime = dataPlaneRuntime({ nodePath: "/runtime/bin/node", env: { PATH: "/usr/bin", CODEX_DATA_PLANE_BIN: `/tools${delimiter}/extra` } });
  assert.deepEqual(runtime.env.PATH.split(delimiter).slice(0, 4), ["/tools", "/extra", "/runtime/bin", "/usr/bin"]);
  assert.equal(runtime.env.CODEX_DATA_PLANE_NODE, "/runtime/bin/node");
  assert.match(runtimePrompt(runtime), /\/runtime\/bin\/node/);
  assert.equal(runtime.pathEntries.includes(dirname(runtime.nodePath)), true);
});
