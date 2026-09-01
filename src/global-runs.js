import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { resolve, sep } from "node:path";

import { SANDBOXES, SIDE_EFFECT_POLICIES, TASK_KINDS, WORKSPACE_MODES } from "./execution-contracts.js";

export const GLOBAL_RUN_REVISION_STATUSES = Object.freeze(["building", "validated", "invalid"]);
export const GLOBAL_RUN_MEMBERSHIP_KINDS = Object.freeze(["required", "optional"]);
export const CROSS_PROJECT_DEPENDENCY_CONDITIONS = Object.freeze(["all_success", "all_terminal", "on_failure"]);
export const GLOBAL_RUN_API_VERSION = 1;
export const AUTHORIZATION_MANIFEST_VERSION = 1;
export const CROSS_PROJECT_HANDOFF_SCHEMA_VERSION = 1;
export const CROSS_PROJECT_HANDOFF_STATUSES = Object.freeze(["prepared", "validated", "received", "invalid"]);

const SANDBOX_LEVEL = Object.freeze({ "read-only": 0, "workspace-write": 1, "danger-full-access": 2 });

function contractError(message, code) {
  return Object.assign(new Error(message), { code });
}

function stringArray(value, name, { allowEmpty = true } = {}) {
  if (!Array.isArray(value) || (!allowEmpty && !value.length) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw contractError(`${name} must be ${allowEmpty ? "an" : "a non-empty"} array of non-empty strings`, "GLOBAL_AUTHORIZATION_MANIFEST_INVALID");
  }
  return [...new Set(value)].sort();
}

