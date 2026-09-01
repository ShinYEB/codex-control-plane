import { resolve } from "node:path";

export function assertRuntimeHealth(health, expected) {
  if (!health?.ok) throw Object.assign(new Error("Daemon health check did not report ok"), { code: "RUNTIME_HEALTH_INVALID" });
  if (!health.runtimePath || resolve(health.runtimePath) !== resolve(expected.runtimePath)) {
    throw Object.assign(new Error(`Daemon runtime mismatch: ${health.runtimePath ?? "missing"}`), { code: "RUNTIME_PATH_MISMATCH" });
  }
  if (health.buildId !== expected.buildId) throw Object.assign(new Error(`Daemon build mismatch: expected ${expected.buildId}, received ${health.buildId}`), { code: "RUNTIME_BUILD_MISMATCH" });
  if (expected.protocolVersion !== undefined && health.protocolVersion !== expected.protocolVersion) {
    throw Object.assign(new Error(`Daemon protocol mismatch: expected ${expected.protocolVersion}, received ${health.protocolVersion}`), { code: "RUNTIME_PROTOCOL_MISMATCH" });
  }
  return health;
}
