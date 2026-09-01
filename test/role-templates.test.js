import assert from "node:assert/strict";
import test from "node:test";

import { RoleTemplateManager } from "../src/role-templates.js";

test("unregistered role names never grant write authority", () => {
  const manager = new RoleTemplateManager({ getRoleTemplate: () => null });
  const tester = manager.resolve("e2e-regression-tester");
  assert.equal(tester.sandbox, "read-only");
  assert.deepEqual(tester.tools, []);
  assert.equal(manager.resolve("read-only E2E validator").sandbox, "read-only");
  assert.equal(manager.resolve("unit test runner").sandbox, "read-only");
  assert.equal(manager.resolve("repository-inspector").sandbox, "read-only");
});