function inside(root, candidate) {
  const canonical = (value) => {
    try { return realpathSync.native(resolve(value)); }
    catch { return resolve(value); }
  };
  const normalizedRoot = canonical(root);
  const normalizedCandidate = canonical(candidate);
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}${sep}`);
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

export function globalRunFingerprint(value) {
  return createHash("sha256").update(stable(value)).digest("hex");
}

export function authorizationManifestFingerprint(manifest) {
  const { fingerprint: _fingerprint, ...payload } = manifest ?? {};
  return globalRunFingerprint(payload);
}

export function compileAuthorizationManifest(input, scope) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw contractError("Authorization manifest must be an object", "GLOBAL_AUTHORIZATION_MANIFEST_REQUIRED");
  if (input.version !== undefined && input.version !== AUTHORIZATION_MANIFEST_VERSION) throw contractError(`Unsupported authorization manifest version: ${input.version}`, "GLOBAL_AUTHORIZATION_MANIFEST_VERSION_UNSUPPORTED");
  if (input.runId !== scope.runId) throw contractError(`Authorization manifest must be bound to Project Run ${scope.runId}`, "GLOBAL_AUTHORIZATION_RUN_MISMATCH");
  if (input.projectId !== undefined && input.projectId !== scope.project.id) throw contractError(`Authorization manifest project does not match ${scope.project.id}`, "GLOBAL_AUTHORIZATION_PROJECT_MISMATCH");
  const allowedRoots = stringArray(input.allowedRoots, "allowedRoots", { allowEmpty: false }).map((root) => {
    try { return realpathSync.native(resolve(root)); }
    catch { return resolve(root); }
  });
  if (allowedRoots.some((root) => !inside(scope.project.canonicalRoot, root))) throw contractError("Authorization roots cannot escape the canonical project", "GLOBAL_AUTHORIZATION_ROOT_ESCAPE");
  const taskKinds = stringArray(input.taskKinds, "taskKinds", { allowEmpty: false });
  if (taskKinds.some((kind) => !TASK_KINDS.includes(kind))) throw contractError("Authorization manifest contains an unsupported task kind", "GLOBAL_AUTHORIZATION_TASK_KIND_INVALID");
  const sideEffectPolicies = stringArray(input.sideEffectPolicies, "sideEffectPolicies", { allowEmpty: false });
  if (sideEffectPolicies.some((policy) => !SIDE_EFFECT_POLICIES.includes(policy))) throw contractError("Authorization manifest contains an unsupported side-effect policy", "GLOBAL_AUTHORIZATION_SIDE_EFFECT_INVALID");
  const workspaceModes = stringArray(input.workspaceModes, "workspaceModes", { allowEmpty: false });
  if (workspaceModes.some((mode) => !WORKSPACE_MODES.includes(mode))) throw contractError("Authorization manifest contains an unsupported workspace mode", "GLOBAL_AUTHORIZATION_WORKSPACE_MODE_INVALID");
  if (!SANDBOXES.includes(input.sandboxCeiling)) throw contractError(`Unsupported authorization sandbox ceiling: ${input.sandboxCeiling}`, "GLOBAL_AUTHORIZATION_SANDBOX_INVALID");
  if (typeof input.mutatesWorkspace !== "boolean" || typeof input.networkAccess !== "boolean") throw contractError("Authorization manifest mutation and network flags must be boolean", "GLOBAL_AUTHORIZATION_MANIFEST_INVALID");
  const manifest = {
    version: AUTHORIZATION_MANIFEST_VERSION,
    runId: scope.runId,
    projectId: scope.project.id,
    allowedRoots,
    taskKinds,
    mutatesWorkspace: input.mutatesWorkspace,
    sideEffectPolicies,
    sandboxCeiling: input.sandboxCeiling,
    networkAccess: input.networkAccess,
    workspaceModes,
  };
  const fingerprint = authorizationManifestFingerprint(manifest);
  if (input.fingerprint !== undefined && input.fingerprint !== fingerprint) throw contractError("Authorization manifest fingerprint mismatch", "GLOBAL_AUTHORIZATION_FINGERPRINT_MISMATCH");
  for (const task of scope.tasks) {
    const contract = task.metadata?.executionContract ?? task.executionContract;
    const taskCwd = task.cwd ?? scope.cwd;
    if (!allowedRoots.some((root) => inside(root, taskCwd))) throw contractError(`Task ${task.id} is outside its authorized roots`, "GLOBAL_AUTHORIZATION_ROOT_MISMATCH");
    if (!taskKinds.includes(contract.taskKind)) throw contractError(`Task ${task.id} exceeds the authorized task kinds`, "GLOBAL_AUTHORIZATION_TASK_KIND_EXCEEDED");
    if (contract.mutatesWorkspace && !manifest.mutatesWorkspace) throw contractError(`Task ${task.id} exceeds workspace mutation authorization`, "GLOBAL_AUTHORIZATION_MUTATION_EXCEEDED");
    if (!sideEffectPolicies.includes(contract.sideEffectPolicy)) throw contractError(`Task ${task.id} exceeds the authorized side-effect policies`, "GLOBAL_AUTHORIZATION_SIDE_EFFECT_EXCEEDED");
    if (SANDBOX_LEVEL[contract.sandbox] > SANDBOX_LEVEL[manifest.sandboxCeiling]) throw contractError(`Task ${task.id} exceeds the sandbox ceiling`, "GLOBAL_AUTHORIZATION_SANDBOX_EXCEEDED");
    if (contract.networkAccess && !manifest.networkAccess) throw contractError(`Task ${task.id} exceeds network authorization`, "GLOBAL_AUTHORIZATION_NETWORK_EXCEEDED");
    if (!workspaceModes.includes(contract.workspaceMode)) throw contractError(`Task ${task.id} exceeds the authorized workspace modes`, "GLOBAL_AUTHORIZATION_WORKSPACE_MODE_EXCEEDED");
  }
  return Object.freeze({ ...manifest, fingerprint });
}

export function compileAuthorizationManifestSet(inputs, projectRuns) {
  if (!Array.isArray(inputs) || inputs.length !== projectRuns.length) throw contractError("Every Project Run requires exactly one authorization manifest", "GLOBAL_AUTHORIZATION_MANIFEST_REQUIRED");
  const byRun = new Map();
  for (const input of inputs) {
    if (!input?.runId || byRun.has(input.runId)) throw contractError("Authorization manifests require unique Project Run ids", "GLOBAL_AUTHORIZATION_MANIFEST_DUPLICATE");
    byRun.set(input.runId, input);
  }
  const manifests = projectRuns.map((entry) => compileAuthorizationManifest(byRun.get(entry.run.id), {
    runId: entry.run.id, project: entry.project, tasks: entry.tasks, cwd: entry.run.cwd,
  }));
  if (byRun.size !== manifests.length) throw contractError("Authorization manifest references an unknown Project Run", "GLOBAL_AUTHORIZATION_RUN_MISMATCH");
  const fingerprint = globalRunFingerprint({ version: AUTHORIZATION_MANIFEST_VERSION, manifests: manifests.map((manifest) => ({ runId: manifest.runId, projectId: manifest.projectId, fingerprint: manifest.fingerprint })).sort((a, b) => a.runId.localeCompare(b.runId)) });
  return { manifests, fingerprint };
}

export function compileCrossProjectDependency(input) {
  const dependency = {
    id: input.id,
    producerRunId: input.producerRunId,
    consumerRunId: input.consumerRunId,
    condition: input.condition ?? "all_success",
    requiredOutputs: stringArray(input.requiredOutputs ?? [], "requiredOutputs"),
    acceptanceCriteria: stringArray(input.acceptanceCriteria ?? [], "acceptanceCriteria"),
    handoffSchemaVersion: input.handoffSchemaVersion ?? CROSS_PROJECT_HANDOFF_SCHEMA_VERSION,
  };
  if (dependency.handoffSchemaVersion !== CROSS_PROJECT_HANDOFF_SCHEMA_VERSION) throw contractError(`Unsupported cross-project handoff schema version: ${dependency.handoffSchemaVersion}`, "CROSS_PROJECT_HANDOFF_SCHEMA_UNSUPPORTED");
  const fingerprint = globalRunFingerprint(dependency);
  if (input.fingerprint !== undefined && input.fingerprint !== fingerprint) throw contractError("Cross-project dependency fingerprint mismatch", "CROSS_PROJECT_DEPENDENCY_FINGERPRINT_MISMATCH");
  return { ...dependency, fingerprint, metadata: input.metadata ?? {} };
}

export function crossProjectHandoffFingerprint(handoff) {
  return globalRunFingerprint({
    dependencyId: handoff.dependencyId, dependencyFingerprint: handoff.dependencyFingerprint,
    producerRunId: handoff.producerRunId, consumerRunId: handoff.consumerRunId,
    schemaVersion: handoff.schemaVersion, contentHash: handoff.contentHash,
  });
}

export function validateGlobalProjectGraph(projectRuns, dependencies = []) {
  if (!Array.isArray(projectRuns) || !projectRuns.length) throw Object.assign(new Error("Global Run requires at least one Project Run"), { code: "GLOBAL_RUN_PROJECTS_REQUIRED" });
  const ids = new Set();
  for (const entry of projectRuns) {
    if (!entry?.run?.id) throw Object.assign(new Error("Every Global Run project membership requires a Run id"), { code: "GLOBAL_RUN_PROJECT_ID_REQUIRED" });
    if (ids.has(entry.run.id)) throw Object.assign(new Error(`Duplicate Project Run id: ${entry.run.id}`), { code: "GLOBAL_RUN_PROJECT_DUPLICATE" });
    ids.add(entry.run.id);
    if (!GLOBAL_RUN_MEMBERSHIP_KINDS.includes(entry.membership ?? "required")) throw Object.assign(new Error(`Unsupported Global Run membership: ${entry.membership}`), { code: "GLOBAL_RUN_MEMBERSHIP_INVALID" });
  }
  const edges = new Map([...ids].map((id) => [id, []]));
  for (const dependency of dependencies) {
    if (!dependency?.id || !ids.has(dependency.producerRunId) || !ids.has(dependency.consumerRunId)) {
      throw Object.assign(new Error(`Cross-project dependency ${dependency?.id ?? "<missing>"} references an unknown Project Run`), { code: "CROSS_PROJECT_DEPENDENCY_UNKNOWN_RUN" });
    }
    if (dependency.producerRunId === dependency.consumerRunId) throw Object.assign(new Error("Cross-project dependency cannot target its producer"), { code: "CROSS_PROJECT_DEPENDENCY_SELF" });
    if (!CROSS_PROJECT_DEPENDENCY_CONDITIONS.includes(dependency.condition ?? "all_success")) throw Object.assign(new Error(`Unsupported cross-project dependency condition: ${dependency.condition}`), { code: "CROSS_PROJECT_DEPENDENCY_CONDITION_INVALID" });
    edges.get(dependency.producerRunId).push(dependency.consumerRunId);
  }
  const visiting = new Set();
  const visited = new Set();
  const visit = (id) => {
    if (visiting.has(id)) throw Object.assign(new Error(`Cross-project dependency graph contains a cycle at ${id}`), { code: "CROSS_PROJECT_GRAPH_CYCLE" });
    if (visited.has(id)) return;
    visiting.add(id);
    for (const child of edges.get(id)) visit(child);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of ids) visit(id);
  return true;
}

export function fingerprintGlobalProjectGraph(input) {
  return globalRunFingerprint({
    apiVersion: input.apiVersion ?? GLOBAL_RUN_API_VERSION,
    globalRunId: input.globalRunId,
    revision: input.revision,
    contextSnapshotId: input.contextSnapshotId,
    contextSnapshotFingerprint: input.contextSnapshotFingerprint,
    authorizationFingerprint: input.authorizationFingerprint,
    authorizationManifests: (input.authorizationManifests ?? []).map((manifest) => ({ runId: manifest.runId, projectId: manifest.projectId, fingerprint: manifest.fingerprint })).sort((a, b) => a.runId.localeCompare(b.runId)),
    projectRuns: input.projectRuns.map((entry) => ({
      runId: entry.run.id, projectId: entry.run.projectId, membership: entry.membership ?? "required",
      tasks: entry.tasks.map((task) => ({ id: task.id, dependencies: [...new Set(task.dependsOn ?? [])].sort(), contractFingerprint: task.metadata?.executionContract?.fingerprint ?? task.executionContract?.fingerprint ?? null })).sort((a, b) => a.id.localeCompare(b.id)),
    })).sort((a, b) => a.runId.localeCompare(b.runId)),
    dependencies: input.dependencies.map((dependency) => ({
      id: dependency.id, producerRunId: dependency.producerRunId, consumerRunId: dependency.consumerRunId,
      condition: dependency.condition ?? "all_success", requiredOutputs: dependency.requiredOutputs ?? [],
      acceptanceCriteria: dependency.acceptanceCriteria ?? [], handoffSchemaVersion: dependency.handoffSchemaVersion,
      fingerprint: dependency.fingerprint ?? null,
    })).sort((a, b) => a.id.localeCompare(b.id)),
  });
}
