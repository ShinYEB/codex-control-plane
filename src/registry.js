import { existsSync, mkdirSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { classifyRunNotification, NOTIFICATION_KINDS, normalizeNotificationKind, notificationPresentation } from "./notification-policy.js";
import { assertExecutionContract, compileAndValidateExecutionContract, executionContractFailure } from "./execution-contracts.js";
import { decideTaskRetry } from "./retry-policy.js";
import { canonicalizeProjectIdentity } from "./project-identity.js";
import { assertCanSupersede, contextContentHash, validateContextClaim } from "./context-claims.js";
import { estimateContextHealth, threadBudgetFingerprint, transitionThreadLifecycle, validateThreadBudget } from "./thread-lifecycle.js";
import {
  compileAuthorizationManifestSet,
  compileAuthorizationManifest,
  compileCrossProjectDependency,
  crossProjectHandoffFingerprint,
  fingerprintGlobalProjectGraph,
  globalRunFingerprint,
  GLOBAL_RUN_API_VERSION,
  validateGlobalProjectGraph,
} from "./global-runs.js";
import {
  assertAgentStatus,
  assertDeliveryStatus,
  assertLeaseStatus,
  assertRunStatus,
  assertGlobalRunStatus,
  assertTaskStatus,
  assertTurnDispatchStatus,
  deriveRunStatus,
  deriveGlobalRunStatus,
  FAILED_TASK_STATUSES,
  SUCCESSFUL_TASK_STATUSES,
  TASK_STATUSES,
  TERMINAL_RUN_STATUSES,
  TERMINAL_TASK_STATUSES,
  normalizeAgentStatus,
  transitionAgent,
  transitionDelivery,
  transitionLease,
  transitionRun,
  transitionGlobalRun,
  transitionTask,
  transitionTurnDispatch,
  ACTIVE_TURN_DISPATCH_STATUSES,
  TERMINAL_TURN_DISPATCH_STATUSES,
  TURN_DISPATCH_STATUSES,
} from "./domain-states.js";

const LEGACY_DB_PATH = join(homedir(), ".codex", "control-plane", "registry.sqlite");
const DEFAULT_DB_PATH = join(homedir(), ".codex", "control-plane", "v2", "registry.sqlite");
const CURRENT_SCHEMA_VERSION = 8;

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function migrateLegacyDatabase(targetPath) {
  if (targetPath !== DEFAULT_DB_PATH || existsSync(targetPath) || !existsSync(LEGACY_DB_PATH)) return;
  mkdirSync(dirname(targetPath), { recursive: true });
  const legacy = new DatabaseSync(LEGACY_DB_PATH);
  try {
    legacy.exec(`VACUUM INTO ${sqlString(targetPath)}`);
  } finally {
    legacy.close();
  }
}

function json(value, fallback = null) {
  if (value === undefined) return fallback === null ? null : JSON.stringify(fallback);
  return JSON.stringify(value);
}

function parse(value, fallback) {
  if (value === null || value === undefined || value === "") return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function now() {
  return new Date().toISOString();
}

function normalizedContractSubject(memory) {
  if (memory.subject) return memory.subject;
  if (!["decision", "constraint", "architecture"].includes(memory.kind) || !memory.title) return null;
  return String(memory.title).trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "_").replace(/^_+|_+$/g, "") || null;
}

function memoryClaimAuthority(memory) {
  const contractBearing = ["decision", "constraint", "architecture"].includes(memory.kind);
  if (contractBearing && memory.source === "user" && [null, "authoritative"].includes(memory.authority)) return "user_explicit";
  if (contractBearing && memory.source === "repository" && [null, "primary", "authoritative", "verified"].includes(memory.authority)) return "project_contract";
  if (memory.source === "runtime" && [null, "primary", "verified"].includes(memory.authority)) return "validated_artifact";
  return "legacy_unverified";
}

const ACTIVE_EXECUTION_STATUSES = new Set(["running", "approval_waiting", "agent_done", "validating", "integration_pending"]);

function taskContractMetadata(task, timestamp = now()) {
  const metadata = { ...(task.metadata ?? {}) };
  let contract = metadata.executionContract ?? metadata.execution?.executionContract ?? null;
  if (!contract && !ACTIVE_EXECUTION_STATUSES.has(task.status)) {
    const explicitIntent = ["taskKind", "mutatesWorkspace", "requiredSandbox", "sandbox", "networkAccess",
      "approvalPolicy", "authorizationScope", "sideEffectPolicy", "workspaceMode", "baseRef",
      "integrationStrategy", "outputs", "tools", "executionCapabilities"].some((field) => task[field] !== undefined);
    contract = explicitIntent
      ? compileAndValidateExecutionContract({ ...task, key: task.id })
      : compileAndValidateExecutionContract({ key: task.id, prompt: task.prompt, taskKind: "analysis", mutatesWorkspace: false }, { workspaceMode: "shared" });
  }
  if (!contract) return { ...metadata, contractStatus: "missing", contractValidatedAt: null, contractFingerprint: null };
  try {
    assertExecutionContract(contract);
    return {
      ...metadata,
      executionContract: contract,
      execution: { ...(metadata.execution ?? {}), executionContract: contract },
      contractStatus: "validated",
      contractVersion: contract.version,
      contractFingerprint: contract.fingerprint,
      contractRevision: metadata.contractRevision ?? 1,
      contractValidatedAt: timestamp,
      contractValidationError: null,
    };
  } catch (error) {
    return {
      ...metadata,
      contractStatus: "invalid",
      contractVersion: contract?.version ?? null,
      contractFingerprint: contract?.fingerprint ?? null,
      contractValidatedAt: null,
      contractValidationError: { code: error.code ?? "EXECUTION_CONTRACT_INVALID", cause: error.message },
    };
  }
}

function toTimestamp(value, fallback) {
  if (value === null || value === undefined) return fallback;
  const raw = typeof value === "number" && value < 1e12 ? value * 1000 : value;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.valueOf()) ? String(value) : parsed.toISOString();
}

function normalizeAgent(row) {
  if (!row) return null;
  return {
    id: row.id,
    sessionId: row.session_id ?? row.id,
    projectId: row.project_id ?? null,
    name: row.name,
    cwd: row.cwd,
    model: row.model,
    provider: row.provider,
    status: row.status,
    source: row.source,
    ephemeral: Boolean(row.ephemeral),
    forkedFromId: row.forked_from_id,
    role: row.role,
    capabilities: parse(row.capabilities_json, []),
    summary: row.summary,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastSeenAt: row.last_seen_at,
    lastTaskAt: row.last_task_at,
    archivedAt: row.archived_at ?? null,
    metadata: parse(row.metadata_json, {}),
  };
}

function normalizeTask(row) {
  if (!row) return null;
  return {
    id: row.id,
    runId: row.run_id ?? parse(row.metadata_json, {})?.runId ?? null,
    projectId: row.project_id ?? null,
    status: row.status,
    prompt: row.prompt,
    cwd: row.cwd,
    sourceThreadId: row.source_thread_id,
    agentId: row.agent_id,
    mode: row.mode,
    output: row.output,
    error: row.error,
    turnId: row.turn_id,
    role: row.role,
    requiredCapabilities: parse(row.required_capabilities_json, []),
    routing: parse(row.routing_json, null),
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    updatedAt: row.updated_at,
    workerId: row.worker_id,
    heartbeatAt: row.heartbeat_at,
    attempt: row.attempt ?? 0,
    maxAttempts: row.max_attempts ?? 1,
    retryDelayMs: row.retry_delay_ms ?? 0,
    nextRetryAt: row.next_retry_at,
    claimToken: row.claim_token,
    version: row.version ?? 0,
    dependencies: [],
    metadata: parse(row.metadata_json, {}),
  };
}

function normalizeLease(row) {
  if (!row) return null;
  return {
    key: row.lease_key,
    ownerTaskId: row.owner_task_id,
    ownerAgentId: row.owner_agent_id,
    cwd: row.cwd,
    worktreePath: row.worktree_path,
    status: row.status,
    acquiredAt: row.acquired_at,
    expiresAt: row.expires_at,
    heartbeatAt: row.heartbeat_at,
    releasedAt: row.released_at,
    metadata: parse(row.metadata_json, {}),
  };
}

function normalizeAgentLease(row) {
  if (!row) return null;
  return {
    agentId: row.agent_id,
    ownerTaskId: row.owner_task_id,
    ownerToken: row.owner_token,
    status: row.status,
    acquiredAt: row.acquired_at,
    expiresAt: row.expires_at,
    heartbeatAt: row.heartbeat_at,
    releasedAt: row.released_at,
    metadata: parse(row.metadata_json, {}),
  };
}

function normalizeDashboardLease(row) {
  if (!row) return null;
  return {
    projectKey: row.project_key,
    ownerId: row.owner_id,
    token: row.lease_token,
    acquiredAt: row.acquired_at,
    heartbeatAt: row.heartbeat_at,
    expiresAt: row.expires_at,
  };
}

function normalizeRun(row) {
  if (!row) return null;
  return {
    id: row.id,
    requestKey: row.request_key ?? null,
    planId: row.plan_id ?? null,
    name: row.name,
    status: row.status,
    cwd: row.cwd,
    projectId: row.project_id ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    archivedAt: row.archived_at ?? null,
    metadata: parse(row.metadata_json, {}),
  };
}

function normalizeGlobalRun(row) {
  if (!row) return null;
  return {
    id: row.id, requestKey: row.request_key ?? null, objective: row.objective,
    status: row.status, currentRevision: row.current_revision ?? null,
    cancellationRequestedAt: row.cancellation_requested_at ?? null,
    origin: parse(row.origin_json, {}), createdAt: row.created_at, updatedAt: row.updated_at,
    completedAt: row.completed_at ?? null, metadata: parse(row.metadata_json, {}),
  };
}

function normalizeGlobalRunRevision(row) {
  if (!row) return null;
  return {
    id: row.id, globalRunId: row.global_run_id, revision: row.revision,
    status: row.status, contextSnapshotId: row.context_snapshot_id,
    contextSnapshotFingerprint: row.context_snapshot_fingerprint,
    authorizationFingerprint: row.authorization_fingerprint,
    graphFingerprint: row.graph_fingerprint, createdAt: row.created_at,
    validatedAt: row.validated_at ?? null, metadata: parse(row.metadata_json, {}),
  };
}

function normalizeGlobalRunProject(row) {
  if (!row) return null;
  return {
    revisionId: row.revision_id, globalRunId: row.global_run_id, runId: row.run_id,
    projectId: row.project_id, membership: row.membership,
    createdAt: row.created_at, metadata: parse(row.metadata_json, {}),
  };
}

function normalizeCrossProjectDependency(row) {
  if (!row) return null;
  return {
    id: row.id, revisionId: row.revision_id, producerRunId: row.producer_run_id,
    consumerRunId: row.consumer_run_id, condition: row.condition, status: row.status,
    fingerprint: row.fingerprint, createdAt: row.created_at, satisfiedAt: row.satisfied_at ?? null,
    requiredOutputs: parse(row.required_outputs_json, []), acceptanceCriteria: parse(row.acceptance_criteria_json, []),
    handoffSchemaVersion: row.handoff_schema_version ?? 1,
    metadata: parse(row.metadata_json, {}),
  };
}

function normalizeAuthorizationManifest(row) {
  if (!row) return null;
  return {
    id: row.id, revisionId: row.revision_id, runId: row.run_id, projectId: row.project_id,
    version: row.version, fingerprint: row.fingerprint, manifest: parse(row.manifest_json, {}),
    createdAt: row.created_at,
  };
}

function normalizeCrossProjectHandoff(row) {
  if (!row) return null;
  return {
    id: row.id, dependencyId: row.dependency_id, revisionId: row.revision_id,
    producerRunId: row.producer_run_id, consumerRunId: row.consumer_run_id,
    schemaVersion: row.schema_version, status: row.status,
    dependencyFingerprint: row.dependency_fingerprint, fingerprint: row.fingerprint,
    contentHash: row.content_hash, receiptHash: row.receipt_hash ?? null,
    payload: parse(row.payload_json, {}), validation: parse(row.validation_json, null),
    preparedAt: row.prepared_at, validatedAt: row.validated_at ?? null,
    receivedAt: row.received_at ?? null, metadata: parse(row.metadata_json, {}),
  };
}

function normalizeThreadBudget(row) {
  if (!row) return null;
  return {
    id: row.id, projectId: row.project_id ?? null, role: row.role_scope === "*" ? null : row.role_scope,
    version: row.version, status: row.status, fingerprint: row.fingerprint,
    policy: parse(row.policy_json, {}), createdAt: row.created_at, supersededAt: row.superseded_at ?? null,
  };
}

function normalizeThreadLifecycle(row) {
  if (!row) return null;
  return {
    threadId: row.thread_id, projectId: row.project_id ?? null, role: row.role ?? null,
    threadType: row.thread_type, status: row.status, contextHealth: row.context_health,
    snapshotId: row.snapshot_id ?? null, successorThreadId: row.successor_thread_id ?? null,
    policyVersion: row.policy_version, createdAt: row.created_at, updatedAt: row.updated_at,
    metadata: parse(row.metadata_json, {}),
  };
}

function normalizeQueueItem(row) {
  if (!row) return null;
  return {
    id: row.id, projectKey: row.project_key, runId: row.run_id, cwd: row.cwd,
    status: row.status, sequence: row.sequence, leaseOwner: row.lease_owner,
    leaseToken: row.lease_token, leaseExpiresAt: row.lease_expires_at,
    attempt: row.attempt, maxAttempts: row.max_attempts, notBefore: row.not_before,
    lastError: row.last_error, payload: parse(row.payload_json, {}),
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

function normalizeNotification(row) {
  if (!row) return null;
  const kind = normalizeNotificationKind(row.kind);
  return {
    id: row.id, projectKey: row.project_key, runId: row.run_id, taskId: row.task_id,
    kind, severity: notificationPresentation(kind).severity, title: row.title, body: row.body,
    dedupeKey: row.dedupe_key, createdAt: row.created_at,
    readAt: row.read_at ?? null, unread: !row.read_at,
    metadata: parse(row.metadata_json, {}),
  };
}

function normalizeRunResult(row) {
  if (!row) return null;
  return {
    runId: row.run_id, status: row.status, summary: row.summary,
    taskResults: parse(row.task_results_json, []), validation: parse(row.validation_json, []),
    artifacts: parse(row.artifacts_json, []), unresolvedRisks: parse(row.unresolved_risks_json, []),
    synthesisStatus: row.synthesis_status, synthesis: parse(row.synthesis_json, null),
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

function normalizeControlDelivery(row) {
  if (!row) return null;
  return {
    id: row.id,
    deliveryKey: row.delivery_key,
    runId: row.run_id,
    originThreadId: row.origin_thread_id,
    originTurnId: row.origin_turn_id ?? null,
    status: row.status,
    payload: parse(row.payload_json, {}),
    attempt: row.attempt ?? 0,
    maxAttempts: row.max_attempts ?? 20,
    notBefore: row.not_before ?? null,
    lastError: row.last_error ?? null,
    deliveredTurnId: row.delivered_turn_id ?? null,
    deliveryMethod: row.delivery_method ?? null,
    directDeliveredAt: row.direct_delivered_at ?? null,
    acknowledgedAt: row.acknowledged_at ?? null,
    acknowledgedTurnId: row.acknowledged_turn_id ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deliveredAt: row.delivered_at ?? null,
  };
}

function normalizeMemory(row) {
  if (!row) return null;
  const metadata = parse(row.metadata_json, {});
  return {
    id: row.id,
    cwd: row.cwd,
    projectId: row.project_id ?? null,
    kind: row.kind,
    title: row.title,
    content: row.content,
    tags: parse(row.tags_json, []),
    source: row.source,
    authority: row.authority ?? metadata.authority ?? (row.source === "agent" ? "reference" : "authoritative"),
    subject: row.subject ?? metadata.subject ?? ((row.semantic_version ?? metadata.semanticVersion) && row.title ? String(row.title).trim().toLowerCase() : null),
    semanticVersion: row.semantic_version ?? metadata.semanticVersion ?? null,
    supersedes: parse(row.supersedes_json, metadata.supersedes ?? []),
    confidence: row.confidence,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastUsedAt: row.last_used_at,
    metadata,
  };
}

function normalizeProject(row) {
  if (!row) return null;
  return {
    id: row.id,
    canonicalKey: row.canonical_key,
    kind: row.kind,
    canonicalRoot: row.canonical_root,
    repositoryCommonDir: row.repository_common_dir ?? null,
    identityVersion: row.identity_version,
    displayName: row.display_name ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    metadata: parse(row.metadata_json, {}),
  };
}

function normalizeContextClaim(row) {
  if (!row) return null;
  return {
    id: row.id,
    projectId: row.project_id ?? null,
    kind: row.kind,
    subject: row.subject ?? null,
    body: row.body,
    scope: row.scope,
    authority: row.authority,
    status: row.status,
    revision: row.revision,
    contentHash: row.content_hash,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    metadata: parse(row.metadata_json, {}),
  };
}

function normalizeContextSnapshot(row) {
  if (!row) return null;
  return {
    id: row.id, resolutionKey: row.resolution_key, projectId: row.project_id ?? null,
    objectiveHash: row.objective_hash, requestedScopeHash: row.requested_scope_hash,
    resolverVersion: row.resolver_version, revision: row.revision, status: row.status,
    fingerprint: row.fingerprint ?? null, error: parse(row.error_json, null),
    createdAt: row.created_at, validatedAt: row.validated_at ?? null,
    metadata: parse(row.metadata_json, {}),
  };
}

function normalizeContextConflict(row) {
  if (!row) return null;
  return {
    id: row.id, projectId: row.project_id ?? null, subject: row.subject, scope: row.scope,
    category: row.category, blocking: Boolean(row.blocking), status: row.status,
    claimIds: parse(row.claim_ids_json, []), fingerprint: row.fingerprint,
    resolution: parse(row.resolution_json, null), createdAt: row.created_at,
    resolvedAt: row.resolved_at ?? null,
  };
}

function normalizeMigrationAttention(row) {
  if (!row) return null;
  return {
    id: row.id,
    kind: row.kind,
    sourceTable: row.source_table,
    sourceId: row.source_id,
    sourceValue: row.source_value,
    status: row.status,
    cause: row.cause,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at ?? null,
    metadata: parse(row.metadata_json, {}),
  };
}

function normalizeThreadKnowledgeSnapshot(row) {
  if (!row) return null;
  return {
    id: row.id,
    threadId: row.thread_id,
    throughTurnId: row.through_turn_id ?? null,
    projectId: row.project_id ?? null,
    role: row.role ?? null,
    topics: parse(row.topics_json, []),
    sourceDigest: row.source_digest,
    extractorVersion: row.extractor_version,
    status: row.status,
    createdAt: row.created_at,
    metadata: parse(row.metadata_json, {}),
  };
}

function normalizeThreadLineage(row) {
  if (!row) return null;
  return {
    threadId: row.thread_id,
    parentThreadId: row.parent_thread_id,
    relationship: row.relationship,
    inheritedSnapshotId: row.inherited_snapshot_id ?? null,
    createdAt: row.created_at,
    metadata: parse(row.metadata_json, {}),
  };
}

function normalizeRoutingDecision(row) {
  if (!row) return null;
  return {
    id: row.id,
    taskId: row.task_id ?? null,
    runId: row.run_id ?? null,
    projectId: row.project_id ?? null,
    contextSnapshotId: row.context_snapshot_id ?? null,
    decision: row.decision,
    selectedAgentId: row.selected_agent_id ?? null,
    candidates: parse(row.candidates_json, []),
    evidence: parse(row.evidence_json, []),
    rejectionReasons: parse(row.rejection_reasons_json, []),
    provenance: parse(row.provenance_json, {}),
    fingerprint: row.fingerprint,
    createdAt: row.created_at,
  };
}

function normalizeTurnDispatch(row) {
  if (!row) return null;
  return {
    id: row.id,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    purpose: row.purpose,
    revision: row.revision,
    parentRunId: row.parent_run_id ?? null,
    parentTaskId: row.parent_task_id ?? null,
    planId: row.plan_id ?? null,
    status: row.status,
    promptFingerprint: row.prompt_fingerprint,
    executionContractFingerprint: row.execution_contract_fingerprint ?? null,
    contextSnapshotId: row.context_snapshot_id ?? null,
    threadId: row.thread_id ?? null,
    agentId: row.agent_id ?? null,
    threadAction: row.thread_action ?? null,
    submissionKey: row.submission_key,
    turnId: row.turn_id ?? null,
    turnStatus: row.turn_status ?? null,
    ownerInstanceId: row.owner_instance_id ?? null,
    ownerToken: row.owner_token ?? null,
    heartbeatAt: row.heartbeat_at ?? null,
    leaseExpiresAt: row.lease_expires_at ?? null,
    cancellationGeneration: row.cancellation_generation,
    cancelRequestedAt: row.cancel_requested_at ?? null,
    deadlineAt: row.deadline_at,
    startedAt: row.started_at ?? null,
    terminalAt: row.terminal_at ?? null,
    lastProbeAt: row.last_probe_at ?? null,
    probeCount: row.probe_count,
    reconciliationDecision: row.reconciliation_decision ?? null,
    failure: parse(row.failure_json, null),
    evidence: parse(row.evidence_json, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: row.version,
  };
}

function normalizePlan(row) {
  if (!row) return null;
  return {
    id: row.id,
    requestKey: row.request_key,
    objective: row.objective,
    cwd: row.cwd,
    projectId: row.project_id ?? null,
    status: row.status,
    version: row.version,
    plannerAgentId: row.planner_agent_id,
    plan: parse(row.plan_json, null),
    synthesis: parse(row.synthesis_json, null),
    feedback: row.feedback,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
    metadata: parse(row.metadata_json, {}),
  };
}

function normalizeApproval(row) {
  if (!row) return null;
  return {
    id: row.id,
    taskId: row.task_id,
    agentId: row.agent_id,
    threadId: row.thread_id,
    turnId: row.turn_id,
    method: row.method,
    status: row.status,
    request: parse(row.request_json, {}),
    decision: row.decision,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
    expiresAt: row.expires_at,
    metadata: parse(row.metadata_json, {}),
  };
}

function normalizeManagedWorktree(row) {
  if (!row) return null;
  return {
    id: row.id,
    repoRoot: row.repo_root,
    path: row.path,
    branch: row.branch,
    baseRef: row.base_ref,
    status: row.status,
    ownerTaskId: row.owner_task_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    removedAt: row.removed_at,
    metadata: parse(row.metadata_json, {}),
  };
}

function normalizeIntegrationJournal(row) {
  if (!row) return null;
  return {
    id: row.id,
    journalKey: row.journal_key,
    worktreeId: row.worktree_id,
    taskId: row.task_id,
    repoRoot: row.repo_root,
    strategy: row.strategy,
    status: row.status,
    artifact: parse(row.artifact_json, {}),
    evidence: parse(row.evidence_json, null),
    lastError: row.last_error ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    appliedAt: row.applied_at ?? null,
    recordedAt: row.recorded_at ?? null,
  };
}

function normalizeRoleTemplate(row) {
  if (!row) return null;
  return {
    name: row.name,
    description: row.description,
    developerInstructions: row.developer_instructions,
    capabilities: parse(row.capabilities_json, []),
    tools: parse(row.tools_json, []),
    skills: parse(row.skills_json, []),
    model: row.model,
    effort: row.effort,
    sandbox: row.sandbox,
    approvalPolicy: row.approval_policy,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    metadata: parse(row.metadata_json, {}),
  };
}

function addCwdScope(clauses, values, column, cwd) {
  clauses.push(`(${column} = ? OR ${column} LIKE ? || '/%' OR ? LIKE ${column} || '/%')`);
  values.push(cwd, cwd, cwd);
}

function validateTaskGraph(tasks) {
  if (!Array.isArray(tasks) || !tasks.length) throw new Error("Task graph requires at least one task");
  const byId = new Map();
  for (const task of tasks) {
    if (!task?.id || !task?.prompt) throw new Error("Every graph task requires id and prompt");
    if (byId.has(task.id)) throw new Error(`Duplicate graph task id: ${task.id}`);
    byId.set(task.id, task);
  }
  for (const task of tasks) {
    for (const dependencyId of task.dependsOn ?? []) {
      if (!byId.has(dependencyId)) throw new Error(`Unknown graph dependency: ${dependencyId}`);
      if (dependencyId === task.id) throw new Error(`Task cannot depend on itself: ${task.id}`);
    }
  }
  const visiting = new Set();
  const visited = new Set();
  const visit = (taskId) => {
    if (visiting.has(taskId)) throw new Error(`Task graph contains a cycle at ${taskId}`);
    if (visited.has(taskId)) return;
    visiting.add(taskId);
    for (const dependencyId of byId.get(taskId).dependsOn ?? []) visit(dependencyId);
    visiting.delete(taskId);
    visited.add(taskId);
  };
  for (const task of tasks) visit(task.id);
}

export class ControlRegistry {
  constructor(options = {}) {
    this.path = options.path ?? process.env.CODEX_CONTROL_DB ?? DEFAULT_DB_PATH;
    if (this.path !== ":memory:") mkdirSync(dirname(this.path), { recursive: true });
    if (!options.database) migrateLegacyDatabase(this.path);
    this.db = options.database ?? new DatabaseSync(this.path);
    this.schemaVersionBeforeMigration = Number(this.db.prepare("PRAGMA user_version").get().user_version ?? 0);
    this.migrationBackupPath = this.#backupBeforeMigration();
    this.#migrate();
    this.schemaVersion = Number(this.db.prepare("PRAGMA user_version").get().user_version ?? 0);
    this.globalRefreshes = new Set();
  }

  close() {
    if (!this.closed) {
      this.db.close();
      this.closed = true;
    }
  }

  createTurnDispatch(input) {
    if (!input?.subjectType || !input?.subjectId || !input?.purpose) throw new TypeError("TurnDispatch subjectType, subjectId, and purpose are required");
    if (!input.promptFingerprint || !input.submissionKey) throw new TypeError("TurnDispatch promptFingerprint and submissionKey are required");
    const status = input.status ?? "prepared";
    assertTurnDispatchStatus(status);
    const timestamp = now();
    const id = input.id ?? `dispatch_${randomUUID()}`;
    const revision = Number(input.revision ?? 1);
    this.db.prepare(`
      INSERT INTO turn_dispatches (
        id, subject_type, subject_id, purpose, revision, parent_run_id, parent_task_id, plan_id,
        status, prompt_fingerprint, execution_contract_fingerprint, context_snapshot_id,
        thread_id, agent_id, thread_action, submission_key, turn_id, turn_status,
        owner_instance_id, owner_token, heartbeat_at, lease_expires_at,
        cancellation_generation, cancel_requested_at, deadline_at, started_at, terminal_at,
        last_probe_at, probe_count, reconciliation_decision, failure_json, evidence_json,
        created_at, updated_at, version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
      ON CONFLICT(subject_type, subject_id, purpose, revision) DO NOTHING
    `).run(
      id, input.subjectType, input.subjectId, input.purpose, revision,
      input.parentRunId ?? null, input.parentTaskId ?? null, input.planId ?? null,
      status, input.promptFingerprint, input.executionContractFingerprint ?? null, input.contextSnapshotId ?? null,
      input.threadId ?? null, input.agentId ?? null, input.threadAction ?? null, input.submissionKey,
      input.turnId ?? null, input.turnStatus ?? null, input.ownerInstanceId ?? null, input.ownerToken ?? null,
      input.heartbeatAt ?? null, input.leaseExpiresAt ?? null, Number(input.cancellationGeneration ?? 0),
      input.cancelRequestedAt ?? null, input.deadlineAt ?? new Date(Date.now() + 30 * 60_000).toISOString(),
      input.startedAt ?? null, input.terminalAt ?? null, input.lastProbeAt ?? null, Number(input.probeCount ?? 0),
      input.reconciliationDecision ?? null, json(input.failure), json(input.evidence, {}), timestamp, timestamp,
    );
    const dispatch = this.db.prepare(`
      SELECT * FROM turn_dispatches WHERE subject_type = ? AND subject_id = ? AND purpose = ? AND revision = ?
    `).get(input.subjectType, input.subjectId, input.purpose, revision);
    return normalizeTurnDispatch(dispatch);
  }

  getTurnDispatch(id) {
    return normalizeTurnDispatch(this.db.prepare("SELECT * FROM turn_dispatches WHERE id = ?").get(id));
  }

  listTurnDispatches(options = {}) {
    const clauses = [];
    const values = [];
    for (const [field, column] of [["subjectType", "subject_type"], ["subjectId", "subject_id"], ["purpose", "purpose"], ["status", "status"], ["parentRunId", "parent_run_id"], ["parentTaskId", "parent_task_id"], ["planId", "plan_id"], ["threadId", "thread_id"]]) {
      if (options[field] !== undefined) { clauses.push(`${column} = ?`); values.push(options[field]); }
    }
    if (options.active === true) clauses.push(`status IN (${[...ACTIVE_TURN_DISPATCH_STATUSES].map(sqlString).join(", ")})`);
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    values.push(options.limit ?? 200);
    return this.db.prepare(`SELECT * FROM turn_dispatches ${where} ORDER BY created_at DESC LIMIT ?`).all(...values).map(normalizeTurnDispatch);
  }

  claimTurnDispatch(id, ownerInstanceId, ttlMs = 120_000, options = {}) {
    const dispatch = this.getTurnDispatch(id);
    if (!dispatch || TERMINAL_TURN_DISPATCH_STATUSES.has(dispatch.status)) return null;
    if (!options.forceRecovery && dispatch.ownerInstanceId === ownerInstanceId && dispatch.ownerToken
      && (!dispatch.leaseExpiresAt || new Date(dispatch.leaseExpiresAt).valueOf() > Date.now())) {
      return dispatch;
    }
    const timestamp = now();
    const token = randomUUID();
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();
    const row = this.db.prepare(`
      UPDATE turn_dispatches
      SET owner_instance_id = ?, owner_token = ?, heartbeat_at = ?, lease_expires_at = ?, updated_at = ?, version = version + 1
      WHERE id = ? AND status IN (${[...ACTIVE_TURN_DISPATCH_STATUSES].map(sqlString).join(", ")})
        AND (owner_token IS NULL OR lease_expires_at IS NULL OR lease_expires_at <= ? OR owner_instance_id = ? OR ? = 1)
      RETURNING *
    `).get(ownerInstanceId, token, timestamp, expiresAt, timestamp, id, timestamp, ownerInstanceId, options.forceRecovery ? 1 : 0);
    if (!row) return null;
    this.recordEvent("turn_dispatch", id, "turn_dispatch.claimed", { ownerInstanceId, ownerToken: token, expiresAt });
    return normalizeTurnDispatch(row);
  }

  transitionTurnDispatch(id, status, changes = {}, options = {}) {
    const existing = this.getTurnDispatch(id);
    if (!existing) throw new Error(`TurnDispatch not found: ${id}`);
    transitionTurnDispatch(existing.status, status, options.transitionOptions ?? {});
    if (options.ownerToken && existing.ownerToken !== options.ownerToken) return null;
    if (options.cancellationGeneration !== undefined && existing.cancellationGeneration !== options.cancellationGeneration) return null;
    const timestamp = now();
    const terminalAt = TERMINAL_TURN_DISPATCH_STATUSES.has(status) ? changes.terminalAt ?? timestamp : existing.terminalAt;
    const row = this.db.prepare(`
      UPDATE turn_dispatches SET
        status = ?, thread_id = ?, agent_id = ?, thread_action = ?, turn_id = ?, turn_status = ?,
        heartbeat_at = ?, lease_expires_at = ?, cancel_requested_at = ?, deadline_at = ?,
        started_at = ?, terminal_at = ?, last_probe_at = ?, probe_count = ?, reconciliation_decision = ?,
        failure_json = ?, evidence_json = ?, updated_at = ?, version = version + 1
      WHERE id = ? AND version = ?
        AND (? IS NULL OR owner_token = ?)
        AND (? IS NULL OR cancellation_generation = ?)
      RETURNING *
    `).get(
      status, changes.threadId ?? existing.threadId, changes.agentId ?? existing.agentId,
      changes.threadAction ?? existing.threadAction, changes.turnId ?? existing.turnId,
      changes.turnStatus ?? existing.turnStatus, changes.heartbeatAt ?? existing.heartbeatAt,
      changes.leaseExpiresAt ?? existing.leaseExpiresAt, changes.cancelRequestedAt ?? existing.cancelRequestedAt,
      changes.deadlineAt ?? existing.deadlineAt, changes.startedAt ?? existing.startedAt, terminalAt,
      changes.lastProbeAt ?? existing.lastProbeAt, changes.probeCount ?? existing.probeCount,
      changes.reconciliationDecision ?? existing.reconciliationDecision, json(changes.failure ?? existing.failure),
      json({ ...existing.evidence, ...(changes.evidence ?? {}) }, {}), timestamp, id, existing.version,
      options.ownerToken ?? null, options.ownerToken ?? null,
      options.cancellationGeneration ?? null, options.cancellationGeneration ?? null,
    );
    if (!row) return null;
    this.recordEvent("turn_dispatch", id, `turn_dispatch.${status}`, {
      previousStatus: existing.status, threadId: row.thread_id ?? null, turnId: row.turn_id ?? null,
    });
    return normalizeTurnDispatch(row);
  }

  heartbeatTurnDispatch(id, ownerInstanceId, ownerToken, ttlMs = 120_000) {
    const timestamp = now();
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();
    const row = this.db.prepare(`
      UPDATE turn_dispatches SET heartbeat_at = ?, lease_expires_at = ?, updated_at = ?, version = version + 1
      WHERE id = ? AND owner_instance_id = ? AND owner_token = ?
        AND status IN (${[...ACTIVE_TURN_DISPATCH_STATUSES].map(sqlString).join(", ")})
      RETURNING *
    `).get(timestamp, expiresAt, timestamp, id, ownerInstanceId, ownerToken);
    return normalizeTurnDispatch(row);
  }

  requestTurnDispatchCancellation(options = {}) {
    const clauses = [`status IN (${[...ACTIVE_TURN_DISPATCH_STATUSES].map(sqlString).join(", ")})`];
    const values = [];
    if (options.parentRunId) { clauses.push("parent_run_id = ?"); values.push(options.parentRunId); }
    if (options.parentTaskId) { clauses.push("parent_task_id = ?"); values.push(options.parentTaskId); }
    if (options.planId) { clauses.push("plan_id = ?"); values.push(options.planId); }
    if (clauses.length === 1) throw new TypeError("TurnDispatch cancellation requires a parent identifier");
    const timestamp = now();
    const rows = this.db.prepare(`SELECT * FROM turn_dispatches WHERE ${clauses.join(" AND ")}`).all(...values).map(normalizeTurnDispatch);
    const cancelled = [];
    for (const dispatch of rows) {
      const row = this.db.prepare(`
        UPDATE turn_dispatches SET status = 'cancelling', cancellation_generation = cancellation_generation + 1,
          cancel_requested_at = ?, updated_at = ?, version = version + 1
        WHERE id = ? AND version = ?
        RETURNING *
      `).get(timestamp, timestamp, dispatch.id, dispatch.version);
      if (row) {
        this.recordEvent("turn_dispatch", dispatch.id, "turn_dispatch.cancelling", { previousStatus: dispatch.status });
        cancelled.push(normalizeTurnDispatch(row));
      }
    }
    return cancelled;
  }

  recoverInterruptedTasks(options = {}) {
    const timestamp = now();
    const staleBefore = options.staleBefore ?? null;
    const rows = this.db.prepare(`
      SELECT * FROM tasks
      WHERE status IN ('running', 'approval_waiting', 'agent_done', 'validating', 'integration_pending')
        AND (? IS NULL OR COALESCE(heartbeat_at, updated_at, created_at) < ?)
        AND (? IS NULL OR worker_id = ?)
        AND (? IS NULL OR id = ?)
    `).all(staleBefore, staleBefore, options.workerId ?? null, options.workerId ?? null, options.taskId ?? null, options.taskId ?? null).map(normalizeTask);
    const update = this.db.prepare(`
      UPDATE tasks
      SET status = ?, error = ?, worker_id = NULL, claim_token = NULL, turn_id = NULL,
          next_retry_at = NULL, heartbeat_at = NULL, updated_at = ?, version = version + 1,
          metadata_json = ?
      WHERE id = ? AND status = ? AND version = ?
        AND worker_id IS ? AND claim_token IS ?
      RETURNING id
    `);
    let recovered = 0;
    for (const task of rows) {
      const activeDispatch = this.listTurnDispatches({ parentTaskId: task.id, active: true, limit: 1 })[0] ?? null;
      if (activeDispatch) {
        this.recordEvent("task", task.id, "task.turn_dispatch_recovery_deferred", { dispatchId: activeDispatch.id, dispatchStatus: activeDispatch.status });
        continue;
      }
      if (task.status === "integration_pending" && this.listIntegrationJournals({ taskId: task.id, limit: 1 }).length) {
        this.recordEvent("task", task.id, "task.integration_recovery_deferred", { worktreeId: task.metadata?.managedWorktreeId });
        continue;
      }
      const contract = task.metadata?.executionContract ?? task.metadata?.execution?.executionContract ?? {};
      let contractFailure = null;
      try {
        if (task.metadata?.contractStatus !== "validated" || task.metadata?.contractFingerprint !== contract?.fingerprint) {
          throw Object.assign(new Error("Restart recovery found an unvalidated execution contract"), { code: "EXECUTION_CONTRACT_NOT_VALIDATED" });
        }
        assertExecutionContract(contract);
      } catch (validationError) {
        contractFailure = executionContractFailure(validationError, { stage: "restart_recovery", fingerprint: task.metadata?.contractFingerprint ?? contract?.fingerprint ?? null });
      }
      const replaySafe = !contractFailure
        && contract.sideEffectPolicy === "none"
        && contract.sandbox === "read-only";
      const status = contractFailure
        ? (contractFailure.category === "policy" ? "blocked_by_policy" : "failed")
        : replaySafe && task.status === "running" ? "queued" : "recovery_attention";
      const error = status === "queued" ? null : contractFailure?.cause ?? "Control-plane restarted with an uncertain active turn";
      const recovery = { previousStatus: task.status, recoveredAt: timestamp, automaticRetry: status === "queued" };
      const failure = contractFailure ? {
        ...contractFailure,
        attemptBudget: { used: task.attempt, max: task.maxAttempts, remaining: Math.max(task.maxAttempts - task.attempt, 0) },
      } : null;
      const metadata = {
        ...task.metadata,
        recovery,
        ...(failure ? { failure, failureHistory: [...(task.metadata?.failureHistory ?? []), failure] } : {}),
      };
      const row = update.get(
        status,
        error,
        timestamp,
        json(metadata, {}),
        task.id,
        task.status,
        task.version,
        task.workerId,
        task.claimToken,
      );
      if (!row) continue;
      recovered += 1;
      this.recordEvent('task', task.id, `task.${status}`, { previousStatus: task.status, restartRecovery: true });
      if (status === 'recovery_attention') {
        const run = task.metadata?.runId ? this.getRun(task.metadata.runId) : null;
        this.createNotification({ projectKey: run?.cwd ?? task.cwd ?? 'workspace', runId: run?.id, taskId: task.id, kind: NOTIFICATION_KINDS.ATTENTION_REQUIRED, title: '판단 필요', body: '재시작 전 작업의 부작용 여부가 불확실하여 자동 재실행하지 않았습니다.', dedupeKey: `${task.id}:recovery_attention:${task.version}` });
      }
    }
    return recovered;
  }

  recoverExpiredAgentLeases() {
    const timestamp = now();
    const expired = this.db.prepare(`
      SELECT * FROM agent_leases
      WHERE status = 'active' AND expires_at <= ?
    `).all(timestamp).map(normalizeAgentLease);
    if (!expired.length) return 0;
    const release = this.db.prepare(`
      UPDATE agent_leases
      SET status = 'expired', released_at = ?, heartbeat_at = ?
      WHERE agent_id = ? AND status = 'active'
    `);
    for (const lease of expired) {
      transitionLease(lease.status, "expired");
      release.run(timestamp, timestamp, lease.agentId);
      const agent = this.getAgent(lease.agentId);
      if (agent && ["leased", "running", "validating", "approval_waiting"].includes(agent.status)) {
        this.updateAgent(lease.agentId, {
          status: "idle",
          metadata: { currentTaskId: null, agentLeaseToken: null, recoveredLeaseAt: timestamp },
        });
      }
      this.recordEvent("agent", lease.agentId, "agent.lease_expired", { taskId: lease.ownerTaskId });
    }
    return expired.length;
  }

  upsertAgent(agent, profile = {}) {
    if (!agent?.id) throw new TypeError("Agent id is required");
    const timestamp = now();
    const existing = this.getAgent(agent.id);
    const status = normalizeAgentStatus(agent.status ?? existing?.status);
    assertAgentStatus(status);
    if (existing && status !== existing.status) transitionAgent(existing.status, status, { allowSync: true });
    const capabilities = profile.capabilities ?? existing?.capabilities ?? [];
    const metadata = { ...(existing?.metadata ?? {}), ...(agent.metadata ?? {}), ...(profile.metadata ?? {}) };
    this.db.prepare(`
      INSERT INTO agents (
        id, session_id, name, cwd, model, provider, status, source, ephemeral,
        forked_from_id, role, capabilities_json, summary, created_at, updated_at,
        last_seen_at, last_task_at, archived_at, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        session_id = excluded.session_id,
        name = COALESCE(excluded.name, agents.name),
        cwd = COALESCE(excluded.cwd, agents.cwd),
        model = COALESCE(excluded.model, agents.model),
        provider = COALESCE(excluded.provider, agents.provider),
        status = COALESCE(excluded.status, agents.status),
        source = COALESCE(excluded.source, agents.source),
        ephemeral = excluded.ephemeral,
        forked_from_id = COALESCE(excluded.forked_from_id, agents.forked_from_id),
        role = COALESCE(excluded.role, agents.role),
        capabilities_json = excluded.capabilities_json,
        summary = COALESCE(excluded.summary, agents.summary),
        updated_at = excluded.updated_at,
        last_seen_at = excluded.last_seen_at,
        metadata_json = excluded.metadata_json
    `).run(
      agent.id,
      agent.sessionId ?? agent.id,
      agent.name ?? null,
      agent.cwd ?? null,
      agent.model ?? null,
      agent.provider ?? "codex",
      status,
      agent.source ?? null,
      agent.ephemeral ? 1 : 0,
      agent.forkedFromId ?? null,
      profile.role ?? existing?.role ?? null,
      json(capabilities, []),
      profile.summary ?? existing?.summary ?? null,
      existing?.createdAt ?? toTimestamp(agent.createdAt, timestamp),
      toTimestamp(agent.updatedAt, timestamp),
      timestamp,
      existing?.lastTaskAt ?? null,
      agent.archivedAt ?? existing?.archivedAt ?? null,
      json(metadata, {}),
    );
    this.#assignProject("agents", agent.id, agent.cwd ?? existing?.cwd ?? null, agent.projectId ?? existing?.projectId ?? null);
    const stored = this.getAgent(agent.id);
    const lifecycleStatus = stored.archivedAt
      ? "archived"
      : ["leased", "running", "validating", "approval_waiting"].includes(stored.status)
        ? "active"
        : ["idle", "available"].includes(stored.status) ? "idle" : "candidate";
    this.ensureThreadLifecycle(agent.id, {
      status: lifecycleStatus,
      threadType: stored.ephemeral ? "ephemeral_worker" : stored.metadata?.executionPlane === "orchestrator" ? "run_orchestrator" : "durable_specialist",
    });
    return this.getAgent(agent.id);
  }

  syncAgents(agents) {
    return agents.map((agent) => this.upsertAgent(agent));
  }

  getAgent(agentId) {
    return normalizeAgent(this.db.prepare("SELECT * FROM agents WHERE id = ?").get(agentId));
  }

  listAgents(options = {}) {
    const clauses = [];
    const values = [];
    if (options.cwd) {
      addCwdScope(clauses, values, "cwd", options.cwd);
    }
    if (options.projectId) { clauses.push("project_id = ?"); values.push(options.projectId); }
    if (options.status) {
      clauses.push("status = ?");
      values.push(options.status);
    }
    if (options.role) {
      clauses.push("role = ?");
      values.push(options.role);
    }
    const scope = options.scope ?? (options.archived === true ? "archived" : options.archived === false ? "active" : "active");
    if (scope === "active") clauses.push("archived_at IS NULL");
    else if (scope === "archived") clauses.push("archived_at IS NOT NULL");
    else if (scope !== "all") throw new TypeError(`Unsupported agent scope: ${scope}`);
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    values.push(options.limit ?? 100);
    return this.db.prepare(`
      SELECT * FROM agents ${where}
      ORDER BY COALESCE(last_task_at, updated_at, last_seen_at) DESC
      LIMIT ?
    `).all(...values).map(normalizeAgent);
  }

  updateAgent(agentId, changes = {}) {
    const existing = this.getAgent(agentId);
    if (!existing) throw new Error(`Agent not found: ${agentId}`);
    const merged = {
      ...existing,
      ...changes,
      name: changes.name ?? existing.name,
      cwd: changes.cwd ?? existing.cwd,
      model: changes.model ?? existing.model,
      status: changes.status ?? existing.status,
      role: changes.role ?? existing.role,
      capabilities: changes.capabilities ?? existing.capabilities,
      summary: changes.summary ?? existing.summary,
      lastTaskAt: changes.lastTaskAt ?? existing.lastTaskAt,
      metadata: { ...existing.metadata, ...(changes.metadata ?? {}) },
    };
    if (merged.status !== existing.status) transitionAgent(existing.status, merged.status, changes.transitionOptions ?? {});
    this.db.prepare(`
      UPDATE agents SET
        name = ?, cwd = ?, model = ?, status = ?, role = ?, capabilities_json = ?,
        summary = ?, last_task_at = ?, updated_at = ?, metadata_json = ?
      WHERE id = ?
    `).run(
      merged.name,
      merged.cwd,
      merged.model,
      merged.status,
      merged.role,
      json(merged.capabilities, []),
      merged.summary,
      merged.lastTaskAt,
      now(),
      json(merged.metadata, {}),
      agentId,
    );
    this.#assignProject("agents", agentId, merged.cwd, changes.projectId ?? existing.projectId ?? null);
    const updated = this.getAgent(agentId);
    const lifecycle = this.getThreadLifecycle(agentId);
    const projected = ["leased", "running", "validating", "approval_waiting"].includes(updated.status) ? "active"
      : ["idle", "available", "unknown"].includes(updated.status) ? "idle" : null;
    if (projected && lifecycle && ["candidate", "active", "idle"].includes(lifecycle.status) && lifecycle.status !== projected) {
      this.transitionThreadLifecycle(agentId, projected, { reason: `agent_status:${updated.status}` });
    }
    return this.getAgent(agentId);
  }

  getThreadLifecycle(threadId) {
    return normalizeThreadLifecycle(this.db.prepare("SELECT * FROM thread_lifecycle WHERE thread_id = ?").get(threadId));
  }

  listThreadLifecycles(options = {}) {
    const clauses = [];
    const values = [];
    if (options.projectId) { clauses.push("project_id = ?"); values.push(options.projectId); }
    if (options.role) { clauses.push("role = ?"); values.push(options.role); }
    if (options.status) { clauses.push("status = ?"); values.push(options.status); }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    values.push(options.limit ?? 200);
    return this.db.prepare(`SELECT * FROM thread_lifecycle ${where} ORDER BY updated_at DESC LIMIT ?`).all(...values).map(normalizeThreadLifecycle);
  }

  ensureThreadLifecycle(threadId, options = {}) {
    const agent = this.getAgent(threadId);
    if (!agent) throw new Error(`Agent not found: ${threadId}`);
    const existing = this.getThreadLifecycle(threadId);
    const timestamp = now();
    if (!existing) {
      const status = agent.archivedAt ? "archived" : options.status ?? "candidate";
      const threadType = options.threadType ?? (agent.ephemeral ? "ephemeral_worker" : "durable_specialist");
      const health = options.contextHealth ?? estimateContextHealth({ ...agent, lifecycle: { status } }, null);
      this.db.prepare(`
        INSERT INTO thread_lifecycle (
          thread_id, project_id, role, thread_type, status, context_health, snapshot_id,
          successor_thread_id, policy_version, created_at, updated_at, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)
      `).run(threadId, agent.projectId ?? null, agent.role ?? null, threadType, status, health,
        options.snapshotId ?? null, options.policyVersion ?? 1, timestamp, timestamp, json(options.metadata ?? {}, {}));
      this.db.prepare(`INSERT INTO thread_lifecycle_events (thread_id, from_status, to_status, reason, evidence_json, created_at)
        VALUES (?, NULL, ?, 'registered', '{}', ?)` ).run(threadId, status, timestamp);
    }
    return this.getThreadLifecycle(threadId);
  }

  #assertThreadLifecycleSettled(threadId) {
    const lease = this.getAgentLease(threadId);
    if (lease?.status === "active" && (!lease.expiresAt || new Date(lease.expiresAt).valueOf() > Date.now())) {
      throw Object.assign(new Error(`Thread ${threadId} still owns an active lease`), { code: "THREAD_LIFECYCLE_ACTIVE_LEASE" });
    }
    const unresolved = this.db.prepare(`
      SELECT id, status FROM tasks WHERE agent_id = ? AND status IN (
        'staged', 'blocked', 'queued', 'waiting_for_lease', 'retry_waiting', 'running', 'approval_waiting',
        'agent_done', 'validating', 'integration_pending', 'upgrade_pending', 'recovery_attention', 'integration_blocked'
      ) LIMIT 1
    `).get(threadId);
    if (unresolved) throw Object.assign(new Error(`Thread ${threadId} has unresolved Task ${unresolved.id} (${unresolved.status})`), { code: "THREAD_LIFECYCLE_UNRESOLVED_TASK" });
    return true;
  }

  transitionThreadLifecycle(threadId, status, details = {}) {
    const existing = this.ensureThreadLifecycle(threadId);
    if (existing.status === status) return existing;
    transitionThreadLifecycle(existing.status, status);
    if (["compacted", "superseded", "archived"].includes(status)) this.#assertThreadLifecycleSettled(threadId);
    let successor = null;
    if (status === "superseded") {
      successor = this.getThreadLifecycle(details.successorThreadId);
      const successorAgent = details.successorThreadId ? this.getAgent(details.successorThreadId) : null;
      const currentAgent = this.getAgent(threadId);
      const snapshot = details.snapshotId ? this.getThreadKnowledgeSnapshot(details.snapshotId) : null;
      if (!successor || !successorAgent || successor.projectId !== existing.projectId || successorAgent.role !== currentAgent.role
        || !snapshot || snapshot.threadId !== successor.threadId || snapshot.status !== "current") {
        throw Object.assign(new Error("Supersede requires a same-project/role successor with a current knowledge snapshot"), { code: "THREAD_SUPERSEDE_EVIDENCE_REQUIRED" });
      }
    }
    const timestamp = now();
    this.db.prepare(`
      UPDATE thread_lifecycle SET status = ?, context_health = ?, snapshot_id = COALESCE(?, snapshot_id),
        successor_thread_id = ?, updated_at = ?, metadata_json = ? WHERE thread_id = ?
    `).run(status, details.contextHealth ?? (status === "idle" ? existing.contextHealth : status === "active" ? existing.contextHealth : 0),
      details.snapshotId ?? null, successor?.threadId ?? existing.successorThreadId, timestamp,
      json({ ...existing.metadata, ...(details.metadata ?? {}) }, {}), threadId);
    this.db.prepare(`INSERT INTO thread_lifecycle_events (thread_id, from_status, to_status, reason, evidence_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)` ).run(threadId, existing.status, status, details.reason ?? "explicit", json(details.evidence ?? {}, {}), timestamp);
    if (status === "superseded") this.recordThreadLineage({ threadId: successor.threadId, parentThreadId: threadId, relationship: "supersede", inheritedSnapshotId: details.snapshotId, metadata: { reason: details.reason ?? "successor" } });
    this.recordEvent("thread_lifecycle", threadId, "thread_lifecycle.transitioned", {
      fromStatus: existing.status, toStatus: status, reason: details.reason ?? "explicit",
      successorThreadId: successor?.threadId ?? null, snapshotId: details.snapshotId ?? null,
    });
    return this.getThreadLifecycle(threadId);
  }

  upsertThreadBudget(input = {}) {
    const project = input.projectId ? this.getProject(input.projectId) : input.cwd ? this.resolveProject(input.cwd) : null;
    const projectScope = project?.id ?? "*";
    const roleScope = input.role?.trim() || "*";
    const policy = validateThreadBudget(input.policy ?? input);
    const existing = this.db.prepare("SELECT MAX(version) AS version FROM thread_budgets WHERE project_scope = ? AND role_scope = ?").get(projectScope, roleScope);
    const version = Number(existing?.version ?? 0) + 1;
    const timestamp = now();
    this.db.prepare("UPDATE thread_budgets SET status = 'superseded', superseded_at = ? WHERE project_scope = ? AND role_scope = ? AND status = 'current'").run(timestamp, projectScope, roleScope);
    const fingerprint = threadBudgetFingerprint(policy);
    const id = input.id ?? `thread_budget_${randomUUID()}`;
    this.db.prepare(`
      INSERT INTO thread_budgets (id, project_scope, project_id, role_scope, version, status, fingerprint, policy_json, created_at, superseded_at)
      VALUES (?, ?, ?, ?, ?, 'current', ?, ?, ?, NULL)
    `).run(id, projectScope, project?.id ?? null, roleScope, version, fingerprint, json(policy, {}), timestamp);
    this.recordEvent("thread_budget", id, "thread_budget.current", { projectId: project?.id ?? null, role: input.role ?? null, version, fingerprint });
    return normalizeThreadBudget(this.db.prepare("SELECT * FROM thread_budgets WHERE id = ?").get(id));
  }

  getThreadBudget(options = {}) {
    let project = options.projectId ? this.getProject(options.projectId) : null;
    if (!project && options.cwd) {
      try { project = this.resolveProject(options.cwd, { create: false }); } catch { project = null; }
    }
    const projectScope = project?.id ?? "*";
    const roleScope = options.role?.trim() || "*";
    const row = this.db.prepare(`
      SELECT * FROM thread_budgets WHERE status = 'current' AND (
        (project_scope = ? AND role_scope = ?) OR (project_scope = ? AND role_scope = '*') OR (project_scope = '*' AND role_scope = '*')
      ) ORDER BY CASE WHEN project_scope = ? AND role_scope = ? THEN 0 WHEN project_scope = ? THEN 1 ELSE 2 END LIMIT 1
    `).get(projectScope, roleScope, projectScope, projectScope, roleScope, projectScope);
    if (row) return normalizeThreadBudget(row);
    const policy = validateThreadBudget({});
    return { id: "default", projectId: project?.id ?? null, role: options.role ?? null, version: policy.version, status: "current", fingerprint: threadBudgetFingerprint(policy), policy };
  }

  getThreadBudgetState(options = {}) {
    const budget = this.getThreadBudget(options);
    let project = options.projectId ? this.getProject(options.projectId) : null;
    if (!project && options.cwd) {
      try { project = this.resolveProject(options.cwd, { create: false }); } catch { project = null; }
    }
    const lifecycles = this.listThreadLifecycles({ ...(project?.id ? { projectId: project.id } : {}), limit: 1000 })
      .filter((item) => !["compacted", "superseded", "archived"].includes(item.status));
    const agents = new Map(lifecycles.map((item) => [item.threadId, this.getAgent(item.threadId)]));
    const durable = lifecycles.filter((item) => item.threadType !== "ephemeral_worker" && !agents.get(item.threadId)?.archivedAt);
    const roleCount = durable.filter((item) => (item.role ?? "") === (options.role ?? "")).length;
    const lineageForks = options.sourceThreadId ? this.listThreadLineage({ parentThreadId: options.sourceThreadId, limit: 1000 }).filter((item) => item.relationship === "fork").length : 0;
    return {
      budget, projectCount: durable.length, roleCount, lineageForks,
      canCreateProject: durable.length < budget.policy.maxProjectThreads,
      canCreateRole: roleCount < budget.policy.maxRoleThreads,
      canForkLineage: lineageForks < budget.policy.maxLineageForks,
    };
  }

  archiveAgent(agentId, options = {}) {
    this.recoverExpiredAgentLeases();
    const agent = this.getAgent(agentId);
    if (!agent) throw new Error(`Agent not found: ${agentId}`);
    if (agent.archivedAt) return agent;
    const lease = this.getAgentLease(agentId);
    if (lease?.status === "active" && new Date(lease.expiresAt).valueOf() > Date.now()) {
      throw Object.assign(new Error(`Agent ${agentId} is leased and cannot be archived`), { code: "ARCHIVE_LEASED_AGENT" });
    }
    const activeTask = this.db.prepare(`
      SELECT id FROM tasks WHERE agent_id = ?
        AND status IN ('running', 'approval_waiting', 'agent_done', 'validating', 'integration_pending')
      LIMIT 1
    `).get(agentId);
    if (activeTask) {
      throw Object.assign(new Error(`Agent ${agentId} owns active task ${activeTask.id} and cannot be archived`), { code: "ARCHIVE_ACTIVE_AGENT" });
    }
    if (!['idle', 'available', 'unknown'].includes(agent.status)) {
      throw Object.assign(new Error(`Agent ${agentId} must be idle before archive (status: ${agent.status})`), { code: "ARCHIVE_ACTIVE_AGENT" });
    }
    const lifecycle = this.ensureThreadLifecycle(agentId);
    transitionThreadLifecycle(lifecycle.status, "archived");
    this.#assertThreadLifecycleSettled(agentId);
    if (options.validateOnly) return agent;
    const archivedAt = now();
    this.transitionThreadLifecycle(agentId, "archived", { reason: options.reason ?? "agent_archive" });
    this.db.prepare("UPDATE agents SET archived_at = ?, updated_at = ? WHERE id = ? AND archived_at IS NULL").run(archivedAt, archivedAt, agentId);
    this.recordEvent("agent", agentId, "agent.archived", { previousStatus: agent.status });
    return this.getAgent(agentId);
  }

  unarchiveAgent(agentId, options = {}) {
    const agent = this.getAgent(agentId);
    if (!agent) throw new Error(`Agent not found: ${agentId}`);
    if (!agent.archivedAt) return agent;
    const lease = this.getAgentLease(agentId);
    if (lease?.status === "active" && new Date(lease.expiresAt).valueOf() > Date.now()) {
      throw Object.assign(new Error(`Agent ${agentId} is leased and cannot be unarchived`), { code: "ARCHIVE_LEASED_AGENT" });
    }
    if (!['idle', 'available', 'unknown'].includes(agent.status)) {
      throw Object.assign(new Error(`Agent ${agentId} must be idle before unarchive (status: ${agent.status})`), { code: "ARCHIVE_ACTIVE_AGENT" });
    }
    const activeTask = this.db.prepare(`
      SELECT id FROM tasks WHERE agent_id = ?
        AND status IN ('running', 'approval_waiting', 'agent_done', 'validating', 'integration_pending')
      LIMIT 1
    `).get(agentId);
    if (activeTask) {
      throw Object.assign(new Error(`Agent ${agentId} owns active task ${activeTask.id} and cannot be unarchived`), { code: "ARCHIVE_ACTIVE_AGENT" });
    }
    if (options.validateOnly) return agent;
    this.transitionThreadLifecycle(agentId, "idle", { reason: options.reason ?? "agent_unarchive" });
    const timestamp = now();
    this.db.prepare("UPDATE agents SET archived_at = NULL, updated_at = ? WHERE id = ? AND archived_at IS NOT NULL").run(timestamp, agentId);
    this.recordEvent("agent", agentId, "agent.unarchived", {});
    return this.getAgent(agentId);
  }

  acquireAgentLease(agentId, ownerTaskId, ownerToken, ttlMs = 120_000, metadata = {}) {
    if (!agentId || !ownerTaskId || !ownerToken) throw new TypeError("Agent lease requires agentId, ownerTaskId, and ownerToken");
    const acquiredAt = now();
    const existing = this.getAgentLease(agentId);
    if (existing && existing.status !== "active") transitionLease(existing.status, "active");
    assertLeaseStatus("active");
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();
    const row = this.db.prepare(`
      INSERT INTO agent_leases (
        agent_id, owner_task_id, owner_token, status, acquired_at, expires_at,
        heartbeat_at, released_at, metadata_json
      ) VALUES (?, ?, ?, 'active', ?, ?, ?, NULL, ?)
      ON CONFLICT(agent_id) DO UPDATE SET
        owner_task_id = excluded.owner_task_id,
        owner_token = excluded.owner_token,
        status = 'active',
        acquired_at = excluded.acquired_at,
        expires_at = excluded.expires_at,
        heartbeat_at = excluded.heartbeat_at,
        released_at = NULL,
        metadata_json = excluded.metadata_json
      WHERE agent_leases.status IN ('released', 'expired') OR agent_leases.expires_at <= excluded.acquired_at
      RETURNING *
    `).get(agentId, ownerTaskId, ownerToken, acquiredAt, expiresAt, acquiredAt, json(metadata, {}));
    if (!row) return null;
    this.recordEvent("agent", agentId, "agent.leased", { taskId: ownerTaskId, expiresAt });
    return normalizeAgentLease(row);
  }

  renewAgentLease(agentId, ownerTaskId, ownerToken, ttlMs = 120_000) {
    const heartbeatAt = now();
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();
    const row = this.db.prepare(`
      UPDATE agent_leases
      SET heartbeat_at = ?, expires_at = ?
      WHERE agent_id = ? AND owner_task_id = ? AND owner_token = ? AND status = 'active'
      RETURNING *
    `).get(heartbeatAt, expiresAt, agentId, ownerTaskId, ownerToken);
    return normalizeAgentLease(row);
  }

  releaseAgentLease(agentId, ownerTaskId, ownerToken, status = "released") {
    assertLeaseStatus(status);
    transitionLease("active", status);
    const releasedAt = now();
    const row = this.db.prepare(`
      UPDATE agent_leases
      SET status = ?, released_at = ?, heartbeat_at = ?
      WHERE agent_id = ? AND owner_task_id = ? AND owner_token = ? AND status = 'active'
      RETURNING *
    `).get(status, releasedAt, releasedAt, agentId, ownerTaskId, ownerToken);
    if (row) this.recordEvent("agent", agentId, "agent.lease_released", { taskId: ownerTaskId, status });
    return normalizeAgentLease(row);
  }

  getAgentLease(agentId) {
    return normalizeAgentLease(this.db.prepare("SELECT * FROM agent_leases WHERE agent_id = ?").get(agentId));
  }

  createTask(task) {
    if (!task?.id || !task?.prompt) throw new TypeError("Task id and prompt are required");
    const timestamp = task.createdAt ?? now();
    const dependencies = [...new Set(task.dependsOn ?? [])];
    const initialStatus = task.status ?? (dependencies.length ? "blocked" : "queued");
    assertTaskStatus(initialStatus);
    const metadata = taskContractMetadata({ ...task, status: initialStatus }, timestamp);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const dependencyId of dependencies) {
        if (dependencyId === task.id) throw new Error("Task cannot depend on itself");
        if (!this.getTask(dependencyId)) throw new Error(`Dependency task not found: ${dependencyId}`);
      }
      this.db.prepare(`
        INSERT INTO tasks (
          id, status, prompt, cwd, source_thread_id, agent_id, mode, output, error,
          turn_id, role, required_capabilities_json, routing_json, created_at,
          started_at, completed_at, updated_at, worker_id, heartbeat_at, attempt,
          max_attempts, retry_delay_ms, next_retry_at, claim_token, version, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        task.id,
        initialStatus,
        task.prompt,
        task.cwd ?? null,
        task.sourceThreadId ?? null,
        task.agentId ?? null,
        task.mode ?? null,
        task.output ?? null,
        task.error ?? null,
        task.turnId ?? null,
        task.role ?? null,
        json(task.requiredCapabilities ?? [], []),
        json(task.routing ?? null),
        timestamp,
        task.startedAt ?? null,
        task.completedAt ?? null,
        timestamp,
        task.workerId ?? null,
        task.heartbeatAt ?? null,
        task.attempt ?? 0,
        task.maxAttempts ?? 1,
        task.retryDelayMs ?? 0,
        task.nextRetryAt ?? null,
        task.claimToken ?? null,
        task.version ?? 0,
        json(metadata, {}),
      );
      this.#assignProject("tasks", task.id, task.cwd ?? null, task.projectId ?? null);
      const dependencyStatement = this.db.prepare(`
        INSERT INTO task_dependencies (task_id, depends_on_task_id, created_at)
        VALUES (?, ?, ?)
      `);
      for (const dependencyId of dependencies) dependencyStatement.run(task.id, dependencyId, timestamp);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    this.recordEvent("task", task.id, "task.created", { status: initialStatus, dependencies });
    return this.getTask(task.id);
  }

  getTask(taskId) {
    const task = normalizeTask(this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId));
    if (task) task.dependencies = this.listTaskDependencies(taskId);
    return task;
  }

  updateTask(taskId, changes = {}, options = {}) {
    const existing = this.getTask(taskId);
    if (!existing) throw new Error(`Task not found: ${taskId}`);
    if (changes.status && changes.status !== existing.status) transitionTask(existing.status, changes.status, options);
    const merged = {
      ...existing,
      ...changes,
      requiredCapabilities: changes.requiredCapabilities ?? existing.requiredCapabilities,
      workerId: changes.workerId === undefined ? existing.workerId : changes.workerId,
      heartbeatAt: changes.heartbeatAt === undefined ? existing.heartbeatAt : changes.heartbeatAt,
      attempt: changes.attempt ?? existing.attempt,
      maxAttempts: changes.maxAttempts ?? existing.maxAttempts,
      retryDelayMs: changes.retryDelayMs ?? existing.retryDelayMs,
      nextRetryAt: changes.nextRetryAt === undefined ? existing.nextRetryAt : changes.nextRetryAt,
      claimToken: changes.claimToken === undefined ? existing.claimToken : changes.claimToken,
      version: changes.version ?? existing.version,
      metadata: { ...existing.metadata, ...(changes.metadata ?? {}) },
    };
    if (changes.metadata && (Object.hasOwn(changes.metadata, "executionContract") || Object.hasOwn(changes.metadata, "execution"))) {
      merged.metadata = taskContractMetadata(merged);
    }
    this.db.prepare(`
      UPDATE tasks SET
        status = ?, cwd = ?, source_thread_id = ?, agent_id = ?, mode = ?, output = ?,
        error = ?, turn_id = ?, role = ?, required_capabilities_json = ?, routing_json = ?,
        started_at = ?, completed_at = ?, updated_at = ?, worker_id = ?, heartbeat_at = ?,
        attempt = ?, max_attempts = ?, retry_delay_ms = ?, next_retry_at = ?,
        claim_token = ?, version = version + 1, metadata_json = ?
      WHERE id = ?
    `).run(
      merged.status,
      merged.cwd,
      merged.sourceThreadId,
      merged.agentId,
      merged.mode,
      merged.output,
      merged.error,
      merged.turnId,
      merged.role,
      json(merged.requiredCapabilities, []),
      json(merged.routing ?? null),
      merged.startedAt,
      merged.completedAt,
      now(),
      merged.workerId,
      merged.heartbeatAt,
      merged.attempt,
      merged.maxAttempts,
      merged.retryDelayMs,
      merged.nextRetryAt,
      merged.claimToken,
      json(merged.metadata, {}),
      taskId,
    );
    if (changes.status && changes.status !== existing.status) {
      this.recordEvent("task", taskId, `task.${changes.status}`, { previousStatus: existing.status });
    }
    this.#assignProject("tasks", taskId, merged.cwd, changes.projectId ?? existing.projectId ?? null);
    if (merged.agentId) {
      const agent = this.getAgent(merged.agentId);
      if (agent) this.updateAgent(merged.agentId, { lastTaskAt: now() });
    }
    return this.getTask(taskId);
  }

  listTasks(options = {}) {
    const clauses = [];
    const values = [];
    if (options.status) {
      clauses.push("status = ?");
      values.push(options.status);
    }
    if (options.agentId) {
      clauses.push("agent_id = ?");
      values.push(options.agentId);
    }
    if (options.cwd) {
      addCwdScope(clauses, values, "cwd", options.cwd);
    }
    if (options.projectId) { clauses.push("project_id = ?"); values.push(options.projectId); }
    if (options.runId) {
      clauses.push("run_id = ?");
      values.push(options.runId);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    values.push(options.limit ?? 50);
    return this.db.prepare(`SELECT * FROM tasks ${where} ORDER BY created_at DESC LIMIT ?`).all(...values).map((row) => {
      const task = normalizeTask(row);
      task.dependencies = this.listTaskDependencies(task.id);
      return task;
    });
  }

  releaseStagedRun(runId, details = {}) {
    if (!runId) throw new TypeError("Run id is required");
    const run = this.getRun(runId);
    const globalRevisionId = run?.metadata?.globalRunRevisionId;
    if (globalRevisionId) {
      const revision = this.getGlobalRunRevision(globalRevisionId);
      const globalRun = revision ? this.getGlobalRun(revision.globalRunId) : null;
      const manifest = revision ? this.getAuthorizationManifestForRun(revision.id, runId) : null;
      if (!revision || revision.status !== "validated" || globalRun?.currentRevision !== revision.revision
        || globalRun.cancellationRequestedAt || revision.graphFingerprint !== run.metadata.globalGraphFingerprint
        || revision.authorizationFingerprint !== run.metadata.globalAuthorizationFingerprint
        || !manifest || manifest.fingerprint !== run.metadata.globalAuthorizationManifestFingerprint) {
        throw Object.assign(new Error(`Project Run ${runId} is not releasable under its Global Run revision`), { code: "GLOBAL_RUN_RELEASE_FENCED" });
      }
      const unreceived = this.db.prepare(`
        SELECT dependency.id FROM cross_project_dependencies dependency
        LEFT JOIN cross_project_handoffs handoff ON handoff.dependency_id = dependency.id
        WHERE dependency.revision_id = ? AND dependency.consumer_run_id = ?
          AND (dependency.status != 'satisfied' OR handoff.status != 'received'
            OR handoff.dependency_fingerprint != dependency.fingerprint
            OR handoff.fingerprint != json_extract(handoff.metadata_json, '$.validatedFingerprint')
            OR handoff.content_hash != json_extract(handoff.metadata_json, '$.validatedContentHash')
            OR handoff.receipt_hash != json_extract(handoff.metadata_json, '$.validatedReceiptHash')
            OR handoff.receipt_hash IS NULL)
        LIMIT 1
      `).get(revision.id, runId);
      if (unreceived) throw Object.assign(new Error(`Project Run ${runId} requires a validated and received cross-project handoff`), { code: "CROSS_PROJECT_HANDOFF_NOT_RECEIVED" });
    }
    const timestamp = now();
    const released = [];
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const rows = this.db.prepare(`
        SELECT id FROM tasks
        WHERE status = 'staged' AND json_extract(metadata_json, '$.runId') = ?
        ORDER BY created_at
      `).all(runId);
      const update = this.db.prepare(`
        UPDATE tasks
        SET status = CASE
              WHEN EXISTS (SELECT 1 FROM task_dependencies d WHERE d.task_id = tasks.id)
                THEN 'blocked'
              ELSE 'queued'
            END,
            updated_at = ?, version = version + 1,
            metadata_json = json_set(metadata_json, '$.automaticallyStartedAt', ?, '$.startSource', ?)
        WHERE id = ? AND status = 'staged'
        RETURNING id, status
      `);
      for (const row of rows) {
        const changed = update.get(timestamp, timestamp, details.source ?? "manual", row.id);
        if (changed) released.push(changed);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    for (const task of released) {
      this.recordEvent("task", task.id, `task.${task.status}`, {
        previousStatus: "staged",
        runId,
        startPolicy: "automatic",
      });
    }
    this.recordEvent("system", runId, "run.automatically_started", {
      source: details.source ?? "automatic_dispatch",
      releasedTasks: released.length,
    });
    if (this.getRun(runId)) this.updateRun(runId, { status: "running", startedAt: timestamp });
    return { runId, status: "ready", releasedTasks: released.length, tasks: this.listTasks({ runId, limit: 100 }) };
  }

  createRun(run) {
    if (!run?.id) throw new TypeError("Run id is required");
    const timestamp = run.createdAt ?? now();
    assertRunStatus(run.status ?? "draft");
    if (run.requestKey) {
      const existing = this.db.prepare("SELECT * FROM runs WHERE request_key = ?").get(run.requestKey);
      if (existing) return normalizeRun(existing);
    }
    this.db.prepare(`
      INSERT INTO runs (id, request_key, plan_id, name, status, cwd, created_at, updated_at, started_at, completed_at, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      run.id,
      run.requestKey ?? null,
      run.planId ?? null,
      run.name ?? null,
      run.status ?? "draft",
      run.cwd ?? null,
      timestamp,
      timestamp,
      run.startedAt ?? null,
      run.completedAt ?? null,
      json(run.metadata ?? {}, {}),
    );
    this.#assignProject("runs", run.id, run.cwd ?? null, run.projectId ?? null);
    this.recordEvent("run", run.id, `run.${run.status ?? "draft"}`, { name: run.name ?? null, cwd: run.cwd ?? null });
    return this.getRun(run.id);
  }

  createGlobalRun(globalRun) {
    if (!globalRun?.id || !globalRun?.objective?.trim()) throw new TypeError("Global Run id and objective are required");
    const status = globalRun.status ?? "accepted";
    assertGlobalRunStatus(status);
    if (globalRun.requestKey) {
      const existing = this.db.prepare("SELECT * FROM global_runs WHERE request_key = ?").get(globalRun.requestKey);
      if (existing) return normalizeGlobalRun(existing);
    }
    const timestamp = globalRun.createdAt ?? now();
    this.db.prepare(`
      INSERT INTO global_runs (
        id, request_key, objective, status, current_revision, cancellation_requested_at,
        origin_json, created_at, updated_at, completed_at, metadata_json
      ) VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, ?, NULL, ?)
    `).run(globalRun.id, globalRun.requestKey ?? null, globalRun.objective.trim(), status,
      json(globalRun.origin ?? {}, {}), timestamp, timestamp, json(globalRun.metadata ?? {}, {}));
    this.recordEvent("global_run", globalRun.id, `global_run.${status}`, { objective: globalRun.objective.trim() });
    return this.getGlobalRun(globalRun.id);
  }

  getGlobalRun(globalRunId) {
    return normalizeGlobalRun(this.db.prepare("SELECT * FROM global_runs WHERE id = ?").get(globalRunId));
  }

  listGlobalRuns(options = {}) {
    const clauses = [];
    const values = [];
    if (options.status) { clauses.push("status = ?"); values.push(options.status); }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    values.push(options.limit ?? 50);
    return this.db.prepare(`SELECT * FROM global_runs ${where} ORDER BY created_at DESC LIMIT ?`).all(...values).map(normalizeGlobalRun);
  }

  updateGlobalRun(globalRunId, changes = {}) {
    const existing = this.getGlobalRun(globalRunId);
    if (!existing) throw new Error(`Global Run not found: ${globalRunId}`);
    const status = changes.status ?? existing.status;
    if (status !== existing.status) transitionGlobalRun(existing.status, status);
    const timestamp = now();
    this.db.prepare(`
      UPDATE global_runs SET status = ?, current_revision = ?, cancellation_requested_at = ?,
        updated_at = ?, completed_at = ?, metadata_json = ? WHERE id = ?
    `).run(status, changes.currentRevision ?? existing.currentRevision,
      changes.cancellationRequestedAt === undefined ? existing.cancellationRequestedAt : changes.cancellationRequestedAt,
      timestamp, changes.completedAt === undefined ? existing.completedAt : changes.completedAt,
      json({ ...existing.metadata, ...(changes.metadata ?? {}) }, {}), globalRunId);
    if (status !== existing.status) this.recordEvent("global_run", globalRunId, `global_run.${status}`, { previousStatus: existing.status });
    return this.getGlobalRun(globalRunId);
  }

  createGlobalRunGraph(input) {
    const apiVersion = input?.apiVersion ?? GLOBAL_RUN_API_VERSION;
    if (apiVersion !== GLOBAL_RUN_API_VERSION) {
      throw Object.assign(new Error(`Unsupported Global Run API version: ${apiVersion}`), { code: "GLOBAL_RUN_API_VERSION_UNSUPPORTED" });
    }
    const globalRun = this.getGlobalRun(input?.globalRunId);
    if (!globalRun) throw new Error(`Global Run not found: ${input?.globalRunId}`);
    if (globalRun.status !== "preparing") throw Object.assign(new Error(`Global Run ${globalRun.id} must be preparing before graph materialization`), { code: "GLOBAL_RUN_NOT_PREPARING" });
    if (globalRun.cancellationRequestedAt) throw Object.assign(new Error("Global Run cancellation was already requested"), { code: "GLOBAL_RUN_CANCELLED" });
    const revision = input.revision ?? 1;
    const revisionId = input.revisionId ?? `${globalRun.id}:revision:${revision}`;
    const existingRevision = this.getGlobalRunRevision(revisionId);
    if (existingRevision?.status === "validated") return { ...this.getGlobalRunGraph(globalRun.id), idempotent: true };
    const contextSnapshot = this.getContextSnapshot(input.contextSnapshotId);
    if (!contextSnapshot || contextSnapshot.status !== "validated" || contextSnapshot.fingerprint !== input.contextSnapshotFingerprint) {
      throw Object.assign(new Error("Global Run requires a validated Context Snapshot with a matching fingerprint"), { code: "GLOBAL_CONTEXT_SNAPSHOT_INVALID" });
    }
    const dependencyContracts = (input.dependencies ?? []).map(compileCrossProjectDependency);
    validateGlobalProjectGraph(input.projectRuns, dependencyContracts);
    const projectRuns = input.projectRuns.map((entry) => {
      if (!Array.isArray(entry.tasks) || !entry.tasks.length) throw Object.assign(new Error(`Project Run ${entry.run.id} requires a Task graph`), { code: "GLOBAL_PROJECT_TASKS_REQUIRED" });
      validateTaskGraph(entry.tasks);
      const project = entry.run.projectId ? this.getProject(entry.run.projectId) : this.resolveProject(entry.run.cwd);
      if (!project) throw Object.assign(new Error(`Project identity not found for Run ${entry.run.id}`), { code: "GLOBAL_PROJECT_IDENTITY_INVALID" });
      if (entry.run.cwd) {
        const resolved = this.resolveProject(entry.run.cwd);
        if (resolved.id !== project.id) throw Object.assign(new Error(`Project scope mismatch for Run ${entry.run.id}`), { code: "GLOBAL_PROJECT_SCOPE_MISMATCH" });
      }
      if (this.getRun(entry.run.id)) throw Object.assign(new Error(`Project Run already exists outside this Global Run revision: ${entry.run.id}`), { code: "GLOBAL_PROJECT_RUN_EXISTS" });
      const tasks = entry.tasks.map((task) => ({
        ...task,
        status: "staged",
        cwd: task.cwd ?? entry.run.cwd,
        projectId: task.projectId ?? project.id,
        metadata: taskContractMetadata({ ...task, status: "staged", metadata: {
          ...(task.metadata ?? {}), contextSnapshotId: contextSnapshot.id,
          contextSnapshotFingerprint: contextSnapshot.fingerprint,
        } }),
      }));
      const invalidTask = tasks.find((task) => task.metadata.contractStatus !== "validated");
      if (invalidTask) throw Object.assign(new Error(`Project Run ${entry.run.id} contains an invalid execution contract`), { code: "GLOBAL_PROJECT_CONTRACT_INVALID" });
      return { ...entry, project, run: { ...entry.run, projectId: project.id }, tasks };
    });
    const authorization = compileAuthorizationManifestSet(input.authorizationManifests, projectRuns);
    if (input.authorizationFingerprint !== undefined && input.authorizationFingerprint !== authorization.fingerprint) {
      throw Object.assign(new Error("Global Run authorization manifest set fingerprint mismatch"), { code: "GLOBAL_AUTHORIZATION_FINGERPRINT_MISMATCH" });
    }
    const graphFingerprint = fingerprintGlobalProjectGraph({
      ...input, apiVersion, revision, projectRuns, dependencies: dependencyContracts,
      authorizationFingerprint: authorization.fingerprint, authorizationManifests: authorization.manifests,
    });
    const timestamp = now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(`
        INSERT INTO global_run_revisions (
          id, global_run_id, revision, status, context_snapshot_id, context_snapshot_fingerprint,
          authorization_fingerprint, graph_fingerprint, created_at, validated_at, metadata_json
        ) VALUES (?, ?, ?, 'building', ?, ?, ?, NULL, ?, NULL, ?)
      `).run(revisionId, globalRun.id, revision, contextSnapshot.id, contextSnapshot.fingerprint,
        authorization.fingerprint, timestamp, json({ ...(input.metadata ?? {}), apiVersion }, {}));
      for (const entry of projectRuns) {
        const authorizationManifest = authorization.manifests.find((manifest) => manifest.runId === entry.run.id);
        const runMetadata = {
          ...(entry.run.metadata ?? {}), globalRunId: globalRun.id, globalRunRevisionId: revisionId,
          globalGraphFingerprint: graphFingerprint, globalAuthorizationFingerprint: authorization.fingerprint,
          globalAuthorizationManifestFingerprint: authorizationManifest.fingerprint,
          contextSnapshotId: contextSnapshot.id, contextSnapshotFingerprint: contextSnapshot.fingerprint,
        };
        const tasks = entry.tasks.map((task) => ({ ...task, metadata: {
          ...task.metadata, globalRunId: globalRun.id, globalRunRevisionId: revisionId,
          globalGraphFingerprint: graphFingerprint, globalAuthorizationFingerprint: authorization.fingerprint,
          globalAuthorizationManifestFingerprint: authorizationManifest.fingerprint,
        } }));
        this.createTaskGraph({ ...entry.run, status: "preparing", metadata: runMetadata }, tasks);
        this.db.prepare(`
          INSERT INTO authorization_manifests (
            id, revision_id, run_id, project_id, version, fingerprint, manifest_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(`${revisionId}:authorization:${authorizationManifest.runId}`, revisionId, authorizationManifest.runId,
          authorizationManifest.projectId, authorizationManifest.version, authorizationManifest.fingerprint,
          json(authorizationManifest, {}), timestamp);
        this.db.prepare(`
          INSERT INTO global_run_projects (revision_id, global_run_id, run_id, project_id, membership, created_at, metadata_json)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(revisionId, globalRun.id, entry.run.id, entry.run.projectId, entry.membership ?? "required", timestamp, json(entry.metadata ?? {}, {}));
      }
      for (const dependency of dependencyContracts) {
        this.db.prepare(`
          INSERT INTO cross_project_dependencies (
            id, revision_id, producer_run_id, consumer_run_id, condition, status,
            fingerprint, required_outputs_json, acceptance_criteria_json, handoff_schema_version,
            created_at, satisfied_at, metadata_json
          ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, NULL, ?)
        `).run(dependency.id, revisionId, dependency.producerRunId, dependency.consumerRunId,
          dependency.condition, dependency.fingerprint, json(dependency.requiredOutputs, []),
          json(dependency.acceptanceCriteria, []), dependency.handoffSchemaVersion,
          timestamp, json(dependency.metadata ?? {}, {}));
      }
      this.db.prepare(`
        UPDATE global_run_revisions SET status = 'validated', graph_fingerprint = ?, validated_at = ? WHERE id = ? AND status = 'building'
      `).run(graphFingerprint, timestamp, revisionId);
      this.db.prepare("UPDATE global_runs SET current_revision = ?, updated_at = ? WHERE id = ? AND status = 'preparing'").run(revision, timestamp, globalRun.id);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    this.recordEvent("global_run", globalRun.id, "global_run.graph_validated", { revision, revisionId, graphFingerprint, projectRuns: projectRuns.length });
    return { ...this.getGlobalRunGraph(globalRun.id), idempotent: false };
  }

  getGlobalRunRevision(revisionId) {
    return normalizeGlobalRunRevision(this.db.prepare("SELECT * FROM global_run_revisions WHERE id = ?").get(revisionId));
  }

  listGlobalRunProjects(globalRunId, revision = null) {
    return this.db.prepare(`
      SELECT * FROM global_run_projects WHERE global_run_id = ?
        AND (? IS NULL OR revision_id = (SELECT id FROM global_run_revisions WHERE global_run_id = ? AND revision = ?))
      ORDER BY created_at, run_id
    `).all(globalRunId, revision, globalRunId, revision).map(normalizeGlobalRunProject);
  }

  getGlobalRunForProjectRun(runId) {
    const row = this.db.prepare(`
      SELECT global_run_id FROM global_run_projects WHERE run_id = ? LIMIT 1
    `).get(runId);
    return row ? this.getGlobalRunGraph(row.global_run_id) : null;
  }

  listCrossProjectDependencies(revisionId) {
    return this.db.prepare("SELECT * FROM cross_project_dependencies WHERE revision_id = ? ORDER BY created_at, id").all(revisionId).map(normalizeCrossProjectDependency);
  }

  listAuthorizationManifests(revisionId) {
    return this.db.prepare("SELECT * FROM authorization_manifests WHERE revision_id = ? ORDER BY run_id").all(revisionId).map(normalizeAuthorizationManifest);
  }

  getAuthorizationManifestForRun(revisionId, runId) {
    return normalizeAuthorizationManifest(this.db.prepare("SELECT * FROM authorization_manifests WHERE revision_id = ? AND run_id = ?").get(revisionId, runId));
  }

  listCrossProjectHandoffs(revisionId) {
    return this.db.prepare("SELECT * FROM cross_project_handoffs WHERE revision_id = ? ORDER BY prepared_at, id").all(revisionId).map(normalizeCrossProjectHandoff);
  }

  getCrossProjectHandoff(dependencyId) {
    return normalizeCrossProjectHandoff(this.db.prepare("SELECT * FROM cross_project_handoffs WHERE dependency_id = ?").get(dependencyId));
  }

  getGlobalRunGraph(globalRunId) {
    const globalRun = this.getGlobalRun(globalRunId);
    if (!globalRun) return null;
    const revision = globalRun.currentRevision === null ? null : normalizeGlobalRunRevision(this.db.prepare("SELECT * FROM global_run_revisions WHERE global_run_id = ? AND revision = ?").get(globalRunId, globalRun.currentRevision));
    const memberships = revision ? this.listGlobalRunProjects(globalRunId, revision.revision).map((membership) => ({ ...membership, run: this.getRun(membership.runId) })) : [];
    const resultRow = this.db.prepare("SELECT * FROM global_run_results WHERE global_run_id = ?").get(globalRunId);
    return {
      globalRun, revision, memberships,
      dependencies: revision ? this.listCrossProjectDependencies(revision.id) : [],
      authorizationManifests: revision ? this.listAuthorizationManifests(revision.id) : [],
      handoffs: revision ? this.listCrossProjectHandoffs(revision.id) : [],
      result: resultRow ? parse(resultRow.projection_json, null) : null,
    };
  }

  assertGlobalTaskGate(taskId) {
    const task = this.getTask(taskId);
    if (!task?.metadata?.globalRunRevisionId) return true;
    const revision = this.getGlobalRunRevision(task.metadata.globalRunRevisionId);
    const globalRun = revision ? this.getGlobalRun(revision.globalRunId) : null;
    if (!revision || revision.status !== "validated" || !globalRun
      || globalRun.currentRevision !== revision.revision || globalRun.cancellationRequestedAt
      || !["running", "waiting"].includes(globalRun.status)
      || revision.graphFingerprint !== task.metadata.globalGraphFingerprint
      || revision.authorizationFingerprint !== task.metadata.globalAuthorizationFingerprint) {
      throw Object.assign(new Error("Global Run revision is not valid for Task claim"), { code: "GLOBAL_TASK_REVISION_FENCED" });
    }
    const run = this.getRun(task.metadata.runId);
    const project = run?.projectId ? this.getProject(run.projectId) : null;
    const manifestRow = this.getAuthorizationManifestForRun(revision.id, run?.id);
    if (!run || !project || !manifestRow || manifestRow.fingerprint !== task.metadata.globalAuthorizationManifestFingerprint) {
      throw Object.assign(new Error("Project authorization manifest is missing or does not match the Task marker"), { code: "GLOBAL_AUTHORIZATION_FINGERPRINT_MISMATCH" });
    }
    const compiled = compileAuthorizationManifest(manifestRow.manifest, {
      runId: run.id, project, tasks: this.listTasks({ runId: run.id, limit: 1000 }), cwd: run.cwd,
    });
    if (compiled.fingerprint !== manifestRow.fingerprint) throw Object.assign(new Error("Persisted project authorization manifest was modified"), { code: "GLOBAL_AUTHORIZATION_FINGERPRINT_MISMATCH" });
    for (const dependency of this.listCrossProjectDependencies(revision.id).filter((item) => item.consumerRunId === run.id)) {
      const handoff = dependency.status === "satisfied" ? this.materializeCrossProjectHandoff(dependency.id) : this.getCrossProjectHandoff(dependency.id);
      if (dependency.status !== "satisfied" || handoff?.status !== "received") {
        throw Object.assign(new Error(`Cross-project handoff is not valid and received: ${dependency.id}`), { code: "CROSS_PROJECT_HANDOFF_NOT_RECEIVED" });
      }
    }
    return true;
  }

  releaseGlobalRun(globalRunId) {
    const graph = this.getGlobalRunGraph(globalRunId);
    if (!graph?.revision || graph.revision.status !== "validated") throw Object.assign(new Error("Global Run graph is not validated"), { code: "GLOBAL_GRAPH_NOT_VALIDATED" });
    if (graph.globalRun.cancellationRequestedAt) throw Object.assign(new Error("Global Run cancellation prevents release"), { code: "GLOBAL_RUN_CANCELLED" });
    if (graph.globalRun.status !== "preparing" && graph.globalRun.status !== "waiting") return graph;
    const consumers = new Set(graph.dependencies.map((dependency) => dependency.consumerRunId));
    let released = 0;
    for (const membership of graph.memberships) {
      if (consumers.has(membership.runId)) continue;
      const result = this.releaseStagedRun(membership.runId, { source: "global_run_release" });
      released += result.releasedTasks;
    }
    this.updateGlobalRun(globalRunId, { status: "running", metadata: { releasedRevisionId: graph.revision.id } });
    this.recordEvent("global_run", globalRunId, "global_run.roots_released", { releasedTasks: released });
    return this.getGlobalRunGraph(globalRunId);
  }

  materializeCrossProjectHandoff(dependencyId) {
    const dependency = normalizeCrossProjectDependency(this.db.prepare("SELECT * FROM cross_project_dependencies WHERE id = ?").get(dependencyId));
    if (!dependency) throw new Error(`Cross-project dependency not found: ${dependencyId}`);
    if (dependency.status !== "satisfied") return this.getCrossProjectHandoff(dependencyId);
    const expectedReceipt = (handoff) => globalRunFingerprint({
      handoffFingerprint: handoff.fingerprint, consumerRunId: handoff.consumerRunId, contentHash: handoff.contentHash,
    });
    let existing = this.getCrossProjectHandoff(dependencyId);
    if (existing) {
      const contentHash = globalRunFingerprint(existing.payload);
      const fingerprint = crossProjectHandoffFingerprint({
        dependencyId, dependencyFingerprint: dependency.fingerprint,
        producerRunId: dependency.producerRunId, consumerRunId: dependency.consumerRunId,
        schemaVersion: dependency.handoffSchemaVersion, contentHash,
      });
      if (existing.dependencyFingerprint !== dependency.fingerprint || existing.schemaVersion !== dependency.handoffSchemaVersion
        || existing.contentHash !== contentHash || existing.fingerprint !== fingerprint
        || existing.metadata.validatedFingerprint !== existing.fingerprint
        || existing.metadata.validatedContentHash !== existing.contentHash
        || (existing.receiptHash && (existing.receiptHash !== expectedReceipt(existing) || existing.metadata.validatedReceiptHash !== existing.receiptHash))) {
        this.db.prepare("UPDATE cross_project_handoffs SET status = 'invalid', validation_json = ? WHERE dependency_id = ?")
          .run(json({ valid: false, code: "CROSS_PROJECT_HANDOFF_INTEGRITY_FAILURE", cause: "Persisted handoff schema, content, fingerprint, or receipt was modified" }, {}), dependencyId);
        this.db.prepare("UPDATE cross_project_dependencies SET status = 'failed' WHERE id = ?").run(dependencyId);
        this.recordEvent("global_run", dependency.revisionId, "cross_project_handoff.invalid", { dependencyId, cause: "integrity_failure" });
        return this.getCrossProjectHandoff(dependencyId);
      }
      if (existing.status === "invalid" || existing.status === "received") return existing;
    } else {
      const tasks = this.listTasks({ runId: dependency.producerRunId, limit: 1000 });
      const evidence = tasks.map((task) => {
        const artifact = task.metadata?.integration?.artifact ?? task.metadata?.artifact ?? null;
        const safeArtifact = artifact ? {
          kind: artifact.kind ?? null, strategy: artifact.strategy ?? task.metadata?.integration?.strategy ?? null,
          commit: artifact.commit ?? artifact.commitHash ?? null,
          contentHash: artifact.contentHash ?? artifact.patchHash ?? artifact.digest ?? null,
        } : null;
        return {
          taskId: task.id, status: task.status,
          declaredOutputs: task.metadata?.executionContract?.outputs ?? [],
          output: task.output ?? null,
          validation: task.metadata?.validation ?? null,
          completionVerdict: task.metadata?.completionVerdict ?? null,
          artifact: safeArtifact,
        };
      });
      const missingOutputs = dependency.requiredOutputs.filter((required) => !evidence.some((item) => {
        if (!item.declaredOutputs.includes(required) || !["completed", "completed_with_warnings"].includes(item.status)) return false;
        if (item.completionVerdict) {
          return ["accept", "accept_with_warnings"].includes(item.completionVerdict.decision)
            && item.completionVerdict.satisfiedEvidence?.includes(`output:${required}`);
        }
        return item.output !== null || item.artifact !== null;
      }));
      const payload = {
        schemaVersion: dependency.handoffSchemaVersion,
        dependencyId, producerRunId: dependency.producerRunId, consumerRunId: dependency.consumerRunId,
        producerStatus: this.getRun(dependency.producerRunId)?.status ?? null,
        requiredOutputs: dependency.requiredOutputs,
        evidence,
      };
      const contentHash = globalRunFingerprint(payload);
      const fingerprint = crossProjectHandoffFingerprint({
        dependencyId, dependencyFingerprint: dependency.fingerprint,
        producerRunId: dependency.producerRunId, consumerRunId: dependency.consumerRunId,
        schemaVersion: dependency.handoffSchemaVersion, contentHash,
      });
      const timestamp = now();
      const validation = {
        valid: missingOutputs.length === 0,
        code: missingOutputs.length ? "CROSS_PROJECT_HANDOFF_OUTPUT_MISSING" : null,
        missingOutputs,
        acceptanceCriteria: dependency.acceptanceCriteria.map((criterion) => ({ criterion, status: "evidence_attached" })),
      };
      this.db.prepare(`
        INSERT INTO cross_project_handoffs (
          id, dependency_id, revision_id, producer_run_id, consumer_run_id, schema_version,
          status, dependency_fingerprint, fingerprint, content_hash, receipt_hash,
          payload_json, validation_json, prepared_at, validated_at, received_at, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, 'prepared', ?, ?, ?, NULL, ?, ?, ?, NULL, NULL, ?)
      `).run(`${dependency.revisionId}:handoff:${dependency.id}`, dependency.id, dependency.revisionId,
        dependency.producerRunId, dependency.consumerRunId, dependency.handoffSchemaVersion,
        dependency.fingerprint, fingerprint, contentHash, json(payload, {}), json(validation, {}), timestamp,
        json({ validatedFingerprint: fingerprint, validatedContentHash: contentHash }, {}));
      this.recordEvent("global_run", dependency.revisionId, "cross_project_handoff.prepared", { dependencyId, contentHash });
      if (!validation.valid) {
        this.db.prepare("UPDATE cross_project_handoffs SET status = 'invalid', validated_at = ? WHERE dependency_id = ?").run(timestamp, dependencyId);
        this.db.prepare("UPDATE cross_project_dependencies SET status = 'failed' WHERE id = ?").run(dependencyId);
        this.recordEvent("global_run", dependency.revisionId, "cross_project_handoff.invalid", { dependencyId, missingOutputs });
        return this.getCrossProjectHandoff(dependencyId);
      }
      this.db.prepare("UPDATE cross_project_handoffs SET status = 'validated', validated_at = ? WHERE dependency_id = ? AND status = 'prepared'").run(timestamp, dependencyId);
      this.recordEvent("global_run", dependency.revisionId, "cross_project_handoff.validated", { dependencyId, contentHash });
      existing = this.getCrossProjectHandoff(dependencyId);
    }
    if (existing.status === "validated" || existing.status === "prepared") {
      const timestamp = now();
      const receiptHash = expectedReceipt(existing);
      const changed = this.db.prepare(`
        UPDATE cross_project_handoffs SET status = 'received', receipt_hash = ?, received_at = ?,
          validated_at = COALESCE(validated_at, ?),
          metadata_json = json_set(metadata_json, '$.validatedReceiptHash', ?)
        WHERE dependency_id = ? AND status IN ('prepared', 'validated') AND receipt_hash IS NULL
      `).run(receiptHash, timestamp, timestamp, receiptHash, dependencyId).changes;
      if (changed) this.recordEvent("global_run", dependency.revisionId, "cross_project_handoff.received", { dependencyId, receiptHash });
    }
    return this.getCrossProjectHandoff(dependencyId);
  }

  refreshGlobalRun(globalRunId, options = {}) {
    if (!options.internal) {
      if (this.globalRefreshes.has(globalRunId)) return this.getGlobalRunGraph(globalRunId);
      this.globalRefreshes.add(globalRunId);
      try { return this.refreshGlobalRun(globalRunId, { internal: true }); }
      finally { this.globalRefreshes.delete(globalRunId); }
    }
    let graph = this.getGlobalRunGraph(globalRunId);
    if (!graph?.revision || ["completed", "failed", "cancelled", "attention_required"].includes(graph.globalRun.status)) return graph;
    for (const membership of graph.memberships) this.refreshRun(membership.runId);
    const terminalRuns = new Set(["completed", "failed", "cancelled"]);
    for (const dependency of graph.dependencies.filter((item) => item.status === "pending")) {
      const producer = this.getRun(dependency.producerRunId);
      if (!terminalRuns.has(producer?.status)) continue;
      let status;
      if (dependency.condition === "all_terminal") status = "satisfied";
      else if (dependency.condition === "on_failure") status = producer.status === "completed" ? "skipped" : "satisfied";
      else status = producer.status === "completed" ? "satisfied" : "failed";
      this.db.prepare("UPDATE cross_project_dependencies SET status = ?, satisfied_at = ? WHERE id = ? AND status = 'pending'").run(status, now(), dependency.id);
      this.recordEvent("global_run", globalRunId, `cross_project_dependency.${status}`, { dependencyId: dependency.id, producerRunId: producer.id, consumerRunId: dependency.consumerRunId });
    }
    for (const dependency of this.listCrossProjectDependencies(graph.revision.id).filter((item) => item.status === "satisfied")) {
      this.materializeCrossProjectHandoff(dependency.id);
    }
    graph = this.getGlobalRunGraph(globalRunId);
    let releasedConsumer = false;
    const byConsumer = new Map();
    for (const dependency of graph.dependencies) {
      const list = byConsumer.get(dependency.consumerRunId) ?? [];
      list.push(dependency);
      byConsumer.set(dependency.consumerRunId, list);
    }
    for (const [consumerRunId, inbound] of byConsumer) {
      const consumer = this.getRun(consumerRunId);
      if (!consumer || TERMINAL_RUN_STATUSES.has(consumer.status) || inbound.some((dependency) => dependency.status === "pending")) continue;
      const handoffs = inbound.map((dependency) => this.getCrossProjectHandoff(dependency.id));
      const tasks = this.listTasks({ runId: consumerRunId, limit: 1000 });
      if (inbound.some((dependency) => dependency.status === "failed")) {
        for (const task of tasks.filter((item) => ["staged", "blocked", "queued", "waiting_for_lease", "retry_waiting"].includes(item.status))) {
          this.updateTask(task.id, { status: "failed", error: "Required cross-project dependency or handoff failed", completedAt: now() });
        }
        for (const task of tasks.filter((item) => ["running", "approval_waiting", "agent_done", "validating", "integration_pending"].includes(item.status))) {
          this.updateTask(task.id, { status: "recovery_attention", error: "Cross-project handoff integrity changed after claim", completedAt: now() });
        }
        this.updateRun(consumerRunId, { status: "failed", completedAt: now(), metadata: { globalDependencyFailure: true } });
      } else if (consumer.status === "preparing" && inbound.every((dependency) => dependency.status === "skipped")) {
        for (const task of tasks.filter((item) => item.status === "staged")) this.updateTask(task.id, { status: "skipped", completedAt: now() });
        this.updateRun(consumerRunId, { status: "running", startedAt: now() });
        this.updateRun(consumerRunId, { status: "completed", completedAt: now(), metadata: { globalDependencySkipped: true } });
      } else if (consumer.status === "preparing" && inbound.every((dependency, index) => dependency.status === "satisfied" && handoffs[index]?.status === "received")) {
        this.releaseStagedRun(consumerRunId, { source: "cross_project_dependency" });
        releasedConsumer = true;
      }
    }
    graph = this.getGlobalRunGraph(globalRunId);
    const projected = graph.memberships.map((membership) => {
      const run = this.getRun(membership.runId);
      const tasks = this.listTasks({ runId: membership.runId, limit: 1000 });
      return {
        ...membership, status: run.status,
        attentionRequired: tasks.some((task) => ["recovery_attention", "integration_blocked"].includes(task.status)),
      };
    });
    const terminalStatus = deriveGlobalRunStatus(projected, { cancellationRequested: Boolean(graph.globalRun.cancellationRequestedAt) });
    if (terminalStatus) {
      const warnings = projected.filter((membership) => membership.membership === "optional" && membership.status !== "completed")
        .map((membership) => ({ runId: membership.runId, status: membership.status, cause: "optional_project_not_completed" }));
      const projection = { globalRunId, status: terminalStatus, revisionId: graph.revision.id, projects: projected.map(({ attentionRequired, ...membership }) => ({ ...membership, attentionRequired })), warnings };
      const timestamp = now();
      this.db.prepare(`
        INSERT INTO global_run_results (global_run_id, status, projection_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(global_run_id) DO UPDATE SET status = excluded.status, projection_json = excluded.projection_json, updated_at = excluded.updated_at
      `).run(globalRunId, terminalStatus, json(projection, {}), timestamp, timestamp);
      this.updateGlobalRun(globalRunId, { status: terminalStatus, completedAt: timestamp, metadata: { warningCount: warnings.length } });
    } else {
      const anyRunning = projected.some((membership) => membership.status === "running");
      const desired = anyRunning || releasedConsumer ? "running" : "waiting";
      if (graph.globalRun.status !== desired) this.updateGlobalRun(globalRunId, { status: desired });
    }
    return this.getGlobalRunGraph(globalRunId);
  }

  requestGlobalRunCancellation(globalRunId) {
    const globalRun = this.getGlobalRun(globalRunId);
    if (!globalRun) throw new Error(`Global Run not found: ${globalRunId}`);
    if (["completed", "failed", "cancelled", "attention_required"].includes(globalRun.status)) return this.getGlobalRunGraph(globalRunId);
    const requestedAt = globalRun.cancellationRequestedAt ?? now();
    this.db.prepare("UPDATE global_runs SET cancellation_requested_at = ?, updated_at = ? WHERE id = ? AND cancellation_requested_at IS NULL").run(requestedAt, requestedAt, globalRunId);
    if (!globalRun.cancellationRequestedAt) this.recordEvent("global_run", globalRunId, "global_run.cancellation_requested", { requestedAt });
    return this.getGlobalRunGraph(globalRunId);
  }

  cancelGlobalRun(globalRunId, options = {}) {
    const requested = this.requestGlobalRunCancellation(globalRunId);
    if (["completed", "failed", "cancelled", "attention_required"].includes(requested.globalRun.status)) return requested;
    const graph = this.getGlobalRunGraph(globalRunId);
    if (!options.childRunsCancelled) {
      for (const membership of graph.memberships) {
        const run = this.getRun(membership.runId);
        if (run && !TERMINAL_RUN_STATUSES.has(run.status)) this.cancelRun(run.id);
      }
    }
    this.updateGlobalRun(globalRunId, { status: "cancelled", completedAt: now() });
    return this.getGlobalRunGraph(globalRunId);
  }

  recoverGlobalRuns() {
    const recovered = { released: 0, projected: 0, cancelled: 0, failedPreGraph: 0 };
    for (const globalRun of this.listGlobalRuns({ limit: 500 }).filter((item) => !["completed", "failed", "cancelled", "attention_required"].includes(item.status))) {
      if (globalRun.cancellationRequestedAt) {
        this.cancelGlobalRun(globalRun.id);
        recovered.cancelled += 1;
        continue;
      }
      const graph = this.getGlobalRunGraph(globalRun.id);
      if (globalRun.status === "preparing" && graph.revision?.status === "validated") {
        this.releaseGlobalRun(globalRun.id);
        recovered.released += 1;
      } else if (["running", "waiting"].includes(globalRun.status)) {
        this.refreshGlobalRun(globalRun.id);
        recovered.projected += 1;
      } else if (["resolving_context", "planning", "preparing"].includes(globalRun.status) && !graph.revision) {
        this.updateGlobalRun(globalRun.id, { status: "failed", completedAt: now(), metadata: {
          failure: { code: "GLOBAL_PREPARATION_INTERRUPTED", cause: "Daemon restarted before the atomic Global Run graph was committed", repairable: true, nextAction: "Create a new Global Run revision." },
        } });
        recovered.failedPreGraph += 1;
      }
    }
    return recovered;
  }

  createTaskGraph(run, tasks) {
    if (!run?.id) throw new TypeError("Run id is required");
    validateTaskGraph(tasks);
    assertRunStatus(run.status ?? "preparing");
    for (const task of tasks) assertTaskStatus(task.status ?? "staged");
    const timestamp = run.createdAt ?? now();
    const preparedTasks = tasks.map((task) => ({
      ...task,
      metadata: taskContractMetadata({ ...task, status: task.status ?? "staged" }, timestamp),
    }));
    const runProjectId = this.#resolveProjectId(run.cwd ?? null, run.projectId ?? null, { sourceTable: "runs", sourceId: run.id });
    const taskProjectIds = new Map(preparedTasks.map((task) => [
      task.id,
      this.#resolveProjectId(task.cwd ?? run.cwd ?? null, task.projectId ?? runProjectId, { sourceTable: "tasks", sourceId: task.id }),
    ]));
    const invalidTask = preparedTasks.find((task) => task.metadata.contractStatus !== "validated");
    if (invalidTask) throw Object.assign(new Error(invalidTask.metadata.contractValidationError?.cause ?? `Task ${invalidTask.id} has no validated execution contract`), {
      code: invalidTask.metadata.contractValidationError?.code ?? "EXECUTION_CONTRACT_NOT_VALIDATED",
    });
    const nestedTransaction = this.db.isTransaction;
    this.db.exec(nestedTransaction ? "SAVEPOINT create_task_graph" : "BEGIN IMMEDIATE");
    try {
      const existingRow = this.db.prepare("SELECT * FROM runs WHERE id = ? OR (? IS NOT NULL AND request_key = ?)").get(run.id, run.requestKey ?? null, run.requestKey ?? null);
      const existingTasks = existingRow
        ? this.db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE json_extract(metadata_json, '$.runId') = ?").get(existingRow.id).count
        : 0;
      if (existingRow && (existingRow.id !== run.id || existingTasks > 0)) {
        this.db.exec(nestedTransaction ? "RELEASE create_task_graph" : "COMMIT");
        return { run: this.getRun(existingRow.id), tasks: this.listTasks({ runId: existingRow.id, limit: 1000 }), idempotent: true };
      }
      if (existingRow) {
        const existing = normalizeRun(existingRow);
        this.db.prepare(`
          UPDATE runs SET request_key = ?, plan_id = ?, name = ?, status = ?, cwd = ?, updated_at = ?,
            started_at = ?, completed_at = ?, metadata_json = ? WHERE id = ?
        `).run(
          run.requestKey ?? existing.requestKey,
          run.planId ?? existing.planId,
          run.name ?? existing.name,
          run.status ?? "preparing",
          run.cwd ?? existing.cwd,
          timestamp,
          run.startedAt ?? existing.startedAt,
          run.completedAt ?? existing.completedAt,
          json({ ...existing.metadata, ...(run.metadata ?? {}) }, {}),
          run.id,
        );
        if (runProjectId) this.db.prepare("UPDATE runs SET project_id = ? WHERE id = ?").run(runProjectId, run.id);
      } else {
        this.db.prepare(`
          INSERT INTO runs (id, request_key, plan_id, name, status, cwd, created_at, updated_at, started_at, completed_at, metadata_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          run.id, run.requestKey ?? null, run.planId ?? null, run.name ?? null,
          run.status ?? "preparing", run.cwd ?? null, timestamp, timestamp,
          run.startedAt ?? null, run.completedAt ?? null, json(run.metadata ?? {}, {}),
        );
        if (runProjectId) this.db.prepare("UPDATE runs SET project_id = ? WHERE id = ?").run(runProjectId, run.id);
      }
      const insertTask = this.db.prepare(`
        INSERT INTO tasks (
          id, status, prompt, cwd, source_thread_id, agent_id, mode, output, error,
          turn_id, role, required_capabilities_json, routing_json, created_at,
          started_at, completed_at, updated_at, worker_id, heartbeat_at, attempt,
          max_attempts, retry_delay_ms, next_retry_at, claim_token, version, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const insertDependency = this.db.prepare(`
        INSERT INTO task_dependencies (task_id, depends_on_task_id, created_at) VALUES (?, ?, ?)
      `);
      for (const task of preparedTasks) {
        insertTask.run(
          task.id, task.status ?? "staged", task.prompt, task.cwd ?? run.cwd ?? null,
          task.sourceThreadId ?? null, task.agentId ?? null, task.mode ?? null,
          task.output ?? null, task.error ?? null, task.turnId ?? null, task.role ?? null,
          json(task.requiredCapabilities ?? [], []), json(task.routing ?? null), timestamp,
          task.startedAt ?? null, task.completedAt ?? null, timestamp, task.workerId ?? null,
          task.heartbeatAt ?? null, task.attempt ?? 0, task.maxAttempts ?? 1,
          task.retryDelayMs ?? 0, task.nextRetryAt ?? null, task.claimToken ?? null,
          task.version ?? 0, json({ ...(task.metadata ?? {}), runId: run.id }, {}),
        );
        const taskProjectId = taskProjectIds.get(task.id);
        if (taskProjectId) this.db.prepare("UPDATE tasks SET project_id = ? WHERE id = ?").run(taskProjectId, task.id);
      }
      for (const task of preparedTasks) {
        for (const dependencyId of new Set(task.dependsOn ?? [])) insertDependency.run(task.id, dependencyId, timestamp);
      }
      this.db.exec(nestedTransaction ? "RELEASE create_task_graph" : "COMMIT");
    } catch (error) {
      if (nestedTransaction) this.db.exec("ROLLBACK TO create_task_graph; RELEASE create_task_graph");
      else this.db.exec("ROLLBACK");
      throw error;
    }
    this.recordEvent("run", run.id, `run.${run.status ?? "preparing"}`, { tasks: tasks.length, atomic: true, materialized: true });
    for (const task of tasks) this.recordEvent("task", task.id, "task.created", { status: task.status ?? "staged", dependencies: task.dependsOn ?? [], runId: run.id });
    return { run: this.getRun(run.id), tasks: this.listTasks({ runId: run.id, limit: 1000 }), idempotent: false };
  }

  replaceStagedTaskGraph(run, tasks) {
    if (!run?.id) throw new TypeError("Run id is required");
    validateTaskGraph(tasks);
    const timestamp = now();
    const preparedTasks = tasks.map((task) => ({
      ...task,
      metadata: taskContractMetadata({ ...task, status: task.status ?? "staged" }, timestamp),
    }));
    const invalidTask = preparedTasks.find((task) => task.metadata.contractStatus !== "validated");
    if (invalidTask) throw Object.assign(new Error(invalidTask.metadata.contractValidationError?.cause ?? `Task ${invalidTask.id} has no validated execution contract`), {
      code: invalidTask.metadata.contractValidationError?.code ?? "EXECUTION_CONTRACT_NOT_VALIDATED",
    });
    const existingForProject = this.getRun(run.id);
    if (!existingForProject) throw new Error(`Run not found: ${run.id}`);
    const runCwd = run.cwd ?? existingForProject.cwd ?? null;
    const runProjectId = this.#resolveProjectId(runCwd, run.projectId ?? existingForProject.projectId ?? null, { sourceTable: "runs", sourceId: run.id });
    const taskProjectIds = new Map(preparedTasks.map((task) => [
      task.id,
      this.#resolveProjectId(task.cwd ?? runCwd, task.projectId ?? runProjectId, { sourceTable: "tasks", sourceId: task.id }),
    ]));
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existingRow = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(run.id);
      if (!existingRow) throw new Error(`Run not found: ${run.id}`);
      const existing = normalizeRun(existingRow);
      const currentTasks = this.db.prepare("SELECT * FROM tasks WHERE json_extract(metadata_json, '$.runId') = ?").all(run.id).map(normalizeTask);
      const replaceable = ["preparing", "awaiting_user_start"].includes(existing.status)
        && existing.startedAt === null
        && currentTasks.every((task) => task.status === "staged" && !task.agentId && !task.turnId && !task.workerId && !task.claimToken);
      if (!replaceable) {
        const error = new Error(`Run ${run.id} cannot replace its graph after execution or thread binding`);
        error.code = "RUN_GRAPH_ACTIVE";
        throw error;
      }
      this.db.prepare(`
        DELETE FROM task_dependencies
        WHERE task_id IN (SELECT id FROM tasks WHERE json_extract(metadata_json, '$.runId') = ?)
           OR depends_on_task_id IN (SELECT id FROM tasks WHERE json_extract(metadata_json, '$.runId') = ?)
      `).run(run.id, run.id);
      this.db.prepare("DELETE FROM tasks WHERE json_extract(metadata_json, '$.runId') = ?").run(run.id);
      this.db.prepare(`
        UPDATE runs SET request_key = ?, plan_id = ?, name = ?, status = 'preparing', cwd = ?,
          updated_at = ?, started_at = NULL, completed_at = NULL, metadata_json = ? WHERE id = ?
      `).run(
        run.requestKey ?? existing.requestKey,
        run.planId ?? existing.planId,
        run.name ?? existing.name,
        run.cwd ?? existing.cwd,
        timestamp,
        json({ ...existing.metadata, ...(run.metadata ?? {}), graphReplacedAt: timestamp }, {}),
        run.id,
      );
      if (runProjectId) this.db.prepare("UPDATE runs SET project_id = ? WHERE id = ?").run(runProjectId, run.id);
      const insertTask = this.db.prepare(`
        INSERT INTO tasks (
          id, status, prompt, cwd, source_thread_id, agent_id, mode, output, error,
          turn_id, role, required_capabilities_json, routing_json, created_at,
          started_at, completed_at, updated_at, worker_id, heartbeat_at, attempt,
          max_attempts, retry_delay_ms, next_retry_at, claim_token, version, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const insertDependency = this.db.prepare("INSERT INTO task_dependencies (task_id, depends_on_task_id, created_at) VALUES (?, ?, ?)");
      for (const task of preparedTasks) {
        insertTask.run(
          task.id, task.status ?? "staged", task.prompt, task.cwd ?? run.cwd ?? existing.cwd ?? null,
          task.sourceThreadId ?? null, task.agentId ?? null, task.mode ?? null,
          task.output ?? null, task.error ?? null, task.turnId ?? null, task.role ?? null,
          json(task.requiredCapabilities ?? [], []), json(task.routing ?? null), timestamp,
          task.startedAt ?? null, task.completedAt ?? null, timestamp, task.workerId ?? null,
          task.heartbeatAt ?? null, task.attempt ?? 0, task.maxAttempts ?? 1,
          task.retryDelayMs ?? 0, task.nextRetryAt ?? null, task.claimToken ?? null,
          task.version ?? 0, json({ ...(task.metadata ?? {}), runId: run.id }, {}),
        );
        const taskProjectId = taskProjectIds.get(task.id);
        if (taskProjectId) this.db.prepare("UPDATE tasks SET project_id = ? WHERE id = ?").run(taskProjectId, task.id);
      }
      for (const task of preparedTasks) {
        for (const dependencyId of new Set(task.dependsOn ?? [])) insertDependency.run(task.id, dependencyId, timestamp);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    this.recordEvent("run", run.id, "run.graph_replaced", { tasks: tasks.length, atomic: true, planId: run.planId ?? null });
    for (const task of tasks) this.recordEvent("task", task.id, "task.created", { status: task.status ?? "staged", dependencies: task.dependsOn ?? [], runId: run.id, replacement: true });
    return { run: this.getRun(run.id), tasks: this.listTasks({ runId: run.id, limit: 1000 }), idempotent: false, replaced: true };
  }

  getRun(runId) {
    return normalizeRun(this.db.prepare("SELECT * FROM runs WHERE id = ?").get(runId));
  }

  listRuns(options = {}) {
    const clauses = [];
    const values = [];
    if (options.status) {
      clauses.push("status = ?");
      values.push(options.status);
    }
    if (options.cwd) addCwdScope(clauses, values, "cwd", options.cwd);
    if (options.projectId) { clauses.push("project_id = ?"); values.push(options.projectId); }
    const scope = options.scope ?? "active";
    if (scope === "active") clauses.push("archived_at IS NULL");
    else if (scope === "archived") clauses.push("archived_at IS NOT NULL");
    else if (scope !== "all") throw new TypeError(`Unsupported run scope: ${scope}`);
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    values.push(options.limit ?? 50);
    return this.db.prepare(`SELECT * FROM runs ${where} ORDER BY created_at DESC LIMIT ?`).all(...values).map(normalizeRun);
  }

  updateRun(runId, changes = {}, options = {}) {
    const existing = this.getRun(runId);
    if (!existing) throw new Error(`Run not found: ${runId}`);
    const status = changes.status ?? existing.status;
    if (status !== existing.status) transitionRun(existing.status, status, options);
    const timestamp = now();
    const metadata = { ...existing.metadata, ...(changes.metadata ?? {}) };
    if (TERMINAL_RUN_STATUSES.has(status)) metadata.dispatchPhase = status;
    this.db.prepare(`
      UPDATE runs SET request_key = ?, plan_id = ?, name = ?, status = ?, cwd = ?, updated_at = ?, started_at = ?, completed_at = ?, metadata_json = ?
      WHERE id = ?
    `).run(
      changes.requestKey ?? existing.requestKey,
      changes.planId ?? existing.planId,
      changes.name ?? existing.name,
      status,
      changes.cwd ?? existing.cwd,
      timestamp,
      changes.startedAt === undefined ? existing.startedAt : changes.startedAt,
      changes.completedAt === undefined ? existing.completedAt : changes.completedAt,
      json(metadata, {}),
      runId,
    );
    this.#assignProject("runs", runId, changes.cwd ?? existing.cwd, changes.projectId ?? existing.projectId ?? null);
    if (status !== existing.status) this.recordEvent("run", runId, `run.${status}`, { previousStatus: existing.status });
    return this.getRun(runId);
  }

  failPreparedRun(runId, failure = {}) {
    const run = this.getRun(runId);
    if (!run) throw new Error(`Run not found: ${runId}`);
    if (TERMINAL_RUN_STATUSES.has(run.status)) return { run, tasks: this.listTasks({ runId, limit: 1000 }), idempotent: true };
    if (!["preparing", "agents_prepared", "awaiting_user_start"].includes(run.status)) {
      throw Object.assign(new Error(`Run ${runId} cannot fail preparation from ${run.status}`), { code: "RUN_NOT_IN_PREPARATION" });
    }
    const tasks = this.listTasks({ runId, limit: 1000 });
    const unsafe = tasks.find((task) => !TERMINAL_TASK_STATUSES.has(task.status)
      && (task.attempt !== 0 || task.workerId || task.claimToken || task.agentId));
    if (unsafe) {
      throw Object.assign(new Error(`Task ${unsafe.id} has execution ownership and cannot be terminalized as a preparation failure`), {
        code: "PREPARATION_FAILURE_AFTER_EXECUTION_STARTED",
      });
    }
    for (const task of tasks) {
      if (!TERMINAL_TASK_STATUSES.has(task.status)) transitionTask(task.status, "failed");
    }
    transitionRun(run.status, "failed");

    const timestamp = now();
    const record = {
      type: failure.type ?? "infrastructure",
      category: failure.category ?? "environment",
      stage: failure.stage ?? "orchestrator_kickoff",
      code: failure.code ?? "RUN_PREPARATION_FAILED",
      cause: failure.cause ?? failure.message ?? "Run preparation failed",
      message: failure.message ?? failure.cause ?? "Run preparation failed",
      retryable: Boolean(failure.retryable),
      repairable: failure.repairable ?? Boolean(failure.retryable),
      nextAction: failure.nextAction ?? "retry_run",
      attemptBudget: { used: 0, max: 0, remaining: 0 },
      at: failure.at ?? timestamp,
    };
    const nestedTransaction = this.db.isTransaction;
    this.db.exec(nestedTransaction ? "SAVEPOINT fail_prepared_run" : "BEGIN IMMEDIATE");
    try {
      const updateTask = this.db.prepare(`
        UPDATE tasks SET status = 'failed', error = ?, completed_at = ?, updated_at = ?,
          worker_id = NULL, heartbeat_at = NULL, next_retry_at = NULL, claim_token = NULL,
          version = version + 1, metadata_json = ? WHERE id = ?
      `);
      for (const task of tasks) {
        if (TERMINAL_TASK_STATUSES.has(task.status)) continue;
        const metadata = {
          ...task.metadata,
          failure: record,
          failureHistory: [...(task.metadata?.failureHistory ?? []), record],
        };
        updateTask.run(record.cause, timestamp, timestamp, json(metadata, {}), task.id);
      }
      const runMetadata = {
        ...run.metadata,
        dispatchPhase: "failed",
        dispatchError: record.cause,
        failure: record,
        failureHistory: [...(run.metadata?.failureHistory ?? []), record],
      };
      this.db.prepare(`
        UPDATE runs SET status = 'failed', completed_at = ?, updated_at = ?, metadata_json = ? WHERE id = ?
      `).run(timestamp, timestamp, json(runMetadata, {}), runId);
      this.db.exec(nestedTransaction ? "RELEASE fail_prepared_run" : "COMMIT");
    } catch (error) {
      if (nestedTransaction) this.db.exec("ROLLBACK TO fail_prepared_run; RELEASE fail_prepared_run");
      else this.db.exec("ROLLBACK");
      throw error;
    }
    for (const task of tasks) {
      if (!TERMINAL_TASK_STATUSES.has(task.status)) {
        this.recordEvent("task", task.id, "task.failed", { previousStatus: task.status, preClaim: true, failure: record });
      }
    }
    this.recordEvent("run", runId, "run.failed", { previousStatus: run.status, preparationFailure: true, failure: record });
    this.projectRunResult(runId);
    this.createNotification({
      projectKey: run.cwd ?? "workspace",
      runId,
      kind: NOTIFICATION_KINDS.FAILED,
      title: "작업 시작 실패",
      body: `${run.name ?? runId} 작업을 시작하지 못했습니다. 실행 시도는 소비되지 않았습니다.`,
      dedupeKey: `${runId}:${NOTIFICATION_KINDS.FAILED}`,
    });
    return { run: this.getRun(runId), tasks: this.listTasks({ runId, limit: 1000 }), failure: record, idempotent: false };
  }

  refreshRun(runId) {
    const run = this.getRun(runId);
    if (!run) return null;
    if (TERMINAL_RUN_STATUSES.has(run.status)) return run;
    const tasks = this.listTasks({ runId, limit: 1000 });
    if (!tasks.length) return run;
    const status = deriveRunStatus(tasks);
    if (!status) return run;
    if (run.status === status) return run;
    const updated = this.updateRun(runId, { status, completedAt: now() });
    this.projectRunResult(runId);
    const notificationKind = classifyRunNotification(updated, tasks);
    if (notificationKind) {
      const policyBlocked = notificationKind === NOTIFICATION_KINDS.POLICY_BLOCKED;
      const attentionRequired = notificationKind === NOTIFICATION_KINDS.ATTENTION_REQUIRED;
      this.createNotification({
        projectKey: run.cwd ?? "workspace", runId, kind: notificationKind,
        title: status === "completed" ? "작업 완료" : policyBlocked ? "정책으로 작업 중단" : attentionRequired ? "판단 필요" : "작업 실패",
        body: status === "completed" ? `${run.name ?? runId} 작업이 완료되었습니다.` : policyBlocked ? `${run.name ?? runId} 작업이 권한 또는 정책 경계에서 중단되었습니다.` : attentionRequired ? `${run.name ?? runId} 작업을 계속하려면 사용자 판단이 필요합니다.` : `${run.name ?? runId} 작업 결과를 확인하세요.`,
        dedupeKey: `${runId}:${notificationKind}`,
      });
    }
    const parentGlobal = this.db.prepare("SELECT global_run_id FROM global_run_projects WHERE run_id = ? LIMIT 1").get(runId);
    if (parentGlobal) this.refreshGlobalRun(parentGlobal.global_run_id);
    return updated;
  }

  cancelRun(runId, options = {}) {
    const run = this.getRun(runId);
    if (!run) throw new Error(`Run not found: ${runId}`);
    if (!options.dispatchCancellationRequested) this.requestTurnDispatchCancellation({ parentRunId: runId });
    const tasks = this.listTasks({ runId, limit: 1000 });
    for (const task of tasks) this.cancelTask(task.id, { dispatchCancellationRequested: true });
    return this.updateRun(runId, { status: "cancelled", completedAt: now() });
  }

  archiveRun(runId) {
    const run = this.getRun(runId);
    if (!run) throw new Error(`Run not found: ${runId}`);
    if (run.archivedAt) return run;
    if (!["completed", "failed", "cancelled"].includes(run.status)) {
      throw Object.assign(new Error(`Run ${runId} must be terminal before archive (status: ${run.status})`), { code: "ARCHIVE_ACTIVE_RUN" });
    }
    const archivedAt = now();
    this.db.prepare("UPDATE runs SET archived_at = ?, updated_at = ? WHERE id = ? AND archived_at IS NULL").run(archivedAt, archivedAt, runId);
    this.recordEvent("run", runId, "run.archived", { status: run.status });
    return this.getRun(runId);
  }

  unarchiveRun(runId) {
    const run = this.getRun(runId);
    if (!run) throw new Error(`Run not found: ${runId}`);
    if (!run.archivedAt) return run;
    if (!["completed", "failed", "cancelled"].includes(run.status)) {
      throw Object.assign(new Error(`Run ${runId} must remain terminal while archived`), { code: "ARCHIVE_ACTIVE_RUN" });
    }
    const timestamp = now();
    this.db.prepare("UPDATE runs SET archived_at = NULL, updated_at = ? WHERE id = ? AND archived_at IS NOT NULL").run(timestamp, runId);
    this.recordEvent("run", runId, "run.unarchived", { status: run.status });
    return this.getRun(runId);
  }

  registerProject(cwd, options = {}) {
    const identity = canonicalizeProjectIdentity(cwd, options);
    const timestamp = now();
    this.db.prepare(`
      INSERT INTO projects (
        id, canonical_key, kind, canonical_root, repository_common_dir,
        identity_version, display_name, created_at, updated_at, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(canonical_key) DO UPDATE SET
        repository_common_dir = excluded.repository_common_dir,
        identity_version = excluded.identity_version,
        display_name = COALESCE(excluded.display_name, projects.display_name),
        updated_at = excluded.updated_at
    `).run(
      identity.id,
      identity.canonicalKey,
      identity.kind,
      identity.canonicalRoot,
      identity.repositoryCommonDir,
      identity.identityVersion,
      options.displayName ?? null,
      timestamp,
      timestamp,
      json(options.metadata ?? {}, {}),
    );
    const project = normalizeProject(this.db.prepare("SELECT * FROM projects WHERE canonical_key = ?").get(identity.canonicalKey));
    this.db.prepare(`
      INSERT INTO project_path_mappings (path, project_id, path_kind, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET project_id = excluded.project_id, path_kind = excluded.path_kind, updated_at = excluded.updated_at
    `).run(identity.requestedPath, project.id, identity.requestedPath === identity.canonicalRoot ? "root" : "member", timestamp, timestamp);
    if (identity.canonicalRoot !== identity.requestedPath) {
      this.db.prepare(`
        INSERT INTO project_path_mappings (path, project_id, path_kind, created_at, updated_at)
        VALUES (?, ?, 'root', ?, ?)
        ON CONFLICT(path) DO UPDATE SET project_id = excluded.project_id, path_kind = 'root', updated_at = excluded.updated_at
      `).run(identity.canonicalRoot, project.id, timestamp, timestamp);
    }
    return project;
  }

  getProject(projectId) {
    return normalizeProject(this.db.prepare("SELECT * FROM projects WHERE id = ?").get(projectId));
  }

  resolveProject(cwd, options = {}) {
    const identity = canonicalizeProjectIdentity(cwd, options);
    return normalizeProject(this.db.prepare("SELECT * FROM projects WHERE canonical_key = ?").get(identity.canonicalKey))
      ?? (options.create === false ? null : this.registerProject(cwd, options));
  }

  listProjects(options = {}) {
    const values = [];
    let where = "";
    if (options.kind) {
      where = "WHERE kind = ?";
      values.push(options.kind);
    }
    values.push(options.limit ?? 100);
    return this.db.prepare(`SELECT * FROM projects ${where} ORDER BY updated_at DESC LIMIT ?`).all(...values).map(normalizeProject);
  }

  listContextClaims(options = {}) {
    const clauses = [];
    const values = [];
    if (options.projectId) {
      clauses.push(options.includeGlobal ? "(project_id = ? OR scope = 'global')" : "project_id = ?");
      values.push(options.projectId);
    }
    if (options.status) { clauses.push("status = ?"); values.push(options.status); }
    if (options.statuses?.length) {
      clauses.push(`status IN (${options.statuses.map(() => "?").join(", ")})`);
      values.push(...options.statuses);
    }
    if (options.authority) { clauses.push("authority = ?"); values.push(options.authority); }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    values.push(options.limit ?? 100);
    return this.db.prepare(`SELECT * FROM context_claims ${where} ORDER BY created_at DESC LIMIT ?`).all(...values).map(normalizeContextClaim);
  }

  getContextClaim(claimId) {
    return normalizeContextClaim(this.db.prepare("SELECT * FROM context_claims WHERE id = ?").get(claimId));
  }

  createContextSnapshot(snapshot) {
    if (!snapshot?.resolutionKey || !snapshot?.objectiveHash || !snapshot?.requestedScopeHash || !snapshot?.resolverVersion) {
      throw new TypeError("Context snapshot requires resolutionKey, objectiveHash, requestedScopeHash, and resolverVersion");
    }
    const existing = this.db.prepare("SELECT id FROM context_snapshots WHERE resolution_key = ?").get(snapshot.resolutionKey);
    if (existing) return this.getContextSnapshot(existing.id);
    const id = snapshot.id ?? `context_snapshot_${randomUUID()}`;
    const timestamp = now();
    this.db.prepare(`
      INSERT INTO context_snapshots (
        id, resolution_key, project_id, objective_hash, requested_scope_hash,
        resolver_version, revision, status, fingerprint, error_json,
        created_at, validated_at, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'building', NULL, NULL, ?, NULL, ?)
    `).run(id, snapshot.resolutionKey, snapshot.projectId ?? null, snapshot.objectiveHash,
      snapshot.requestedScopeHash, snapshot.resolverVersion, snapshot.revision ?? 1,
      timestamp, json(snapshot.metadata ?? {}, {}));
    this.recordEvent("context_snapshot", id, "context_snapshot.building", { revision: snapshot.revision ?? 1 });
    return this.getContextSnapshot(id);
  }

  finalizeContextSnapshot(snapshotId, result) {
    const snapshot = this.getContextSnapshot(snapshotId);
    if (!snapshot) throw new Error(`Context snapshot not found: ${snapshotId}`);
    if (snapshot.status !== "building") return snapshot;
    if (!["validated", "invalid"].includes(result?.status)) throw new TypeError(`Unsupported context snapshot status: ${result?.status}`);
    if (result.status === "validated" && !result.fingerprint) throw new TypeError("Validated context snapshot requires a fingerprint");
    const selected = [...new Map((result.selected ?? []).map((item) => [item.claimId, item])).values()];
    const selectedIds = new Set(selected.map((item) => item.claimId));
    const excluded = [...new Map((result.excluded ?? []).map((item) => [item.claimId, item])).values()].filter((item) => !selectedIds.has(item.claimId));
    const timestamp = now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const linkClaim = this.db.prepare(`
        INSERT INTO context_snapshot_claims (snapshot_id, claim_id, disposition, score, reasons_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const item of [...selected.map((entry) => ({ ...entry, disposition: "selected" })), ...excluded.map((entry) => ({ ...entry, disposition: "excluded" }))]) {
        if (!this.getContextClaim(item.claimId)) throw new Error(`Context claim not found: ${item.claimId}`);
        linkClaim.run(snapshotId, item.claimId, item.disposition, item.score ?? 0, json(item.reasons ?? [], []), timestamp);
      }
      const insertConflict = this.db.prepare(`
        INSERT INTO context_conflicts (
          id, project_id, subject, scope, category, blocking, status, claim_ids_json,
          fingerprint, resolution_json, created_at, resolved_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(fingerprint) DO NOTHING
      `);
      const getConflict = this.db.prepare("SELECT id FROM context_conflicts WHERE fingerprint = ?");
      const linkConflict = this.db.prepare("INSERT OR IGNORE INTO context_snapshot_conflicts (snapshot_id, conflict_id, created_at) VALUES (?, ?, ?)");
      for (const conflict of result.conflicts ?? []) {
        insertConflict.run(conflict.id ?? `context_conflict_${randomUUID()}`, conflict.projectId ?? null,
          conflict.subject, conflict.scope, conflict.category, conflict.blocking ? 1 : 0,
          conflict.status ?? "unresolved", json(conflict.claimIds ?? [], []), conflict.fingerprint,
          json(conflict.resolution ?? null), timestamp, conflict.status === "resolved" ? timestamp : null);
        linkConflict.run(snapshotId, getConflict.get(conflict.fingerprint).id, timestamp);
      }
      this.db.prepare(`
        UPDATE context_snapshots SET status = ?, fingerprint = ?, error_json = ?, validated_at = ?, metadata_json = ?
        WHERE id = ? AND status = 'building'
      `).run(result.status, result.fingerprint ?? null, json(result.error ?? null), timestamp,
        json({ ...snapshot.metadata, ...(result.metadata ?? {}) }, {}), snapshotId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    this.recordEvent("context_snapshot", snapshotId, `context_snapshot.${result.status}`, {
      fingerprint: result.fingerprint ?? null,
      selectedCount: selected.length,
      excludedCount: excluded.length,
      conflictCount: result.conflicts?.length ?? 0,
    });
    return this.getContextSnapshot(snapshotId);
  }

  getContextSnapshot(snapshotId) {
    const snapshot = normalizeContextSnapshot(this.db.prepare("SELECT * FROM context_snapshots WHERE id = ?").get(snapshotId));
    if (!snapshot) return null;
    snapshot.claims = this.db.prepare(`
      SELECT sc.disposition, sc.score, sc.reasons_json, c.* FROM context_snapshot_claims sc
      JOIN context_claims c ON c.id = sc.claim_id WHERE sc.snapshot_id = ?
      ORDER BY sc.disposition DESC, sc.score DESC, c.id
    `).all(snapshotId).map((row) => ({ claim: normalizeContextClaim(row), disposition: row.disposition, score: row.score, reasons: parse(row.reasons_json, []) }));
    snapshot.conflicts = this.db.prepare(`
      SELECT c.* FROM context_snapshot_conflicts sc
      JOIN context_conflicts c ON c.id = sc.conflict_id WHERE sc.snapshot_id = ? ORDER BY c.created_at, c.id
    `).all(snapshotId).map(normalizeContextConflict);
    return snapshot;
  }

  getContextSnapshotByResolutionKey(resolutionKey) {
    const row = this.db.prepare("SELECT id FROM context_snapshots WHERE resolution_key = ?").get(resolutionKey);
    return row ? this.getContextSnapshot(row.id) : null;
  }

  listContextSnapshots(options = {}) {
    const clauses = [];
    const values = [];
    if (options.projectId) { clauses.push("project_id = ?"); values.push(options.projectId); }
    if (options.status) { clauses.push("status = ?"); values.push(options.status); }
    values.push(options.limit ?? 100);
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    return this.db.prepare(`SELECT id FROM context_snapshots ${where} ORDER BY created_at DESC LIMIT ?`).all(...values).map((row) => this.getContextSnapshot(row.id));
  }

  createContextClaim(claim) {
    const projectId = claim.projectId ?? (claim.cwd ? this.#resolveProjectId(claim.cwd, null, { sourceTable: "context_claims", sourceId: claim.id }) : null);
    const candidate = {
      ...claim,
      projectId,
      body: claim.body?.trim(),
      scope: claim.scope ?? (projectId ? "project" : "global"),
      authority: claim.authority ?? "model_inference",
      status: claim.status ?? "candidate",
    };
    validateContextClaim(candidate, { creating: true });
    const timestamp = now();
    const contentHash = claim.contentHash ?? contextContentHash(candidate);
    this.db.prepare(`
      INSERT INTO context_claims (
        id, project_id, kind, subject, body, scope, authority, status, revision,
        content_hash, created_at, updated_at, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO NOTHING
    `).run(
      candidate.id,
      projectId,
      candidate.kind,
      candidate.subject ?? null,
      candidate.body,
      candidate.scope,
      candidate.authority,
      candidate.status,
      candidate.revision ?? 1,
      contentHash,
      claim.createdAt ?? timestamp,
      timestamp,
      json(claim.metadata ?? {}, {}),
    );
    const persisted = this.getContextClaim(candidate.id);
    if (persisted.contentHash !== contentHash) {
      throw Object.assign(new Error(`Context claim id ${candidate.id} already refers to different content`), { code: "CONTEXT_CLAIM_ID_CONFLICT" });
    }
    return persisted;
  }

  addContextClaimSource(claimId, source) {
    if (!this.getContextClaim(claimId)) throw new Error(`Context claim not found: ${claimId}`);
    if (!source?.kind || !source?.id) throw Object.assign(new TypeError("Context claim source kind and id are required"), { code: "CONTEXT_SOURCE_REQUIRED" });
    const sourceDigest = source.digest ?? createHash("sha256").update(JSON.stringify({ kind: source.kind, id: source.id, revision: source.revision ?? "" })).digest("hex");
    this.db.prepare(`
      INSERT INTO context_claim_sources (
        claim_id, source_kind, source_id, source_revision, source_digest, created_at, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(claim_id, source_kind, source_id, source_revision)
      DO UPDATE SET source_digest = excluded.source_digest, metadata_json = excluded.metadata_json
    `).run(claimId, source.kind, source.id, String(source.revision ?? ""), sourceDigest, now(), json(source.metadata ?? {}, {}));
    return { claimId, kind: source.kind, id: source.id, revision: source.revision ?? null, digest: sourceDigest };
  }

  listContextClaimSources(claimId) {
    return this.db.prepare("SELECT * FROM context_claim_sources WHERE claim_id = ? ORDER BY created_at").all(claimId).map((row) => ({
      claimId: row.claim_id,
      kind: row.source_kind,
      id: row.source_id,
      revision: row.source_revision || null,
      digest: row.source_digest,
      createdAt: row.created_at,
      metadata: parse(row.metadata_json, {}),
    }));
  }

  activateContextClaim(claimId, options = {}) {
    const claim = this.getContextClaim(claimId);
    if (!claim) throw new Error(`Context claim not found: ${claimId}`);
    if (!["candidate", "disputed"].includes(claim.status)) throw Object.assign(new Error(`Context claim ${claimId} cannot activate from ${claim.status}`), { code: "CONTEXT_CLAIM_NOT_ACTIVATABLE" });
    const sources = this.listContextClaimSources(claimId);
    if (!sources.length) throw Object.assign(new Error("Active context claim requires provenance"), { code: "CONTEXT_PROVENANCE_REQUIRED" });
    const supersedes = [...new Set(options.supersedes ?? [])];
    const targets = supersedes.map((targetId) => this.getContextClaim(targetId));
    for (const target of targets) assertCanSupersede(claim, target);
    const timestamp = now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("UPDATE context_claims SET status = 'active', updated_at = ? WHERE id = ? AND status IN ('candidate', 'disputed')").run(timestamp, claimId);
      for (const target of targets) {
        this.db.prepare("UPDATE context_claims SET status = 'superseded', updated_at = ? WHERE id = ? AND status IN ('active', 'disputed')").run(timestamp, target.id);
        this.db.prepare(`
          INSERT OR IGNORE INTO context_claim_supersessions (
            incoming_claim_id, superseded_claim_id, reason, created_at, metadata_json
          ) VALUES (?, ?, ?, ?, ?)
        `).run(claimId, target.id, options.reason ?? "explicit_supersede", timestamp, json(options.metadata ?? {}, {}));
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.getContextClaim(claimId);
  }

  upsertThreadKnowledgeSnapshot(snapshot) {
    if (!snapshot?.threadId || !snapshot?.sourceDigest || !snapshot?.extractorVersion) {
      throw new TypeError("Thread knowledge snapshot requires threadId, sourceDigest, and extractorVersion");
    }
    const status = snapshot.status ?? "current";
    if (!["current", "superseded", "incomplete"].includes(status)) throw new TypeError(`Unsupported thread knowledge status: ${status}`);
    const existing = this.db.prepare(`
      SELECT * FROM thread_knowledge_snapshots
      WHERE thread_id = ? AND source_digest = ? AND extractor_version = ?
    `).get(snapshot.threadId, snapshot.sourceDigest, snapshot.extractorVersion);
    if (existing) return this.getThreadKnowledgeSnapshot(existing.id);
    const claimIds = [...new Set(snapshot.claimIds ?? [])];
    for (const claimId of claimIds) if (!this.getContextClaim(claimId)) throw new Error(`Context claim not found: ${claimId}`);
    const id = snapshot.id ?? `thread_snapshot_${createHash("sha256").update(`${snapshot.threadId}\n${snapshot.sourceDigest}\n${snapshot.extractorVersion}`).digest("hex").slice(0, 24)}`;
    const timestamp = now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (status === "current") this.db.prepare("UPDATE thread_knowledge_snapshots SET status = 'superseded' WHERE thread_id = ? AND status = 'current'").run(snapshot.threadId);
      this.db.prepare(`
        INSERT INTO thread_knowledge_snapshots (
          id, thread_id, through_turn_id, project_id, role, topics_json, source_digest,
          extractor_version, status, created_at, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, snapshot.threadId, snapshot.throughTurnId ?? null, snapshot.projectId ?? null, snapshot.role ?? null, json([...new Set(snapshot.topics ?? [])], []), snapshot.sourceDigest, snapshot.extractorVersion, status, timestamp, json(snapshot.metadata ?? {}, {}));
      const link = this.db.prepare("INSERT INTO thread_knowledge_claims (snapshot_id, claim_id, created_at) VALUES (?, ?, ?)");
      for (const claimId of claimIds) link.run(id, claimId, timestamp);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.getThreadKnowledgeSnapshot(id);
  }

  getThreadKnowledgeSnapshot(snapshotId) {
    const snapshot = normalizeThreadKnowledgeSnapshot(this.db.prepare("SELECT * FROM thread_knowledge_snapshots WHERE id = ?").get(snapshotId));
    if (snapshot) snapshot.claimIds = this.db.prepare("SELECT claim_id FROM thread_knowledge_claims WHERE snapshot_id = ? ORDER BY claim_id").all(snapshotId).map((row) => row.claim_id);
    return snapshot;
  }

  listThreadKnowledgeSnapshots(options = {}) {
    const clauses = [];
    const values = [];
    if (options.threadId) { clauses.push("thread_id = ?"); values.push(options.threadId); }
    if (options.projectId) { clauses.push("project_id = ?"); values.push(options.projectId); }
    if (options.status) { clauses.push("status = ?"); values.push(options.status); }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    values.push(options.limit ?? 100);
    return this.db.prepare(`SELECT * FROM thread_knowledge_snapshots ${where} ORDER BY created_at DESC LIMIT ?`).all(...values).map((row) => this.getThreadKnowledgeSnapshot(row.id));
  }

  recordThreadLineage(lineage) {
    if (!lineage?.threadId || !lineage?.parentThreadId) throw new TypeError("Thread lineage requires threadId and parentThreadId");
    const relationship = lineage.relationship ?? "fork";
    this.db.prepare(`
      INSERT INTO thread_lineage (
        thread_id, parent_thread_id, relationship, inherited_snapshot_id, created_at, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(thread_id, parent_thread_id, relationship) DO UPDATE SET
        inherited_snapshot_id = COALESCE(excluded.inherited_snapshot_id, thread_lineage.inherited_snapshot_id),
        metadata_json = excluded.metadata_json
    `).run(lineage.threadId, lineage.parentThreadId, relationship, lineage.inheritedSnapshotId ?? null, now(), json(lineage.metadata ?? {}, {}));
    return normalizeThreadLineage(this.db.prepare("SELECT * FROM thread_lineage WHERE thread_id = ? AND parent_thread_id = ? AND relationship = ?").get(lineage.threadId, lineage.parentThreadId, relationship));
  }

  listThreadLineage(options = {}) {
    const clauses = [];
    const values = [];
    if (options.threadId) { clauses.push("thread_id = ?"); values.push(options.threadId); }
    if (options.parentThreadId) { clauses.push("parent_thread_id = ?"); values.push(options.parentThreadId); }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    values.push(options.limit ?? 100);
    return this.db.prepare(`SELECT * FROM thread_lineage ${where} ORDER BY created_at DESC LIMIT ?`).all(...values).map(normalizeThreadLineage);
  }

  recordRoutingDecision(decision) {
    if (!decision?.decision || !["reuse", "fork", "spawn", "ephemeral", "wait"].includes(decision.decision)) throw new TypeError("Routing decision must be reuse, fork, spawn, ephemeral, or wait");
    const payload = {
      taskId: decision.taskId ?? null,
      runId: decision.runId ?? null,
      projectId: decision.projectId ?? null,
      contextSnapshotId: decision.contextSnapshotId ?? null,
      decision: decision.decision,
      selectedAgentId: decision.selectedAgentId ?? null,
      candidates: decision.candidates ?? [],
      evidence: decision.evidence ?? [],
      rejectionReasons: decision.rejectionReasons ?? [],
      provenance: decision.provenance ?? {},
    };
    const fingerprint = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
    const id = decision.id ?? `routing_${randomUUID()}`;
    this.db.prepare(`
      INSERT INTO routing_decisions (
        id, task_id, run_id, project_id, context_snapshot_id, decision, selected_agent_id,
        candidates_json, evidence_json, rejection_reasons_json, provenance_json, fingerprint, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, payload.taskId, payload.runId, payload.projectId, payload.contextSnapshotId, payload.decision, payload.selectedAgentId, json(payload.candidates, []), json(payload.evidence, []), json(payload.rejectionReasons, []), json(payload.provenance, {}), fingerprint, now());
    return normalizeRoutingDecision(this.db.prepare("SELECT * FROM routing_decisions WHERE id = ?").get(id));
  }

  listRoutingDecisions(options = {}) {
    const clauses = [];
    const values = [];
    if (options.taskId) { clauses.push("task_id = ?"); values.push(options.taskId); }
    if (options.runId) { clauses.push("run_id = ?"); values.push(options.runId); }
    if (options.projectId) { clauses.push("project_id = ?"); values.push(options.projectId); }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    values.push(options.limit ?? 100);
    return this.db.prepare(`SELECT * FROM routing_decisions ${where} ORDER BY created_at DESC LIMIT ?`).all(...values).map(normalizeRoutingDecision);
  }

  listMigrationAttention(options = {}) {
    const clauses = [];
    const values = [];
    if (options.status) { clauses.push("status = ?"); values.push(options.status); }
    if (options.kind) { clauses.push("kind = ?"); values.push(options.kind); }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    values.push(options.limit ?? 100);
    return this.db.prepare(`SELECT * FROM migration_attention ${where} ORDER BY created_at DESC LIMIT ?`).all(...values).map(normalizeMigrationAttention);
  }

  upsertMemory(memory) {
    if (!memory?.cwd || !memory?.content?.trim()) throw new TypeError("Memory cwd and content are required");
    const id = memory.id ?? `memory_${randomUUID()}`;
    const timestamp = now();
    this.db.prepare(`
      INSERT INTO project_memories (
        id, cwd, kind, title, content, tags_json, source, authority, subject, semantic_version, supersedes_json, confidence,
        created_at, updated_at, last_used_at, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        cwd = excluded.cwd,
        kind = excluded.kind,
        title = excluded.title,
        content = excluded.content,
        tags_json = excluded.tags_json,
        source = excluded.source,
        authority = excluded.authority,
        subject = excluded.subject,
        semantic_version = excluded.semantic_version,
        supersedes_json = excluded.supersedes_json,
        confidence = excluded.confidence,
        updated_at = excluded.updated_at,
        metadata_json = excluded.metadata_json
    `).run(
      id,
      memory.cwd,
      memory.kind ?? "note",
      memory.title ?? null,
      memory.content.trim(),
      json([...new Set(memory.tags ?? [])], []),
      memory.source ?? "user",
      memory.authority ?? memory.metadata?.authority ?? (["repository", "runtime"].includes(memory.source) ? "primary" : ["user", "control_plane"].includes(memory.source ?? "user") ? "authoritative" : "reference"),
      memory.subject ?? memory.metadata?.subject ?? ((memory.semanticVersion ?? memory.metadata?.semanticVersion) && memory.title ? String(memory.title).trim().toLowerCase() : null),
      memory.semanticVersion ?? memory.metadata?.semanticVersion ?? null,
      json([...new Set(memory.supersedes ?? memory.metadata?.supersedes ?? [])], []),
      memory.confidence ?? 1,
      memory.createdAt ?? timestamp,
      timestamp,
      memory.lastUsedAt ?? null,
      json(memory.metadata ?? {}, {}),
    );
    this.recordEvent("memory", id, memory.id ? "memory.updated" : "memory.created", {
      cwd: memory.cwd,
      kind: memory.kind ?? "note",
      source: memory.source ?? "user",
    });
    this.#backfillMemoryClaim(id);
    return this.getMemory(id);
  }

  getMemory(memoryId) {
    return normalizeMemory(this.db.prepare("SELECT * FROM project_memories WHERE id = ?").get(memoryId));
  }

  listMemories(options = {}) {
    const clauses = [];
    const values = [];
    if (options.cwd) addCwdScope(clauses, values, "cwd", options.cwd);
    if (options.projectId) { clauses.push("project_id = ?"); values.push(options.projectId); }
    if (options.kind) {
      clauses.push("kind = ?");
      values.push(options.kind);
    }
    if (options.source) {
      clauses.push("source = ?");
      values.push(options.source);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    values.push(options.limit ?? 200);
    return this.db.prepare(`
      SELECT * FROM project_memories ${where}
      ORDER BY COALESCE(last_used_at, updated_at) DESC, confidence DESC
      LIMIT ?
    `).all(...values).map(normalizeMemory);
  }

  touchMemories(memoryIds) {
    if (!memoryIds?.length) return 0;
    const statement = this.db.prepare("UPDATE project_memories SET last_used_at = ? WHERE id = ?");
    const timestamp = now();
    let changed = 0;
    for (const memoryId of new Set(memoryIds)) changed += Number(statement.run(timestamp, memoryId).changes);
    return changed;
  }

  deleteMemory(memoryId) {
    const existing = this.getMemory(memoryId);
    if (!existing) return null;
    this.db.prepare("DELETE FROM project_memories WHERE id = ?").run(memoryId);
    this.recordEvent("memory", memoryId, "memory.deleted", { cwd: existing.cwd, kind: existing.kind });
    return existing;
  }

  createPlan(plan) {
    if (!plan?.id || !plan?.objective?.trim()) throw new TypeError("Plan id and objective are required");
    const timestamp = now();
    if (plan.requestKey) {
      const existing = this.db.prepare("SELECT * FROM plans WHERE request_key = ?").get(plan.requestKey);
      if (existing) return normalizePlan(existing);
    }
    this.db.prepare(`
      INSERT INTO plans (
        id, request_key, objective, cwd, status, version, planner_agent_id,
        plan_json, synthesis_json, feedback, created_at, updated_at, completed_at, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      plan.id,
      plan.requestKey ?? null,
      plan.objective.trim(),
      plan.cwd ?? null,
      plan.status ?? "planning",
      plan.version ?? 1,
      plan.plannerAgentId ?? null,
      json(plan.plan ?? null),
      json(plan.synthesis ?? null),
      plan.feedback ?? null,
      timestamp,
      timestamp,
      plan.completedAt ?? null,
      json(plan.metadata ?? {}, {}),
    );
    this.#assignProject("plans", plan.id, plan.cwd ?? null, plan.projectId ?? null);
    this.recordEvent("plan", plan.id, `plan.${plan.status ?? "planning"}`, { objective: plan.objective, cwd: plan.cwd ?? null });
    return this.getPlan(plan.id);
  }

  getPlan(planId) {
    return normalizePlan(this.db.prepare("SELECT * FROM plans WHERE id = ?").get(planId));
  }

  listPlans(options = {}) {
    const clauses = [];
    const values = [];
    if (options.cwd) addCwdScope(clauses, values, "cwd", options.cwd);
    if (options.projectId) { clauses.push("project_id = ?"); values.push(options.projectId); }
    if (options.status) { clauses.push("status = ?"); values.push(options.status); }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    values.push(options.limit ?? 50);
    return this.db.prepare(`SELECT * FROM plans ${where} ORDER BY updated_at DESC LIMIT ?`).all(...values).map(normalizePlan);
  }

  updatePlan(planId, changes = {}) {
    const existing = this.getPlan(planId);
    if (!existing) throw new Error(`Plan not found: ${planId}`);
    const status = changes.status ?? existing.status;
    this.db.prepare(`
      UPDATE plans SET status = ?, version = ?, planner_agent_id = ?, plan_json = ?,
        synthesis_json = ?, feedback = ?, updated_at = ?, completed_at = ?, metadata_json = ?
      WHERE id = ?
    `).run(
      status,
      changes.version ?? existing.version,
      changes.plannerAgentId ?? existing.plannerAgentId,
      json(changes.plan === undefined ? existing.plan : changes.plan),
      json(changes.synthesis === undefined ? existing.synthesis : changes.synthesis),
      changes.feedback === undefined ? existing.feedback : changes.feedback,
      now(),
      changes.completedAt === undefined ? existing.completedAt : changes.completedAt,
      json({ ...existing.metadata, ...(changes.metadata ?? {}) }, {}),
      planId,
    );
    if (status !== existing.status) this.recordEvent("plan", planId, `plan.${status}`, { previousStatus: existing.status });
    if (changes.plan !== undefined) {
      this.db.prepare(`
        INSERT OR IGNORE INTO plan_revisions (plan_id, version, plan_json, feedback, created_at, metadata_json)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(planId, changes.version ?? existing.version, json(changes.plan), changes.feedback ?? existing.feedback, now(), json(changes.metadata ?? {}, {}));
    }
    this.#assignProject("plans", planId, changes.cwd ?? existing.cwd, changes.projectId ?? existing.projectId ?? null);
    return this.getPlan(planId);
  }

  listPlanRevisions(planId) {
    return this.db.prepare("SELECT * FROM plan_revisions WHERE plan_id = ? ORDER BY version").all(planId).map((row) => ({
      planId: row.plan_id,
      version: row.version,
      plan: parse(row.plan_json, null),
      feedback: row.feedback,
      createdAt: row.created_at,
      metadata: parse(row.metadata_json, {}),
    }));
  }

  createApproval(approval) {
    if (!approval?.id || !approval?.method) throw new TypeError("Approval id and method are required");
    const timestamp = now();
    this.db.prepare(`
      INSERT INTO approvals (
        id, task_id, agent_id, thread_id, turn_id, method, status,
        request_json, decision, created_at, resolved_at, expires_at, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, NULL, ?, NULL, ?, ?)
    `).run(
      approval.id,
      approval.taskId ?? null,
      approval.agentId ?? approval.threadId ?? null,
      approval.threadId ?? null,
      approval.turnId ?? null,
      approval.method,
      json(approval.request ?? {}, {}),
      timestamp,
      approval.expiresAt ?? new Date(Date.now() + 15 * 60_000).toISOString(),
      json(approval.metadata ?? {}, {}),
    );
    this.recordEvent("approval", approval.id, "approval.requested", { taskId: approval.taskId ?? null, method: approval.method });
    const task = approval.taskId ? this.getTask(approval.taskId) : null;
    const run = task?.metadata?.runId ? this.getRun(task.metadata.runId) : null;
    this.createNotification({
      projectKey: run?.cwd ?? task?.cwd ?? "workspace", runId: run?.id, taskId: task?.id,
      kind: NOTIFICATION_KINDS.ATTENTION_REQUIRED, title: "판단 필요",
      body: `${task?.metadata?.title ?? task?.prompt ?? "에이전트 작업"}에 사용자 판단이 필요합니다.`,
      dedupeKey: `approval:${approval.id}`,
    });
    return this.getApproval(approval.id);
  }

  getApproval(approvalId) {
    return normalizeApproval(this.db.prepare("SELECT * FROM approvals WHERE id = ?").get(approvalId));
  }

  listApprovals(options = {}) {
    const clauses = [];
    const values = [];
    if (options.status) { clauses.push("status = ?"); values.push(options.status); }
    if (options.taskId) { clauses.push("task_id = ?"); values.push(options.taskId); }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    values.push(options.limit ?? 100);
    return this.db.prepare(`SELECT * FROM approvals ${where} ORDER BY created_at DESC LIMIT ?`).all(...values).map(normalizeApproval);
  }

  resolveApproval(approvalId, decision, metadata = {}) {
    if (!["accept", "decline"].includes(decision)) throw new Error(`Unsupported approval decision: ${decision}`);
    const timestamp = now();
    const row = this.db.prepare(`
      UPDATE approvals SET status = 'resolved', decision = ?, resolved_at = ?, metadata_json = ?
      WHERE id = ? AND status = 'pending'
      RETURNING *
    `).get(decision, timestamp, json(metadata, {}), approvalId);
    if (!row) return null;
    this.markNotificationReadByDedupeKey(`approval:${approvalId}`);
    this.recordEvent("approval", approvalId, `approval.${decision}`, { taskId: row.task_id });
    return normalizeApproval(row);
  }

  enqueueProjectPreparation(item) {
    if (!item?.runId || !item?.projectKey) throw new TypeError("Queue runId and projectKey are required");
    const timestamp = now();
    const id = item.id ?? `queue_${item.runId}`;
    this.db.prepare(`
      INSERT INTO project_queue_items (
        id, project_key, run_id, cwd, status, sequence, lease_owner, lease_token,
        lease_expires_at, attempt, max_attempts, not_before, last_error,
        payload_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'queued', COALESCE((SELECT MAX(sequence) + 1 FROM project_queue_items), 1), NULL, NULL, NULL, 0, ?, NULL, NULL, ?, ?, ?)
      ON CONFLICT(run_id) DO UPDATE SET payload_json = excluded.payload_json, updated_at = excluded.updated_at
    `).run(id, item.projectKey, item.runId, item.cwd ?? item.projectKey, item.maxAttempts ?? 3, json(item.payload ?? {}, {}), timestamp, timestamp);
    return this.getProjectQueueItemByRun(item.runId);
  }

  getProjectQueueItemByRun(runId) {
    return normalizeQueueItem(this.db.prepare("SELECT * FROM project_queue_items WHERE run_id = ?").get(runId));
  }

  listProjectQueue(options = {}) {
    const clauses = [];
    const values = [];
    if (options.status) { clauses.push("status = ?"); values.push(options.status); }
    if (options.projectKey) { clauses.push("project_key = ?"); values.push(options.projectKey); }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    values.push(options.limit ?? 200);
    return this.db.prepare(`SELECT * FROM project_queue_items ${where} ORDER BY sequence LIMIT ?`).all(...values).map(normalizeQueueItem);
  }

  recoverProjectQueue() {
    const timestamp = now();
    const result = this.db.prepare(`
      UPDATE project_queue_items SET status = 'queued', lease_owner = NULL, lease_token = NULL,
        lease_expires_at = NULL, updated_at = ?
      WHERE status = 'leased' AND lease_expires_at <= ?
    `).run(timestamp, timestamp);
    return Number(result.changes);
  }

  claimProjectPreparation(workerId, leaseMs = 300_000) {
    const timestamp = now();
    this.recoverProjectQueue();
    const token = randomUUID();
    const expiresAt = new Date(Date.now() + leaseMs).toISOString();
    const row = this.db.prepare(`
      UPDATE project_queue_items
      SET status = 'leased', lease_owner = ?, lease_token = ?, lease_expires_at = ?,
          attempt = attempt + 1, updated_at = ?
      WHERE id = (
        SELECT q.id FROM project_queue_items q
        WHERE q.status IN ('queued', 'retry_waiting')
          AND (q.not_before IS NULL OR q.not_before <= ?)
          AND NOT EXISTS (
            SELECT 1 FROM project_queue_items active
            WHERE active.project_key = q.project_key AND active.status = 'leased'
          )
        ORDER BY q.sequence LIMIT 1
      )
      RETURNING *
    `).get(workerId, token, expiresAt, timestamp, timestamp);
    return normalizeQueueItem(row);
  }

  completeProjectPreparation(id, workerId, leaseToken) {
    const row = this.db.prepare(`
      UPDATE project_queue_items SET status = 'completed', lease_owner = NULL, lease_token = NULL,
        lease_expires_at = NULL, updated_at = ?
      WHERE id = ? AND lease_owner = ? AND lease_token = ? AND status = 'leased'
      RETURNING *
    `).get(now(), id, workerId, leaseToken);
    return normalizeQueueItem(row);
  }

  failProjectPreparation(id, workerId, leaseToken, error, retryDelayMs = 1_000) {
    const current = normalizeQueueItem(this.db.prepare("SELECT * FROM project_queue_items WHERE id = ? AND lease_owner = ? AND lease_token = ?").get(id, workerId, leaseToken));
    if (!current) return null;
    const retry = current.attempt < current.maxAttempts;
    const row = this.db.prepare(`
      UPDATE project_queue_items SET status = ?, lease_owner = NULL, lease_token = NULL,
        lease_expires_at = NULL, not_before = ?, last_error = ?, updated_at = ?
      WHERE id = ? AND lease_owner = ? AND lease_token = ? RETURNING *
    `).get(retry ? "retry_waiting" : "dead", retry ? new Date(Date.now() + retryDelayMs).toISOString() : null, String(error), now(), id, workerId, leaseToken);
    return normalizeQueueItem(row);
  }

  createNotification(notification) {
    if (!notification?.kind || !notification?.dedupeKey) throw new TypeError("Notification kind and dedupeKey are required");
    const kind = normalizeNotificationKind(notification.kind);
    const presentation = notificationPresentation(kind);
    const timestamp = now();
    const id = notification.id ?? `notification_${randomUUID()}`;
    const inserted = this.db.prepare(`
      INSERT OR IGNORE INTO notifications (
        id, project_key, run_id, task_id, kind, severity, title, body, dedupe_key, created_at, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, notification.projectKey ?? "workspace", notification.runId ?? null, notification.taskId ?? null,
      kind, notification.severity ?? presentation.severity, notification.title ?? presentation.label,
      notification.body ?? "", notification.dedupeKey, timestamp, json(notification.metadata ?? {}, {}));
    if (inserted.changes) this.recordEvent("notification", id, `notification.${kind}`, { runId: notification.runId ?? null, taskId: notification.taskId ?? null });
    return normalizeNotification(this.db.prepare(`
      SELECT n.*, r.read_at FROM notifications n
      LEFT JOIN notification_receipts r ON r.notification_id = n.id AND r.audience_id = 'local'
      WHERE n.dedupe_key = ?
    `).get(notification.dedupeKey));
  }

  listNotifications(options = {}) {
    const clauses = [];
    const values = [options.audienceId ?? "local"];
    if (options.cwd) { clauses.push("(n.project_key = ? OR n.project_key LIKE ? || '/%' OR ? LIKE n.project_key || '/%')"); values.push(options.cwd, options.cwd, options.cwd); }
    if (options.runId) { clauses.push("n.run_id = ?"); values.push(options.runId); }
    if (options.unread === true) clauses.push("r.read_at IS NULL");
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    values.push(options.limit ?? 100);
    return this.db.prepare(`
      SELECT n.*, r.read_at FROM notifications n
      LEFT JOIN notification_receipts r ON r.notification_id = n.id AND r.audience_id = ?
      ${where} ORDER BY n.created_at DESC LIMIT ?
    `).all(...values).map(normalizeNotification);
  }

  markNotificationRead(notificationId, audienceId = "local") {
    if (!this.db.prepare("SELECT 1 FROM notifications WHERE id = ?").get(notificationId)) return null;
    this.db.prepare(`INSERT INTO notification_receipts (notification_id, audience_id, read_at)
      VALUES (?, ?, ?) ON CONFLICT(notification_id, audience_id) DO UPDATE SET read_at = excluded.read_at`).run(notificationId, audienceId, now());
    return this.listNotifications({ audienceId, limit: 1000 }).find((item) => item.id === notificationId) ?? null;
  }

  markNotificationReadByDedupeKey(dedupeKey, audienceId = "local") {
    const row = this.db.prepare("SELECT id FROM notifications WHERE dedupe_key = ?").get(dedupeKey);
    return row ? this.markNotificationRead(row.id, audienceId) : null;
  }

  markProjectNotificationsRead(cwd, audienceId = "local") {
    const timestamp = now();
    const result = this.db.prepare(`
      INSERT INTO notification_receipts (notification_id, audience_id, read_at)
      SELECT id, ?, ? FROM notifications
      WHERE project_key = ? OR project_key LIKE ? || '/%' OR ? LIKE project_key || '/%'
      ON CONFLICT(notification_id, audience_id) DO UPDATE SET read_at = excluded.read_at
    `).run(audienceId, timestamp, cwd, cwd, cwd);
    return Number(result.changes);
  }

  projectRunResult(runId) {
    const run = this.getRun(runId);
    if (!run) return null;
    const tasks = this.listTasks({ runId, limit: 1000 });
    const taskResults = tasks.map((task) => ({
      id: task.id,
      title: task.metadata?.title ?? task.prompt.slice(0, 80),
      status: task.status,
      output: task.output,
      error: task.error,
      failure: task.metadata?.failure ?? null,
      completionVerdict: task.metadata?.completionVerdict ?? null,
      postconditionEvidence: task.metadata?.postconditionEvidence ?? null,
    }));
    const validations = tasks.filter((task) => task.metadata?.validation).map((task) => ({ taskId: task.id, ...task.metadata.validation }));
    const artifacts = tasks.flatMap((task) => {
      const artifact = task.metadata?.integration?.artifact ?? task.metadata?.artifact ?? null;
      return artifact ? [{ taskId: task.id, ...artifact }] : [];
    });
    const failures = tasks.filter((task) => !SUCCESSFUL_TASK_STATUSES.has(task.status));
    const warnings = tasks.filter((task) => task.status === "completed_with_warnings");
    const summary = run.status === "completed"
      ? warnings.length ? `${tasks.length}개 작업이 완료되었고 ${warnings.length}개에 경고가 있습니다.` : `${tasks.length}개 작업이 완료되었습니다.`
      : `${tasks.length}개 중 ${failures.length}개 작업에 확인이 필요합니다.`;
    const timestamp = now();
    this.db.prepare(`
      INSERT INTO run_results (run_id, status, summary, task_results_json, validation_json, artifacts_json,
        unresolved_risks_json, synthesis_status, synthesis_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'not_applicable', NULL, ?, ?)
      ON CONFLICT(run_id) DO UPDATE SET status = excluded.status, summary = excluded.summary,
        task_results_json = excluded.task_results_json, validation_json = excluded.validation_json,
        artifacts_json = excluded.artifacts_json, unresolved_risks_json = excluded.unresolved_risks_json,
        updated_at = excluded.updated_at
    `).run(runId, run.status, summary, json(taskResults, []), json(validations, []), json(artifacts, []), json(failures.map((task) => task.error ?? `${task.id}: ${task.status}`), []), timestamp, timestamp);
    return this.getRunResult(runId);
  }

  getRunResult(runId) {
    return normalizeRunResult(this.db.prepare("SELECT * FROM run_results WHERE run_id = ?").get(runId));
  }

  updateRunResultSynthesis(runId, changes = {}) {
    const existing = this.getRunResult(runId) ?? this.projectRunResult(runId);
    if (!existing) return null;
    this.db.prepare(`
      UPDATE run_results SET synthesis_status = ?, synthesis_json = ?, updated_at = ?
      WHERE run_id = ?
    `).run(
      changes.status ?? existing.synthesisStatus,
      json(changes.synthesis === undefined ? existing.synthesis : changes.synthesis),
      now(),
      runId,
    );
    return this.getRunResult(runId);
  }

  enqueueControlDelivery(delivery) {
    if (!delivery?.runId || !delivery?.originThreadId) throw new TypeError("Control delivery runId and originThreadId are required");
    const timestamp = now();
    const deliveryKey = delivery.deliveryKey ?? `${delivery.runId}:${delivery.originThreadId}`;
    const id = delivery.id ?? `delivery_${randomUUID()}`;
    assertDeliveryStatus("pending");
    this.db.prepare(`
      INSERT INTO control_result_deliveries (
        id, delivery_key, run_id, origin_thread_id, origin_turn_id, status, payload_json,
        attempt, max_attempts, not_before, last_error, delivered_turn_id,
        created_at, updated_at, delivered_at
      ) VALUES (?, ?, ?, ?, ?, 'pending', ?, 0, ?, ?, NULL, NULL, ?, ?, NULL)
      ON CONFLICT(delivery_key) DO UPDATE SET
        payload_json = excluded.payload_json,
        origin_turn_id = COALESCE(control_result_deliveries.origin_turn_id, excluded.origin_turn_id),
        updated_at = excluded.updated_at
    `).run(
      id, deliveryKey, delivery.runId, delivery.originThreadId, delivery.originTurnId ?? null,
      json(delivery.payload ?? {}, {}), delivery.maxAttempts ?? 20,
      delivery.notBefore ?? timestamp, timestamp, timestamp,
    );
    return this.getControlDeliveryByKey(deliveryKey);
  }

  getControlDeliveryByKey(deliveryKey) {
    return normalizeControlDelivery(this.db.prepare("SELECT * FROM control_result_deliveries WHERE delivery_key = ?").get(deliveryKey));
  }

  listControlDeliveries(options = {}) {
    const clauses = [];
    const values = [];
    if (options.runId) { clauses.push("run_id = ?"); values.push(options.runId); }
    if (options.originThreadId) { clauses.push("origin_thread_id = ?"); values.push(options.originThreadId); }
    if (options.status) {
      const statuses = Array.isArray(options.status) ? options.status : [options.status];
      for (const status of statuses) assertDeliveryStatus(status);
      if (statuses.length) {
        clauses.push(`status IN (${statuses.map(() => "?").join(", ")})`);
        values.push(...statuses);
      }
    }
    if (options.ready === true) { clauses.push("(not_before IS NULL OR not_before <= ?)"); values.push(now()); }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    values.push(options.limit ?? 50);
    return this.db.prepare(`SELECT * FROM control_result_deliveries ${where} ORDER BY created_at LIMIT ?`).all(...values).map(normalizeControlDelivery);
  }

  markControlDeliveryDelivered(id, deliveredTurnId = null) {
    const timestamp = now();
    const current = normalizeControlDelivery(this.db.prepare("SELECT * FROM control_result_deliveries WHERE id = ?").get(id));
    if (current && current.status !== "delivered") transitionDelivery(current.status, "delivered");
    const row = this.db.prepare(`
      UPDATE control_result_deliveries SET status = 'delivered', delivered_turn_id = ?,
        delivered_at = ?, delivery_method = 'drain_acknowledgement', acknowledged_at = ?,
        acknowledged_turn_id = ?, updated_at = ?, last_error = NULL
      WHERE id = ? AND status != 'delivered' RETURNING *
    `).get(deliveredTurnId, timestamp, timestamp, deliveredTurnId, timestamp, id);
    return normalizeControlDelivery(row) ?? normalizeControlDelivery(this.db.prepare("SELECT * FROM control_result_deliveries WHERE id = ?").get(id));
  }

  markControlDeliveryDirectDelivered(id, deliveredTurnId = null) {
    const timestamp = now();
    const current = normalizeControlDelivery(this.db.prepare("SELECT * FROM control_result_deliveries WHERE id = ?").get(id));
    if (current && current.status !== "direct_delivered") transitionDelivery(current.status, "direct_delivered");
    const row = this.db.prepare(`
      UPDATE control_result_deliveries SET status = 'direct_delivered', delivered_turn_id = ?,
        delivered_at = ?, delivery_method = 'direct_origin_append', direct_delivered_at = ?,
        updated_at = ?, last_error = NULL
      WHERE id = ? AND status NOT IN ('direct_delivered', 'delivered') RETURNING *
    `).get(deliveredTurnId, timestamp, timestamp, timestamp, id);
    return normalizeControlDelivery(row) ?? normalizeControlDelivery(this.db.prepare("SELECT * FROM control_result_deliveries WHERE id = ?").get(id));
  }

  deferControlDelivery(id, error, retryDelayMs = 30_000) {
    const current = normalizeControlDelivery(this.db.prepare("SELECT * FROM control_result_deliveries WHERE id = ?").get(id));
    if (!current || current.status === "delivered") return current;
    const attempt = current.attempt + 1;
    const exhausted = attempt >= current.maxAttempts;
    transitionDelivery(current.status, exhausted ? "pending_attention" : "retry_waiting");
    const timestamp = now();
    const row = this.db.prepare(`
      UPDATE control_result_deliveries SET status = ?, attempt = ?, not_before = ?,
        last_error = ?, updated_at = ? WHERE id = ? RETURNING *
    `).get(
      exhausted ? "pending_attention" : "retry_waiting",
      attempt,
      exhausted ? null : new Date(Date.now() + retryDelayMs).toISOString(),
      String(error?.message ?? error), timestamp, id,
    );
    const delivery = normalizeControlDelivery(row);
    if (exhausted) {
      const run = this.getRun(delivery.runId);
      this.createNotification({
        projectKey: run?.cwd ?? "workspace", runId: delivery.runId,
        kind: NOTIFICATION_KINDS.ATTENTION_REQUIRED,
        title: "이전 결과 기록 확인 필요",
        body: "이전 버전에서 남은 결과 전달 기록입니다. 작업 탐색기의 해당 Run과 담당 스레드에서 결과를 확인하세요.",
        dedupeKey: `${delivery.deliveryKey}:attention`,
      });
    }
    return delivery;
  }

  recoverControlDeliveries() {
    const timestamp = now();
    transitionDelivery("delivering", "retry_waiting");
    const result = this.db.prepare(`
      UPDATE control_result_deliveries SET status = 'retry_waiting', not_before = ?, updated_at = ?
      WHERE status = 'delivering'
    `).run(timestamp, timestamp);
    return Number(result.changes);
  }

  getDashboardSummary(options = {}) {
    const runs = this.listRuns({ cwd: options.cwd, limit: 10000 });
    const notifications = this.listNotifications({ cwd: options.cwd, unread: true, limit: 10000 });
    const queue = this.listProjectQueue({ limit: 10000 }).filter((item) => !options.cwd || item.projectKey === options.cwd || item.projectKey.startsWith(`${options.cwd}/`) || options.cwd.startsWith(`${item.projectKey}/`));
    const count = (statuses) => runs.filter((run) => statuses.includes(run.status)).length;
    return {
      scope: options.cwd ? "project" : "global", cwd: options.cwd ?? null,
      preparationQueued: queue.filter((item) => ["queued", "leased", "retry_waiting"].includes(item.status)).length,
      awaitingStart: count(["awaiting_user_start"]), running: count(["running"]),
      attention: notifications.filter((item) => [NOTIFICATION_KINDS.FAILED, NOTIFICATION_KINDS.ATTENTION_REQUIRED, NOTIFICATION_KINDS.POLICY_BLOCKED].includes(item.kind)).length,
      unread: notifications.length, recentCompleted: count(["completed"]),
    };
  }

  expirePendingApprovals(reason = "control-plane restarted") {
    const rows = this.db.prepare("SELECT id, task_id FROM approvals WHERE status = 'pending'").all();
    const timestamp = now();
    this.db.prepare(`UPDATE approvals SET status = 'expired', decision = 'decline', resolved_at = ?, metadata_json = json_set(metadata_json, '$.expireReason', ?) WHERE status = 'pending'`).run(timestamp, reason);
    for (const row of rows) this.recordEvent("approval", row.id, "approval.expired", { taskId: row.task_id, reason });
    return rows.length;
  }

  upsertManagedWorktree(worktree) {
    if (!worktree?.id || !worktree?.repoRoot || !worktree?.path) throw new TypeError("Worktree id, repoRoot, and path are required");
    const timestamp = now();
    this.db.prepare(`
      INSERT INTO managed_worktrees (
        id, repo_root, path, branch, base_ref, status, owner_task_id,
        created_at, updated_at, removed_at, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET status = excluded.status, owner_task_id = excluded.owner_task_id,
        updated_at = excluded.updated_at, removed_at = excluded.removed_at, metadata_json = excluded.metadata_json
    `).run(
      worktree.id, worktree.repoRoot, worktree.path, worktree.branch ?? null,
      worktree.baseRef ?? null, worktree.status ?? "creating", worktree.ownerTaskId ?? null,
      worktree.createdAt ?? timestamp, timestamp, worktree.removedAt ?? null,
      json(worktree.metadata ?? {}, {}),
    );
    return this.getManagedWorktree(worktree.id);
  }

  getManagedWorktree(worktreeId) {
    return normalizeManagedWorktree(this.db.prepare("SELECT * FROM managed_worktrees WHERE id = ?").get(worktreeId));
  }

  listManagedWorktrees(options = {}) {
    const clauses = [];
    const values = [];
    if (options.status) { clauses.push("status = ?"); values.push(options.status); }
    if (options.ownerTaskId) { clauses.push("owner_task_id = ?"); values.push(options.ownerTaskId); }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    values.push(options.limit ?? 100);
    return this.db.prepare(`SELECT * FROM managed_worktrees ${where} ORDER BY updated_at DESC LIMIT ?`).all(...values).map(normalizeManagedWorktree);
  }

  prepareIntegrationJournal(entry) {
    if (!entry?.worktreeId || !entry?.repoRoot || !entry?.strategy || !entry?.artifact) throw new TypeError("Integration journal requires worktreeId, repoRoot, strategy, and artifact");
    const timestamp = now();
    const identity = JSON.stringify({ worktreeId: entry.worktreeId, strategy: entry.strategy, commit: entry.artifact.commit ?? null, patchPath: entry.artifact.patchPath ?? null });
    const journalKey = entry.journalKey ?? createHash("sha256").update(identity).digest("hex");
    const id = entry.id ?? `integration_${journalKey.slice(0, 24)}`;
    this.db.prepare(`
      INSERT INTO integration_journal (
        id, journal_key, worktree_id, task_id, repo_root, strategy, status,
        artifact_json, evidence_json, last_error, created_at, updated_at, applied_at, recorded_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'prepared', ?, NULL, NULL, ?, ?, NULL, NULL)
      ON CONFLICT(journal_key) DO UPDATE SET artifact_json = excluded.artifact_json, updated_at = excluded.updated_at
    `).run(id, journalKey, entry.worktreeId, entry.taskId ?? null, entry.repoRoot, entry.strategy, json(entry.artifact, {}), timestamp, timestamp);
    return this.getIntegrationJournalByKey(journalKey);
  }

  getIntegrationJournal(id) {
    return normalizeIntegrationJournal(this.db.prepare("SELECT * FROM integration_journal WHERE id = ?").get(id));
  }

  getIntegrationJournalByKey(journalKey) {
    return normalizeIntegrationJournal(this.db.prepare("SELECT * FROM integration_journal WHERE journal_key = ?").get(journalKey));
  }

  listIntegrationJournals(options = {}) {
    const clauses = [];
    const values = [];
    if (options.worktreeId) { clauses.push("worktree_id = ?"); values.push(options.worktreeId); }
    if (options.taskId) { clauses.push("task_id = ?"); values.push(options.taskId); }
    if (options.repoRoot) { clauses.push("repo_root = ?"); values.push(options.repoRoot); }
    if (options.pending) clauses.push("status != 'recorded'");
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    values.push(options.limit ?? 100);
    return this.db.prepare(`SELECT * FROM integration_journal ${where} ORDER BY created_at LIMIT ?`).all(...values).map(normalizeIntegrationJournal);
  }

  transitionIntegrationJournal(id, status, changes = {}) {
    const current = this.getIntegrationJournal(id);
    if (!current) throw new Error(`Integration journal not found: ${id}`);
    const allowed = {
      prepared: new Set(["applying"]),
      applying: new Set(["prepared", "applied"]),
      applied: new Set(["recorded"]),
      recorded: new Set(),
    };
    if (status !== current.status && !allowed[current.status]?.has(status)) throw Object.assign(new Error(`Illegal Integration transition: ${current.status} -> ${status}`), { code: "INTEGRATION_STATE_TRANSITION_INVALID" });
    const timestamp = now();
    this.db.prepare(`
      UPDATE integration_journal SET status = ?, evidence_json = ?, last_error = ?, updated_at = ?,
        applied_at = CASE WHEN ? = 'applied' THEN COALESCE(applied_at, ?) ELSE applied_at END,
        recorded_at = CASE WHEN ? = 'recorded' THEN COALESCE(recorded_at, ?) ELSE recorded_at END
      WHERE id = ?
    `).run(status, json(changes.evidence === undefined ? current.evidence : changes.evidence), changes.lastError ?? null, timestamp, status, timestamp, status, timestamp, id);
    this.recordEvent("integration", id, `integration.${status}`, { worktreeId: current.worktreeId, strategy: current.strategy, ...(changes.evidence ? { evidence: changes.evidence } : {}) });
    return this.getIntegrationJournal(id);
  }

  finishRecoveredIntegration(taskId, journal, options = {}) {
    const task = this.getTask(taskId);
    if (!task || task.status !== "integration_pending") return task;
    const status = options.status ?? (journal.status === "recorded" ? "completed" : "integration_blocked");
    transitionTask(task.status, status);
    const timestamp = now();
    const failure = status === "integration_blocked" ? {
      type: "integration",
      category: "coordination",
      stage: "integration_recovery",
      cause: options.error ?? journal.lastError ?? "Integration recovery could not determine a safe result",
      retryable: false,
      nextAction: "recover_integration",
      executionFingerprint: task.metadata?.contractFingerprint ?? null,
      at: timestamp,
    } : null;
    const metadata = {
      ...task.metadata,
      integration: { ...(task.metadata?.integration ?? {}), recovered: true, journalId: journal.id, status: journal.status },
      ...(failure ? { failure, failureHistory: [...(task.metadata?.failureHistory ?? []), failure] } : {}),
    };
    this.db.prepare(`
      UPDATE tasks SET status = ?, error = ?, completed_at = ?, worker_id = NULL,
        claim_token = NULL, heartbeat_at = NULL, next_retry_at = NULL, updated_at = ?,
        version = version + 1, metadata_json = ? WHERE id = ? AND status = 'integration_pending'
    `).run(status, failure?.cause ?? null, timestamp, timestamp, json(metadata, {}), taskId);
    this.recordEvent("task", taskId, `task.${status}`, { restartRecovery: true, journalId: journal.id });
    return this.getTask(taskId);
  }

  upsertRoleTemplate(template) {
    if (!template?.name || !template?.developerInstructions) throw new TypeError("Role template name and developerInstructions are required");
    const timestamp = now();
    const existing = this.getRoleTemplate(template.name);
    this.db.prepare(`
      INSERT INTO role_templates (
        name, description, developer_instructions, capabilities_json, tools_json, skills_json,
        model, effort, sandbox, approval_policy, created_at, updated_at, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET description = excluded.description,
        developer_instructions = excluded.developer_instructions,
        capabilities_json = excluded.capabilities_json, tools_json = excluded.tools_json,
        skills_json = excluded.skills_json, model = excluded.model, effort = excluded.effort, sandbox = excluded.sandbox,
        approval_policy = excluded.approval_policy, updated_at = excluded.updated_at,
        metadata_json = excluded.metadata_json
    `).run(
      template.name, template.description ?? null, template.developerInstructions,
      json(template.capabilities ?? [], []), json(template.tools ?? [], []),
      json(template.skills ?? [], []), template.model ?? null, template.effort ?? null,
      template.sandbox ?? "read-only", template.approvalPolicy ?? "never",
      existing?.createdAt ?? timestamp, timestamp, json(template.metadata ?? {}, {}),
    );
    this.recordEvent("role", template.name, existing ? "role.updated" : "role.created", {});
    return this.getRoleTemplate(template.name);
  }

  getRoleTemplate(name) {
    return normalizeRoleTemplate(this.db.prepare("SELECT * FROM role_templates WHERE name = ?").get(name));
  }

  listRoleTemplates(options = {}) {
    return this.db.prepare("SELECT * FROM role_templates ORDER BY name LIMIT ?").all(options.limit ?? 100).map(normalizeRoleTemplate);
  }

  setSetting(key, value) {
    this.db.prepare(`INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`).run(key, json(value), now());
    return value;
  }

  getSetting(key, fallback = null) {
    const row = this.db.prepare("SELECT value_json FROM settings WHERE key = ?").get(key);
    return row ? parse(row.value_json, fallback) : fallback;
  }

  acquireDashboardLease(projectKey, ownerId, options = {}) {
    if (!projectKey || !ownerId) throw new TypeError("Dashboard projectKey and ownerId are required");
    const timestamp = now();
    const expiresAt = new Date(Date.now() + (options.ttlMs ?? 30_000)).toISOString();
    const token = options.token ?? randomUUID();
    const row = this.db.prepare(`
      INSERT INTO dashboard_leases (project_key, owner_id, lease_token, acquired_at, heartbeat_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_key) DO UPDATE SET
        owner_id = excluded.owner_id, lease_token = excluded.lease_token,
        acquired_at = CASE WHEN dashboard_leases.owner_id = excluded.owner_id THEN dashboard_leases.acquired_at ELSE excluded.acquired_at END,
        heartbeat_at = excluded.heartbeat_at, expires_at = excluded.expires_at
      WHERE dashboard_leases.owner_id = excluded.owner_id OR dashboard_leases.expires_at <= excluded.heartbeat_at
      RETURNING *
    `).get(projectKey, ownerId, token, timestamp, timestamp, expiresAt);
    return normalizeDashboardLease(row);
  }

  renewDashboardLease(projectKey, ownerId, token, ttlMs = 30_000) {
    const timestamp = now();
    const row = this.db.prepare(`
      UPDATE dashboard_leases SET heartbeat_at = ?, expires_at = ?
      WHERE project_key = ? AND owner_id = ? AND lease_token = ? AND expires_at > ?
      RETURNING *
    `).get(timestamp, new Date(Date.now() + ttlMs).toISOString(), projectKey, ownerId, token, timestamp);
    return normalizeDashboardLease(row);
  }

  releaseDashboardLease(projectKey, ownerId, token) {
    const result = this.db.prepare("DELETE FROM dashboard_leases WHERE project_key = ? AND owner_id = ? AND lease_token = ?").run(projectKey, ownerId, token);
    return Number(result.changes) === 1;
  }

  getDashboardLease(projectKey) {
    return normalizeDashboardLease(this.db.prepare("SELECT * FROM dashboard_leases WHERE project_key = ?").get(projectKey));
  }

  listTaskDependencies(taskId) {
    return this.db.prepare(`
      SELECT d.depends_on_task_id AS task_id, t.status
      FROM task_dependencies d
      JOIN tasks t ON t.id = d.depends_on_task_id
      WHERE d.task_id = ?
      ORDER BY d.created_at, d.depends_on_task_id
    `).all(taskId).map((row) => ({ taskId: row.task_id, status: row.status }));
  }

  refreshBlockedTasks() {
    let queued = 0;
    let failed = 0;
    const affectedRunIds = new Set();
    const failedDependencyStatuses = new Set([...FAILED_TASK_STATUSES, "canceled"]);
    const terminalDependencyStatuses = TERMINAL_TASK_STATUSES;
    let propagatedFailure;
    do {
      propagatedFailure = false;
      const blocked = this.db.prepare("SELECT id FROM tasks WHERE status = 'blocked'").all();
      for (const row of blocked) {
        const blockedTask = this.getTask(row.id);
        const dependencies = this.listTaskDependencies(row.id);
        const failedDependency = dependencies.find((entry) => failedDependencyStatuses.has(entry.status));
        const dependencyPolicy = blockedTask?.metadata?.dependencyPolicy ?? "all_success";
        const allTerminal = dependencies.every((entry) => terminalDependencyStatuses.has(entry.status));
        if (dependencyPolicy === "on_failure" && allTerminal && !failedDependency) {
          this.updateTask(row.id, { status: "skipped", output: "Fallback was not required", completedAt: now() });
          if (blockedTask?.metadata?.runId) affectedRunIds.add(blockedTask.metadata.runId);
        } else if (dependencyPolicy === "on_failure" && allTerminal && failedDependency) {
          this.updateTask(row.id, { status: "queued", error: null });
          queued += 1;
        } else if (dependencyPolicy === "all_terminal" && allTerminal) {
          this.updateTask(row.id, { status: "queued", error: null });
          queued += 1;
        } else if (dependencyPolicy === "all_success" && failedDependency) {
          this.updateTask(row.id, {
            status: "failed",
            error: `Dependency ${failedDependency.taskId} ended with ${failedDependency.status}`,
            completedAt: now(),
          });
          failed += 1;
          propagatedFailure = true;
          if (blockedTask?.metadata?.runId) affectedRunIds.add(blockedTask.metadata.runId);
        } else if (dependencyPolicy === "all_success" && dependencies.every((entry) => ["completed", "completed_with_warnings"].includes(entry.status))) {
          this.updateTask(row.id, { status: "queued", error: null });
          queued += 1;
        }
      }
    } while (propagatedFailure);
    for (const runId of affectedRunIds) this.refreshRun(runId);
    return { queued, failed };
  }

  listRunnableTasks(options = {}) {
    this.refreshBlockedTasks();
    const timestamp = now();
    return this.db.prepare(`
      SELECT * FROM tasks t
      WHERE t.status IN ('queued', 'retry_waiting', 'waiting_for_lease')
        AND (t.next_retry_at IS NULL OR t.next_retry_at <= ?)
        AND NOT EXISTS (
          SELECT 1 FROM task_dependencies d
          JOIN tasks dependency ON dependency.id = d.depends_on_task_id
          WHERE d.task_id = t.id AND (
            (COALESCE(json_extract(t.metadata_json, '$.dependencyPolicy'), 'all_success') = 'all_success' AND dependency.status NOT IN ('completed', 'completed_with_warnings'))
            OR (COALESCE(json_extract(t.metadata_json, '$.dependencyPolicy'), 'all_success') IN ('all_terminal', 'on_failure') AND dependency.status NOT IN ('completed', 'completed_with_warnings', 'rejected', 'validation_failed', 'failed', 'canceled', 'interrupted', 'skipped'))
          )
        )
      ORDER BY t.created_at
      LIMIT ?
    `).all(timestamp, options.limit ?? 20).map(normalizeTask);
  }

  rejectTaskBeforeClaim(taskId, failure = {}, options = {}) {
    const task = this.getTask(taskId);
    if (!task) return null;
    const status = options.terminalStatus ?? "failed";
    if (!["failed", "blocked_by_policy"].includes(status)) throw new TypeError(`Unsupported pre-claim terminal status: ${status}`);
    const timestamp = now();
    const record = {
      ...failure,
      type: failure.type ?? "configuration",
      category: failure.category ?? "configuration",
      stage: failure.stage ?? "contract_preflight",
      cause: failure.cause ?? failure.message ?? "Invalid execution contract",
      message: failure.message ?? failure.cause ?? "Invalid execution contract",
      retryable: false,
      nextAction: failure.nextAction ?? "repair_contract",
      attemptBudget: { used: task.attempt, max: task.maxAttempts, remaining: Math.max(task.maxAttempts - task.attempt, 0) },
      executionFingerprint: task.metadata?.executionContract?.fingerprint ?? task.metadata?.execution?.executionContract?.fingerprint ?? null,
      at: failure.at ?? timestamp,
    };
    const metadata = {
      ...task.metadata,
      failure: record,
      failureHistory: [...(task.metadata?.failureHistory ?? []), record],
    };
    const row = this.db.prepare(`
      UPDATE tasks
      SET status = ?, error = ?, completed_at = ?, agent_id = NULL, source_thread_id = NULL,
          turn_id = NULL, worker_id = NULL, claim_token = NULL, heartbeat_at = NULL,
          next_retry_at = NULL, updated_at = ?, version = version + 1, metadata_json = ?
      WHERE id = ? AND status IN ('queued', 'retry_waiting', 'waiting_for_lease') AND version = ?
      RETURNING *
    `).get(status, record.cause, timestamp, timestamp, json(metadata, {}), taskId, task.version);
    if (!row) return null;
    this.recordEvent("task", taskId, `task.${status}`, { previousStatus: task.status, preClaim: true, failure: record });
    return this.getTask(taskId);
  }

  claimTask(taskId, workerId) {
    const candidate = this.getTask(taskId);
    if (candidate?.metadata?.globalRunRevisionId) {
      try { this.assertGlobalTaskGate(taskId); }
      catch (error) {
        this.recordEvent("task", taskId, "task.global_claim_fenced", { code: error.code ?? "GLOBAL_TASK_GATE_FAILED", cause: error.message });
        return null;
      }
    }
    const timestamp = now();
    const claimToken = randomUUID();
    const row = this.db.prepare(`
      UPDATE tasks
      SET status = 'running', worker_id = ?, heartbeat_at = ?, updated_at = ?,
          started_at = COALESCE(started_at, ?), attempt = attempt + 1,
          next_retry_at = NULL, error = NULL, claim_token = ?, version = version + 1
      WHERE id = ?
        AND status IN ('queued', 'retry_waiting', 'waiting_for_lease')
        AND json_extract(metadata_json, '$.contractStatus') = 'validated'
        AND json_extract(metadata_json, '$.contractFingerprint') = json_extract(metadata_json, '$.executionContract.fingerprint')
        AND (
          json_extract(metadata_json, '$.contextSnapshotId') IS NULL
          OR EXISTS (
            SELECT 1 FROM context_snapshots snapshot
            WHERE snapshot.id = json_extract(tasks.metadata_json, '$.contextSnapshotId')
              AND snapshot.status = 'validated'
              AND snapshot.fingerprint = json_extract(tasks.metadata_json, '$.contextSnapshotFingerprint')
          )
        )
        AND (
          json_extract(metadata_json, '$.globalRunRevisionId') IS NULL
          OR EXISTS (
            SELECT 1 FROM global_run_revisions revision
            JOIN global_runs parent ON parent.id = revision.global_run_id
            WHERE revision.id = json_extract(tasks.metadata_json, '$.globalRunRevisionId')
              AND revision.status = 'validated'
              AND parent.current_revision = revision.revision
              AND parent.status IN ('running', 'waiting')
              AND parent.cancellation_requested_at IS NULL
              AND revision.graph_fingerprint = json_extract(tasks.metadata_json, '$.globalGraphFingerprint')
              AND revision.authorization_fingerprint = json_extract(tasks.metadata_json, '$.globalAuthorizationFingerprint')
              AND EXISTS (
                SELECT 1 FROM authorization_manifests manifest
                WHERE manifest.revision_id = revision.id AND manifest.run_id = tasks.run_id
                  AND manifest.fingerprint = json_extract(tasks.metadata_json, '$.globalAuthorizationManifestFingerprint')
              )
              AND NOT EXISTS (
                SELECT 1 FROM cross_project_dependencies dependency
                LEFT JOIN cross_project_handoffs handoff ON handoff.dependency_id = dependency.id
                WHERE dependency.revision_id = revision.id AND dependency.consumer_run_id = tasks.run_id
                  AND (dependency.status != 'satisfied' OR handoff.status != 'received'
                    OR handoff.dependency_fingerprint != dependency.fingerprint
                    OR handoff.fingerprint != json_extract(handoff.metadata_json, '$.validatedFingerprint')
                    OR handoff.content_hash != json_extract(handoff.metadata_json, '$.validatedContentHash')
                    OR handoff.receipt_hash != json_extract(handoff.metadata_json, '$.validatedReceiptHash')
                    OR handoff.receipt_hash IS NULL)
              )
          )
        )
        AND (next_retry_at IS NULL OR next_retry_at <= ?)
        AND NOT EXISTS (
          SELECT 1 FROM task_dependencies d
          JOIN tasks dependency ON dependency.id = d.depends_on_task_id
          WHERE d.task_id = tasks.id AND (
            (COALESCE(json_extract(tasks.metadata_json, '$.dependencyPolicy'), 'all_success') = 'all_success' AND dependency.status NOT IN ('completed', 'completed_with_warnings'))
            OR (COALESCE(json_extract(tasks.metadata_json, '$.dependencyPolicy'), 'all_success') IN ('all_terminal', 'on_failure') AND dependency.status NOT IN ('completed', 'completed_with_warnings', 'rejected', 'validation_failed', 'failed', 'canceled', 'interrupted', 'skipped', 'blocked_by_policy', 'integration_blocked'))
          )
        )
      RETURNING *
    `).get(workerId, timestamp, timestamp, timestamp, claimToken, taskId, timestamp);
    if (!row) return null;
    this.recordEvent("task", taskId, "task.claimed", { workerId, attempt: row.attempt });
    const task = normalizeTask(row);
    task.dependencies = this.listTaskDependencies(taskId);
    return task;
  }

  bindClaim(taskId, workerId, claimToken, changes = {}) {
    const timestamp = now();
    const row = this.db.prepare(`
      UPDATE tasks
      SET source_thread_id = ?, agent_id = ?, mode = ?, routing_json = ?,
          started_at = COALESCE(started_at, ?), heartbeat_at = ?, updated_at = ?, version = version + 1
      WHERE id = ? AND worker_id = ? AND claim_token = ?
        AND status IN ('running', 'approval_waiting', 'integration_pending')
      RETURNING *
    `).get(
      changes.sourceThreadId ?? null,
      changes.agentId ?? null,
      changes.mode ?? null,
      json(changes.routing ?? null),
      timestamp,
      timestamp,
      timestamp,
      taskId,
      workerId,
      claimToken,
    );
    return normalizeTask(row);
  }

  setClaimTurn(taskId, workerId, claimToken, turnId) {
    const result = this.db.prepare(`
      UPDATE tasks SET turn_id = ?, heartbeat_at = ?, updated_at = ?, version = version + 1
      WHERE id = ? AND worker_id = ? AND claim_token = ?
        AND status IN ('running', 'approval_waiting')
    `).run(turnId, now(), now(), taskId, workerId, claimToken);
    return Number(result.changes) === 1;
  }

  heartbeatClaim(taskId, workerId, claimToken) {
    const timestamp = now();
    const result = this.db.prepare(`
      UPDATE tasks SET heartbeat_at = ?, updated_at = ?, version = version + 1
      WHERE id = ? AND worker_id = ? AND claim_token = ?
        AND status IN ('running', 'approval_waiting', 'agent_done', 'validating', 'integration_pending')
    `).run(timestamp, timestamp, taskId, workerId, claimToken);
    return Number(result.changes) === 1;
  }

  isClaimOwner(taskId, workerId, claimToken) {
    return Boolean(this.db.prepare(`
      SELECT 1 FROM tasks
      WHERE id = ? AND worker_id = ? AND claim_token = ?
        AND status IN ('running', 'approval_waiting', 'agent_done', 'validating', 'integration_pending')
    `).get(taskId, workerId, claimToken));
  }

  completeClaim(taskId, workerId, claimToken, changes = {}) {
    const timestamp = now();
    const row = this.db.prepare(`
      UPDATE tasks
      SET status = 'completed', output = ?, turn_id = COALESCE(?, turn_id),
          completed_at = ?, updated_at = ?, worker_id = NULL,
          claim_token = NULL, heartbeat_at = NULL, version = version + 1
      WHERE id = ? AND worker_id = ? AND claim_token = ?
        AND status IN ('running', 'approval_waiting', 'integration_pending')
      RETURNING *
    `).get(changes.output ?? null, changes.turnId ?? null, timestamp, timestamp, taskId, workerId, claimToken);
    if (!row) return null;
    this.recordEvent("task", taskId, "task.completed", { workerId, attempt: row.attempt });
    return this.getTask(taskId);
  }

  markClaimAgentDone(taskId, workerId, claimToken, changes = {}) {
    const timestamp = now();
    const row = this.db.prepare(`
      UPDATE tasks SET status = 'agent_done', output = ?, turn_id = COALESCE(?, turn_id),
        heartbeat_at = ?, updated_at = ?, version = version + 1
      WHERE id = ? AND worker_id = ? AND claim_token = ?
        AND status IN ('running', 'approval_waiting')
      RETURNING *
    `).get(changes.output ?? null, changes.turnId ?? null, timestamp, timestamp, taskId, workerId, claimToken);
    if (!row) return null;
    this.recordEvent("task", taskId, "task.agent_done", { workerId, attempt: row.attempt });
    return this.getTask(taskId);
  }

  markClaimValidating(taskId, workerId, claimToken) {
    const timestamp = now();
    const row = this.db.prepare(`
      UPDATE tasks SET status = 'validating', heartbeat_at = ?, updated_at = ?, version = version + 1
      WHERE id = ? AND worker_id = ? AND claim_token = ? AND status = 'agent_done'
      RETURNING *
    `).get(timestamp, timestamp, taskId, workerId, claimToken);
    if (!row) return null;
    this.recordEvent("task", taskId, "task.validating", { workerId, attempt: row.attempt });
    return this.getTask(taskId);
  }

  markClaimIntegrationPending(taskId, workerId, claimToken, details = {}) {
    const timestamp = now();
    const task = this.getTask(taskId);
    if (!task) return null;
    const metadata = { ...task.metadata, integration: { status: "integration_pending", strategy: details.strategy ?? null, startedAt: timestamp } };
    const row = this.db.prepare(`
      UPDATE tasks SET status = 'integration_pending', heartbeat_at = ?, updated_at = ?, metadata_json = ?, version = version + 1
      WHERE id = ? AND worker_id = ? AND claim_token = ? AND status IN ('running', 'validating')
      RETURNING *
    `).get(timestamp, timestamp, json(metadata, {}), taskId, workerId, claimToken);
    if (!row) return null;
    this.recordEvent("task", taskId, "task.integration_pending", { workerId, strategy: details.strategy ?? null });
    return this.getTask(taskId);
  }

  finishValidationClaim(taskId, workerId, claimToken, validation) {
    const accepted = validation?.decision === "accept";
    const warned = validation?.decision === "accept_with_warnings";
    if (!accepted && !warned) {
      const summary = validation?.summary ?? "Acceptance criteria were not satisfied";
      const failureKind = validation?.failureKind ?? (/execution contract|read[ -]?only|sandbox|permission|cannot (?:write|modify|edit)/i.test(summary) ? "configuration" : "validation");
      const configurationBlocked = ["configuration", "policy"].includes(failureKind);
      const infrastructureFailure = configurationBlocked
        ? { type: failureKind, category: failureKind, stage: "validation", cause: summary, message: summary, retryable: false, nextAction: "repair_contract", at: now() }
        : validation?.decision === "error"
        ? { type: "infrastructure", category: "environment", stage: "validation", cause: summary, message: summary, retryable: true, nextAction: "retry", at: now() }
        : { type: "validation", category: failureKind === "product" ? "product" : "validation", stage: "validation", cause: summary, message: summary, retryable: true, nextAction: "rework", at: now() };
      return this.finishFailureClaim(taskId, workerId, claimToken, infrastructureFailure, {
        terminalStatus: infrastructureFailure.type === "policy" ? "blocked_by_policy" : infrastructureFailure.type === "validation" ? "rejected" : "validation_failed",
        feedback: infrastructureFailure.type === "validation" ? validation : null,
      });
    }
    const status = accepted ? "completed" : "completed_with_warnings";
    const timestamp = now();
    const task = this.getTask(taskId);
    if (!task) return null;
    const metadata = { ...task.metadata, validation };
    delete metadata.validationInProgress;
    delete metadata.failure;
    if (metadata.rework?.current) metadata.rework = { ...metadata.rework, current: null };
    const row = this.db.prepare(`
      UPDATE tasks SET status = ?, error = ?, completed_at = ?,
        worker_id = NULL, claim_token = NULL, heartbeat_at = NULL,
        updated_at = ?, version = version + 1,
        metadata_json = ?
      WHERE id = ? AND worker_id = ? AND claim_token = ? AND status IN ('validating', 'integration_pending')
      RETURNING *
    `).get(
      status,
      accepted ? null : (validation?.summary ?? "Acceptance criteria were not satisfied"),
      timestamp,
      timestamp,
      json(metadata, {}),
      taskId,
      workerId,
      claimToken,
    );
    if (!row) return null;
    this.recordEvent("task", taskId, `task.${status}`, { workerId, attempt: row.attempt, validation: validation?.summary ?? null });
    return this.getTask(taskId);
  }

  finishTurnClaim(taskId, workerId, claimToken, changes = {}) {
    if (!["failed", "interrupted"].includes(changes.status)) throw new TypeError(`Unsupported terminal turn status: ${changes.status}`);
    const timestamp = now();
    const row = this.db.prepare(`
      UPDATE tasks
      SET status = ?, output = ?, error = ?, turn_id = COALESCE(?, turn_id),
          completed_at = ?, updated_at = ?, worker_id = NULL,
          claim_token = NULL, heartbeat_at = NULL, version = version + 1
      WHERE id = ? AND worker_id = ? AND claim_token = ?
        AND status IN ('running', 'approval_waiting')
      RETURNING *
    `).get(
      changes.status,
      changes.output ?? null,
      changes.error ?? `Agent turn ended with status: ${changes.status}`,
      changes.turnId ?? null,
      timestamp,
      timestamp,
      taskId,
      workerId,
      claimToken,
    );
    if (!row) return null;
    this.recordEvent("task", taskId, `task.${changes.status}`, { workerId, attempt: row.attempt, turnId: changes.turnId ?? null });
    return this.getTask(taskId);
  }

  failClaim(taskId, workerId, claimToken, error, details = {}) {
    return this.finishFailureClaim(taskId, workerId, claimToken, details.failure ?? {
      type: "worker", stage: "execution", cause: String(error), message: String(error), retryable: false, nextAction: "manual_intervention", at: now(),
    }, { terminalStatus: details.terminalStatus ?? "failed" });
  }

  finishFailureClaim(taskId, workerId, claimToken, failure = {}, options = {}) {
    const task = normalizeTask(this.db.prepare(`
      SELECT * FROM tasks WHERE id = ? AND worker_id = ? AND claim_token = ?
        AND status IN ('running', 'approval_waiting', 'agent_done', 'validating', 'integration_pending')
    `).get(taskId, workerId, claimToken));
    if (!task) return null;
    const metadata = parse(this.db.prepare("SELECT metadata_json FROM tasks WHERE id = ?").get(taskId).metadata_json, {});
    const feedback = options.feedback ?? null;
    const feedbackHash = feedback
      ? createHash("sha256").update(JSON.stringify({ summary: feedback.summary ?? "", unmetCriteria: feedback.unmetCriteria ?? [] })).digest("hex")
      : null;
    const feedbackHashes = [...new Set(metadata.rework?.feedbackHashes ?? [])];
    const duplicateFeedback = Boolean(feedbackHash && feedbackHashes.includes(feedbackHash));
    if (feedbackHash && !duplicateFeedback) feedbackHashes.push(feedbackHash);
    const remaining = Math.max(task.maxAttempts - task.attempt, 0);
    const executionFingerprint = metadata.executionContract?.fingerprint ?? metadata.execution?.executionContract?.fingerprint ?? null;
    const previousFailure = metadata.failureHistory?.at(-1) ?? null;
    const sameConfiguration = Boolean(executionFingerprint && previousFailure?.executionFingerprint === executionFingerprint);
    const retryDecision = decideTaskRetry({ failure, remaining, feedback, duplicateFeedback });
    const retry = retryDecision.retry;
    const delay = task.retryDelayMs * (2 ** Math.max(task.attempt - 1, 0));
    const timestamp = now();
    const nextRetryAt = retry ? new Date(Date.now() + delay).toISOString() : null;
    const requestedAction = retryDecision.requestedAction;
    const status = retry ? "retry_waiting" : (options.terminalStatus ?? "failed");
    const completedAt = retry ? null : timestamp;
    const record = {
      ...failure,
      cause: failure.cause ?? failure.message ?? "Unknown failure",
      message: failure.message ?? failure.cause ?? "Unknown failure",
      retryable: Boolean(failure.retryable),
      nextAction: retry ? requestedAction : (failure.retryable ? "manual_intervention" : requestedAction),
      requestedAction,
      attemptBudget: { used: task.attempt, max: task.maxAttempts, remaining },
      exhausted: remaining === 0 || duplicateFeedback,
      duplicateFeedback,
      feedbackHash,
      executionFingerprint,
      sameConfiguration,
      retrySafety: { allowed: retry, reason: retryDecision.safeReason, mode: retryDecision.mode },
      retryMutation: {
        sandboxChanged: false,
        sessionChanged: false,
        workspaceChanged: false,
        promptChanged: Boolean(feedback && !duplicateFeedback),
        reason: retry ? retryDecision.safeReason : "no_automatic_retry",
      },
      at: failure.at ?? timestamp,
    };
    const history = [...(metadata.failureHistory ?? []), record];
    const nextMetadata = { ...metadata, failure: record, failureHistory: history };
    delete nextMetadata.validationInProgress;
    if (feedback) {
      const feedbackRevision = Number(metadata.rework?.feedbackRevision ?? 0) + (duplicateFeedback ? 0 : 1);
      nextMetadata.rework = {
        ...(metadata.rework ?? {}),
        feedbackHashes,
        feedbackRevision,
        current: retry && requestedAction === "rework" ? { feedback, feedbackHash, fromAttempt: task.attempt, scheduledAt: timestamp } : null,
      };
    } else if (!retry && nextMetadata.rework?.current) {
      nextMetadata.rework = { ...nextMetadata.rework, current: null };
    }
    const row = this.db.prepare(`
      UPDATE tasks
      SET status = ?, output = COALESCE(?, output), turn_id = COALESCE(?, turn_id), error = ?, next_retry_at = ?, completed_at = ?,
          worker_id = NULL, claim_token = NULL, heartbeat_at = NULL, updated_at = ?, version = version + 1,
          metadata_json = ?
      WHERE id = ? AND worker_id = ? AND claim_token = ?
      RETURNING *
    `).get(status, options.output ?? null, options.turnId ?? null, record.cause, nextRetryAt, completedAt, timestamp, json(nextMetadata, {}), taskId, workerId, claimToken);
    if (!row) return null;
    this.recordEvent("task", taskId, `task.${status}`, { workerId, attempt: task.attempt, nextRetryAt, failure: record });
    return this.getTask(taskId);
  }

  waitClaimForLease(taskId, workerId, claimToken, delayMs = 2_000) {
    const timestamp = now();
    const row = this.db.prepare(`
      UPDATE tasks
      SET status = 'waiting_for_lease', worker_id = NULL, heartbeat_at = NULL,
          attempt = MAX(attempt - 1, 0), next_retry_at = ?, updated_at = ?, version = version + 1
      WHERE id = ? AND worker_id = ? AND claim_token = ? AND status = 'running'
      RETURNING *
    `).get(new Date(Date.now() + delayMs).toISOString(), timestamp, taskId, workerId, claimToken);
    return row ? this.getTask(taskId) : null;
  }

  scheduleRetry(taskId, error) {
    const task = this.getTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    const failure = typeof error === "object" && error !== null
      ? error
      : { type: "infrastructure", category: "infrastructure", retryable: true, nextAction: "retry", cause: String(error) };
    const decision = decideTaskRetry({ failure, remaining: Math.max(task.maxAttempts - task.attempt, 0) });
    if (!decision.retry) {
      return this.updateTask(taskId, {
        status: "failed",
        error: String(failure.cause ?? failure.message ?? error),
        completedAt: now(),
        workerId: null,
        heartbeatAt: null,
        metadata: { failure: { ...failure, retryable: false, retrySafety: { allowed: false, reason: decision.safeReason, mode: decision.mode } } },
      });
    }
    const delay = task.retryDelayMs * (2 ** Math.max(task.attempt - 1, 0));
    return this.updateTask(taskId, {
      status: "retry_waiting",
      error: String(failure.cause ?? failure.message ?? error),
      nextRetryAt: new Date(Date.now() + delay).toISOString(),
      workerId: null,
      heartbeatAt: null,
      metadata: { failure: { ...failure, retrySafety: { allowed: true, reason: decision.safeReason, mode: decision.mode } } },
    });
  }

  cancelTask(taskId, options = {}) {
    const task = this.getTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    if (TERMINAL_TASK_STATUSES.has(task.status)) return task;
    if (!options.dispatchCancellationRequested) this.requestTurnDispatchCancellation({ parentTaskId: taskId });
    const worktreeLeases = this.listLeases({ ownerTaskId: taskId }).filter((lease) => ["active", "expired"].includes(lease.status));
    const agentLeases = this.db.prepare("SELECT * FROM agent_leases WHERE owner_task_id = ? AND status = 'active'").all(taskId).map(normalizeAgentLease);
    const canceled = this.updateTask(taskId, {
      status: "canceled",
      completedAt: now(),
      workerId: null,
      heartbeatAt: null,
      claimToken: null,
      nextRetryAt: null,
    });
    for (const lease of worktreeLeases) this.releaseLease(lease.key, taskId, { ownerToken: lease.ownerToken });
    for (const lease of agentLeases) this.releaseAgentLease(lease.agentId, taskId, lease.ownerToken);
    const agentIds = new Set([task.agentId, ...agentLeases.map((lease) => lease.agentId)].filter(Boolean));
    for (const agentId of agentIds) {
      const agent = this.getAgent(agentId);
      if (agent) this.updateAgent(agentId, { status: "idle", metadata: { currentTaskId: null, agentLeaseToken: null, lifecycleState: "idle" } });
    }
    return canceled;
  }

  acquireLease(lease) {
    if (!lease?.key || !lease?.ownerTaskId) throw new TypeError("Lease key and ownerTaskId are required");
    const acquiredAt = now();
    const existing = normalizeLease(this.db.prepare("SELECT * FROM worktree_leases WHERE lease_key = ?").get(lease.key));
    if (existing && existing.status !== "active") transitionLease(existing.status, "active");
    assertLeaseStatus("active");
    const expiresAt = new Date(Date.now() + (lease.ttlMs ?? 120_000)).toISOString();
    const row = this.db.prepare(`
      INSERT INTO worktree_leases (
        lease_key, owner_task_id, owner_agent_id, owner_token, cwd, worktree_path, status,
        acquired_at, expires_at, heartbeat_at, released_at, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, NULL, ?)
      ON CONFLICT(lease_key) DO UPDATE SET
        owner_task_id = excluded.owner_task_id,
        owner_agent_id = excluded.owner_agent_id,
        owner_token = excluded.owner_token,
        cwd = excluded.cwd,
        worktree_path = excluded.worktree_path,
        status = 'active',
        acquired_at = excluded.acquired_at,
        expires_at = excluded.expires_at,
        heartbeat_at = excluded.heartbeat_at,
        released_at = NULL,
        metadata_json = excluded.metadata_json
      WHERE worktree_leases.status = 'released'
      RETURNING *
    `).get(
      lease.key,
      lease.ownerTaskId,
      lease.ownerAgentId ?? null,
      lease.ownerToken ?? null,
      lease.cwd ?? null,
      lease.worktreePath ?? null,
      acquiredAt,
      expiresAt,
      acquiredAt,
      json(lease.metadata ?? {}, {}),
    );
    if (!row) return null;
    this.recordEvent("task", lease.ownerTaskId, "lease.acquired", { key: lease.key, expiresAt });
    return normalizeLease(row);
  }

  renewLease(key, ownerTaskId, ttlMs = 120_000, ownerToken = null) {
    const heartbeatAt = now();
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();
    const row = this.db.prepare(`
      UPDATE worktree_leases
      SET heartbeat_at = ?, expires_at = ?
      WHERE lease_key = ? AND owner_task_id = ? AND status = 'active'
        AND (? IS NULL OR owner_token = ?)
      RETURNING *
    `).get(heartbeatAt, expiresAt, key, ownerTaskId, ownerToken, ownerToken);
    return normalizeLease(row);
  }

  releaseLease(key, ownerTaskId, options = {}) {
    const targetStatus = options.status ?? "released";
    assertLeaseStatus(targetStatus);
    const existing = normalizeLease(this.db.prepare("SELECT * FROM worktree_leases WHERE lease_key = ?").get(key));
    if (existing && existing.status !== targetStatus) transitionLease(existing.status, targetStatus);
    const releasedAt = now();
    const row = this.db.prepare(`
      UPDATE worktree_leases
      SET status = ?, released_at = ?, heartbeat_at = ?
      WHERE lease_key = ? AND owner_task_id = ? AND status IN ('active', 'expired')
        AND (? IS NULL OR owner_token = ?)
      RETURNING *
    `).get(targetStatus, releasedAt, releasedAt, key, ownerTaskId, options.ownerToken ?? null, options.ownerToken ?? null);
    if (row) this.recordEvent("task", ownerTaskId, "lease.released", { key, status: targetStatus });
    return normalizeLease(row);
  }

  listLeases(options = {}) {
    this.db.prepare(`
      UPDATE worktree_leases
      SET status = 'expired', released_at = COALESCE(released_at, ?)
      WHERE status = 'active' AND expires_at <= ?
    `).run(now(), now());
    const clauses = [];
    const values = [];
    if (options.status) {
      clauses.push("status = ?");
      values.push(options.status);
    }
    if (options.ownerTaskId) {
      clauses.push("owner_task_id = ?");
      values.push(options.ownerTaskId);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    values.push(options.limit ?? 100);
    return this.db.prepare(`SELECT * FROM worktree_leases ${where} ORDER BY acquired_at DESC LIMIT ?`).all(...values).map(normalizeLease);
  }

  recordEvent(entityType, entityId, eventType, payload = {}) {
    const timestamp = now();
    const result = this.db.prepare(`
      INSERT INTO events (entity_type, entity_id, event_type, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(entityType, entityId ?? null, eventType, json(payload, {}), timestamp);
    return {
      id: Number(result.lastInsertRowid),
      entityType,
      entityId: entityId ?? null,
      eventType,
      payload,
      createdAt: timestamp,
    };
  }

  listEvents(options = {}) {
    const clauses = [];
    const values = [];
    if (options.entityType) {
      clauses.push("entity_type = ?");
      values.push(options.entityType);
    }
    if (options.entityId) {
      clauses.push("entity_id = ?");
      values.push(options.entityId);
    }
    if (options.afterId !== undefined && options.afterId !== null) {
      clauses.push("id > ?");
      values.push(Number(options.afterId));
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    values.push(options.limit ?? 100);
    const direction = options.afterId !== undefined && options.afterId !== null ? "ASC" : "DESC";
    return this.db.prepare(`SELECT * FROM events ${where} ORDER BY id ${direction} LIMIT ?`).all(...values).map((row) => ({
      id: row.id,
      entityType: row.entity_type,
      entityId: row.entity_id,
      eventType: row.event_type,
      payload: parse(row.payload_json, {}),
      createdAt: row.created_at,
    }));
  }

  #migrate() {
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = OFF;");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec(`

      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        name TEXT,
        cwd TEXT,
        project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
        model TEXT,
        provider TEXT NOT NULL DEFAULT 'codex',
        status TEXT NOT NULL DEFAULT 'unknown',
        source TEXT,
        ephemeral INTEGER NOT NULL DEFAULT 0,
        forked_from_id TEXT,
        role TEXT,
        capabilities_json TEXT NOT NULL DEFAULT '[]',
        summary TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        last_task_at TEXT,
        archived_at TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}'
      );

      CREATE INDEX IF NOT EXISTS agents_cwd_idx ON agents(cwd);
      CREATE INDEX IF NOT EXISTS agents_role_idx ON agents(role);
      CREATE INDEX IF NOT EXISTS agents_status_idx ON agents(status);

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
        project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
        status TEXT NOT NULL CHECK (status IN (${TASK_STATUSES.map(sqlString).join(", ")})),
        prompt TEXT NOT NULL,
        cwd TEXT,
        source_thread_id TEXT,
        agent_id TEXT,
        mode TEXT,
        output TEXT,
        error TEXT,
        turn_id TEXT,
        role TEXT,
        required_capabilities_json TEXT NOT NULL DEFAULT '[]',
        routing_json TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        updated_at TEXT NOT NULL,
        worker_id TEXT,
        heartbeat_at TEXT,
        attempt INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 1,
        retry_delay_ms INTEGER NOT NULL DEFAULT 0,
        next_retry_at TEXT,
        claim_token TEXT,
        version INTEGER NOT NULL DEFAULT 0,
        metadata_json TEXT NOT NULL DEFAULT '{}'
      );

      CREATE INDEX IF NOT EXISTS tasks_status_idx ON tasks(status);
      CREATE INDEX IF NOT EXISTS tasks_agent_idx ON tasks(agent_id);
      CREATE INDEX IF NOT EXISTS tasks_created_idx ON tasks(created_at DESC);

      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        request_key TEXT,
        plan_id TEXT,
        name TEXT,
        status TEXT NOT NULL,
        cwd TEXT,
        project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        archived_at TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}'
      );

      CREATE INDEX IF NOT EXISTS runs_status_idx ON runs(status);
      CREATE INDEX IF NOT EXISTS runs_cwd_idx ON runs(cwd);

      CREATE TABLE IF NOT EXISTS project_memories (
        id TEXT PRIMARY KEY,
        cwd TEXT NOT NULL,
        project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
        kind TEXT NOT NULL DEFAULT 'note',
        title TEXT,
        content TEXT NOT NULL,
        tags_json TEXT NOT NULL DEFAULT '[]',
        source TEXT NOT NULL DEFAULT 'user',
        authority TEXT NOT NULL DEFAULT 'reference',
        subject TEXT,
        semantic_version TEXT,
        supersedes_json TEXT NOT NULL DEFAULT '[]',
        confidence REAL NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_used_at TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}'
      );

      CREATE INDEX IF NOT EXISTS project_memories_cwd_idx ON project_memories(cwd);
      CREATE INDEX IF NOT EXISTS project_memories_kind_idx ON project_memories(kind);
      CREATE INDEX IF NOT EXISTS project_memories_recency_idx ON project_memories(updated_at DESC);

      CREATE TABLE IF NOT EXISTS plans (
        id TEXT PRIMARY KEY,
        request_key TEXT UNIQUE,
        objective TEXT NOT NULL,
        cwd TEXT,
        project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
        status TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        planner_agent_id TEXT,
        plan_json TEXT,
        synthesis_json TEXT,
        feedback TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}'
      );

      CREATE INDEX IF NOT EXISTS plans_status_idx ON plans(status, updated_at DESC);

      CREATE TABLE IF NOT EXISTS turn_dispatches (
        id TEXT PRIMARY KEY,
        subject_type TEXT NOT NULL CHECK (subject_type IN ('plan', 'run', 'task')),
        subject_id TEXT NOT NULL,
        purpose TEXT NOT NULL CHECK (purpose IN ('planning', 'orchestration', 'execution', 'validation', 'synthesis')),
        revision INTEGER NOT NULL DEFAULT 1,
        parent_run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
        parent_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
        plan_id TEXT REFERENCES plans(id) ON DELETE SET NULL,
        status TEXT NOT NULL CHECK (status IN (${TURN_DISPATCH_STATUSES.map(sqlString).join(", ")})),
        prompt_fingerprint TEXT NOT NULL,
        execution_contract_fingerprint TEXT,
        context_snapshot_id TEXT,
        thread_id TEXT,
        agent_id TEXT,
        thread_action TEXT,
        submission_key TEXT NOT NULL,
        turn_id TEXT,
        turn_status TEXT,
        owner_instance_id TEXT,
        owner_token TEXT,
        heartbeat_at TEXT,
        lease_expires_at TEXT,
        cancellation_generation INTEGER NOT NULL DEFAULT 0,
        cancel_requested_at TEXT,
        deadline_at TEXT NOT NULL,
        started_at TEXT,
        terminal_at TEXT,
        last_probe_at TEXT,
        probe_count INTEGER NOT NULL DEFAULT 0,
        reconciliation_decision TEXT,
        failure_json TEXT,
        evidence_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 0,
        UNIQUE(subject_type, subject_id, purpose, revision)
      );

      CREATE INDEX IF NOT EXISTS turn_dispatches_status_idx ON turn_dispatches(status, updated_at);
      CREATE INDEX IF NOT EXISTS turn_dispatches_parent_run_idx ON turn_dispatches(parent_run_id, status);
      CREATE INDEX IF NOT EXISTS turn_dispatches_parent_task_idx ON turn_dispatches(parent_task_id, status);
      CREATE INDEX IF NOT EXISTS turn_dispatches_thread_idx ON turn_dispatches(thread_id, turn_id);

      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        canonical_key TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL CHECK (kind IN ('git', 'directory')),
        canonical_root TEXT NOT NULL,
        repository_common_dir TEXT,
        identity_version INTEGER NOT NULL,
        display_name TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}'
      );

      CREATE INDEX IF NOT EXISTS projects_root_idx ON projects(canonical_root);

      CREATE TABLE IF NOT EXISTS project_path_mappings (
        path TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        path_kind TEXT NOT NULL CHECK (path_kind IN ('root', 'member', 'legacy')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS project_path_mappings_project_idx ON project_path_mappings(project_id);

      CREATE TABLE IF NOT EXISTS migration_attention (
        id TEXT PRIMARY KEY,
        dedupe_key TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL,
        source_table TEXT,
        source_id TEXT,
        source_value TEXT,
        status TEXT NOT NULL CHECK (status IN ('open', 'resolved')) DEFAULT 'open',
        cause TEXT NOT NULL,
        created_at TEXT NOT NULL,
        resolved_at TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}'
      );

      CREATE INDEX IF NOT EXISTS migration_attention_status_idx ON migration_attention(status, created_at DESC);

      CREATE TABLE IF NOT EXISTS context_claims (
        id TEXT PRIMARY KEY,
        project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
        kind TEXT NOT NULL,
        subject TEXT,
        body TEXT NOT NULL,
        scope TEXT NOT NULL CHECK (scope IN ('global', 'project', 'workspace', 'task')),
        authority TEXT NOT NULL CHECK (authority IN (
          'user_explicit', 'project_contract', 'validated_artifact', 'validated_task_result',
          'observed_thread', 'model_inference', 'legacy_unverified'
        )),
        status TEXT NOT NULL CHECK (status IN ('candidate', 'active', 'disputed', 'superseded', 'expired', 'rejected')),
        revision INTEGER NOT NULL DEFAULT 1,
        content_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}'
      );

      CREATE INDEX IF NOT EXISTS context_claims_project_idx ON context_claims(project_id, status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS context_claims_subject_idx ON context_claims(subject, status);

      CREATE TABLE IF NOT EXISTS context_snapshots (
        id TEXT PRIMARY KEY,
        resolution_key TEXT NOT NULL UNIQUE,
        project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
        objective_hash TEXT NOT NULL,
        requested_scope_hash TEXT NOT NULL,
        resolver_version TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL CHECK (status IN ('building', 'validated', 'invalid')),
        fingerprint TEXT,
        error_json TEXT,
        created_at TEXT NOT NULL,
        validated_at TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        CHECK (status != 'validated' OR fingerprint IS NOT NULL)
      );

      CREATE INDEX IF NOT EXISTS context_snapshots_project_idx ON context_snapshots(project_id, status, created_at DESC);

      CREATE TABLE IF NOT EXISTS context_snapshot_claims (
        snapshot_id TEXT NOT NULL REFERENCES context_snapshots(id) ON DELETE CASCADE,
        claim_id TEXT NOT NULL REFERENCES context_claims(id) ON DELETE RESTRICT,
        disposition TEXT NOT NULL CHECK (disposition IN ('selected', 'excluded')),
        score REAL NOT NULL DEFAULT 0,
        reasons_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        PRIMARY KEY (snapshot_id, claim_id)
      );

      CREATE TABLE IF NOT EXISTS context_conflicts (
        id TEXT PRIMARY KEY,
        project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
        subject TEXT NOT NULL,
        scope TEXT NOT NULL,
        category TEXT NOT NULL CHECK (category IN ('authorization', 'contract', 'workspace', 'factual', 'preference')),
        blocking INTEGER NOT NULL CHECK (blocking IN (0, 1)),
        status TEXT NOT NULL CHECK (status IN ('unresolved', 'resolved')),
        claim_ids_json TEXT NOT NULL DEFAULT '[]',
        fingerprint TEXT NOT NULL UNIQUE,
        resolution_json TEXT,
        created_at TEXT NOT NULL,
        resolved_at TEXT
      );

      CREATE TABLE IF NOT EXISTS context_snapshot_conflicts (
        snapshot_id TEXT NOT NULL REFERENCES context_snapshots(id) ON DELETE CASCADE,
        conflict_id TEXT NOT NULL REFERENCES context_conflicts(id) ON DELETE RESTRICT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (snapshot_id, conflict_id)
      );

      CREATE TABLE IF NOT EXISTS global_runs (
        id TEXT PRIMARY KEY,
        request_key TEXT UNIQUE,
        objective TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN (
          'accepted', 'resolving_context', 'planning', 'preparing', 'running', 'waiting',
          'completed', 'failed', 'cancelled', 'attention_required'
        )),
        current_revision INTEGER,
        cancellation_requested_at TEXT,
        origin_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}'
      );

      CREATE INDEX IF NOT EXISTS global_runs_status_idx ON global_runs(status, created_at DESC);

      CREATE TABLE IF NOT EXISTS global_run_revisions (
        id TEXT PRIMARY KEY,
        global_run_id TEXT NOT NULL REFERENCES global_runs(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('building', 'validated', 'invalid')),
        context_snapshot_id TEXT NOT NULL REFERENCES context_snapshots(id) ON DELETE RESTRICT,
        context_snapshot_fingerprint TEXT NOT NULL,
        authorization_fingerprint TEXT NOT NULL,
        graph_fingerprint TEXT,
        created_at TEXT NOT NULL,
        validated_at TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        UNIQUE (global_run_id, revision),
        CHECK (status != 'validated' OR (graph_fingerprint IS NOT NULL AND validated_at IS NOT NULL))
      );

      CREATE TABLE IF NOT EXISTS global_run_projects (
        revision_id TEXT NOT NULL REFERENCES global_run_revisions(id) ON DELETE CASCADE,
        global_run_id TEXT NOT NULL REFERENCES global_runs(id) ON DELETE CASCADE,
        run_id TEXT NOT NULL UNIQUE REFERENCES runs(id) ON DELETE RESTRICT,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
        membership TEXT NOT NULL CHECK (membership IN ('required', 'optional')),
        created_at TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        PRIMARY KEY (revision_id, run_id)
      );

      CREATE INDEX IF NOT EXISTS global_run_projects_parent_idx ON global_run_projects(global_run_id, revision_id);

      CREATE TABLE IF NOT EXISTS authorization_manifests (
        id TEXT PRIMARY KEY,
        revision_id TEXT NOT NULL REFERENCES global_run_revisions(id) ON DELETE CASCADE,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE RESTRICT,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
        version INTEGER NOT NULL,
        fingerprint TEXT NOT NULL,
        manifest_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (revision_id, run_id),
        UNIQUE (revision_id, project_id)
      );

      CREATE TABLE IF NOT EXISTS cross_project_dependencies (
        id TEXT PRIMARY KEY,
        revision_id TEXT NOT NULL REFERENCES global_run_revisions(id) ON DELETE CASCADE,
        producer_run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE RESTRICT,
        consumer_run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE RESTRICT,
        condition TEXT NOT NULL CHECK (condition IN ('all_success', 'all_terminal', 'on_failure')),
        status TEXT NOT NULL CHECK (status IN ('pending', 'satisfied', 'failed', 'skipped')),
        fingerprint TEXT NOT NULL,
        required_outputs_json TEXT NOT NULL DEFAULT '[]',
        acceptance_criteria_json TEXT NOT NULL DEFAULT '[]',
        handoff_schema_version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        satisfied_at TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        CHECK (producer_run_id != consumer_run_id),
        UNIQUE (revision_id, producer_run_id, consumer_run_id, condition)
      );

      CREATE INDEX IF NOT EXISTS cross_project_dependencies_consumer_idx ON cross_project_dependencies(consumer_run_id, status);

      CREATE TABLE IF NOT EXISTS cross_project_handoffs (
        id TEXT PRIMARY KEY,
        dependency_id TEXT NOT NULL UNIQUE REFERENCES cross_project_dependencies(id) ON DELETE CASCADE,
        revision_id TEXT NOT NULL REFERENCES global_run_revisions(id) ON DELETE CASCADE,
        producer_run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE RESTRICT,
        consumer_run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE RESTRICT,
        schema_version INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('prepared', 'validated', 'received', 'invalid')),
        dependency_fingerprint TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        receipt_hash TEXT,
        payload_json TEXT NOT NULL,
        validation_json TEXT,
        prepared_at TEXT NOT NULL,
        validated_at TEXT,
        received_at TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        CHECK (producer_run_id != consumer_run_id),
        CHECK (status != 'received' OR (receipt_hash IS NOT NULL AND received_at IS NOT NULL))
      );

      CREATE INDEX IF NOT EXISTS cross_project_handoffs_consumer_idx ON cross_project_handoffs(consumer_run_id, status);

      CREATE TABLE IF NOT EXISTS global_run_results (
        global_run_id TEXT PRIMARY KEY REFERENCES global_runs(id) ON DELETE CASCADE,
        status TEXT NOT NULL,
        projection_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS context_claim_sources (
        claim_id TEXT NOT NULL REFERENCES context_claims(id) ON DELETE CASCADE,
        source_kind TEXT NOT NULL,
        source_id TEXT NOT NULL,
        source_revision TEXT NOT NULL DEFAULT '',
        source_digest TEXT NOT NULL,
        created_at TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        PRIMARY KEY (claim_id, source_kind, source_id, source_revision)
      );

      CREATE TABLE IF NOT EXISTS context_claim_supersessions (
        incoming_claim_id TEXT NOT NULL REFERENCES context_claims(id) ON DELETE CASCADE,
        superseded_claim_id TEXT NOT NULL REFERENCES context_claims(id) ON DELETE RESTRICT,
        reason TEXT NOT NULL,
        created_at TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        PRIMARY KEY (incoming_claim_id, superseded_claim_id),
        CHECK (incoming_claim_id != superseded_claim_id)
      );

      CREATE TABLE IF NOT EXISTS thread_knowledge_snapshots (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        through_turn_id TEXT,
        project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
        role TEXT,
        topics_json TEXT NOT NULL DEFAULT '[]',
        source_digest TEXT NOT NULL,
        extractor_version TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('current', 'superseded', 'incomplete')),
        created_at TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        UNIQUE (thread_id, source_digest, extractor_version)
      );

      CREATE INDEX IF NOT EXISTS thread_knowledge_current_idx ON thread_knowledge_snapshots(thread_id, status, created_at DESC);

      CREATE TABLE IF NOT EXISTS thread_knowledge_claims (
        snapshot_id TEXT NOT NULL REFERENCES thread_knowledge_snapshots(id) ON DELETE CASCADE,
        claim_id TEXT NOT NULL REFERENCES context_claims(id) ON DELETE RESTRICT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (snapshot_id, claim_id)
      );

      CREATE TABLE IF NOT EXISTS thread_lineage (
        thread_id TEXT NOT NULL,
        parent_thread_id TEXT NOT NULL,
        relationship TEXT NOT NULL CHECK (relationship IN ('fork', 'supersede')),
        inherited_snapshot_id TEXT REFERENCES thread_knowledge_snapshots(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        PRIMARY KEY (thread_id, parent_thread_id, relationship),
        CHECK (thread_id != parent_thread_id)
      );

      CREATE INDEX IF NOT EXISTS thread_lineage_parent_idx ON thread_lineage(parent_thread_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS thread_budgets (
        id TEXT PRIMARY KEY,
        project_scope TEXT NOT NULL,
        project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
        role_scope TEXT NOT NULL,
        version INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('current', 'superseded')),
        fingerprint TEXT NOT NULL,
        policy_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        superseded_at TEXT,
        UNIQUE (project_scope, role_scope, version)
      );

      CREATE UNIQUE INDEX IF NOT EXISTS thread_budgets_current_idx
        ON thread_budgets(project_scope, role_scope) WHERE status = 'current';

      CREATE TABLE IF NOT EXISTS thread_lifecycle (
        thread_id TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
        project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
        role TEXT,
        thread_type TEXT NOT NULL CHECK (thread_type IN ('durable_specialist', 'run_orchestrator', 'ephemeral_worker')),
        status TEXT NOT NULL CHECK (status IN ('candidate', 'active', 'idle', 'compacted', 'superseded', 'archived')),
        context_health REAL NOT NULL CHECK (context_health >= 0 AND context_health <= 1),
        snapshot_id TEXT REFERENCES thread_knowledge_snapshots(id) ON DELETE SET NULL,
        successor_thread_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
        policy_version INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        CHECK (successor_thread_id IS NULL OR successor_thread_id != thread_id)
      );

      CREATE INDEX IF NOT EXISTS thread_lifecycle_scope_idx ON thread_lifecycle(project_id, role, status, updated_at DESC);

      CREATE TABLE IF NOT EXISTS thread_lifecycle_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        thread_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        from_status TEXT,
        to_status TEXT NOT NULL,
        reason TEXT NOT NULL,
        evidence_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS thread_lifecycle_events_thread_idx ON thread_lifecycle_events(thread_id, id DESC);

      CREATE TABLE IF NOT EXISTS routing_decisions (
        id TEXT PRIMARY KEY,
        task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
        run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
        project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
        context_snapshot_id TEXT,
        decision TEXT NOT NULL CHECK (decision IN ('reuse', 'fork', 'spawn', 'ephemeral', 'wait')),
        selected_agent_id TEXT,
        candidates_json TEXT NOT NULL DEFAULT '[]',
        evidence_json TEXT NOT NULL DEFAULT '[]',
        rejection_reasons_json TEXT NOT NULL DEFAULT '[]',
        provenance_json TEXT NOT NULL DEFAULT '{}',
        fingerprint TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS routing_decisions_task_idx ON routing_decisions(task_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS routing_decisions_project_idx ON routing_decisions(project_id, created_at DESC);

      CREATE TRIGGER IF NOT EXISTS context_claims_no_active_insert
      BEFORE INSERT ON context_claims
      WHEN NEW.status IN ('active', 'disputed')
      BEGIN
        SELECT RAISE(ABORT, 'context claim must be created as candidate before activation');
      END;

      CREATE TRIGGER IF NOT EXISTS context_claims_require_source_on_activation
      BEFORE UPDATE OF status ON context_claims
      WHEN NEW.status IN ('active', 'disputed')
        AND NOT EXISTS (SELECT 1 FROM context_claim_sources WHERE claim_id = NEW.id)
      BEGIN
        SELECT RAISE(ABORT, 'active context claim requires provenance');
      END;

      CREATE TRIGGER IF NOT EXISTS context_claim_sources_keep_active_provenance
      BEFORE DELETE ON context_claim_sources
      WHEN (SELECT status FROM context_claims WHERE id = OLD.claim_id) IN ('active', 'disputed')
        AND (SELECT COUNT(*) FROM context_claim_sources WHERE claim_id = OLD.claim_id) <= 1
      BEGIN
        SELECT RAISE(ABORT, 'active context claim requires provenance');
      END;

      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY,
        task_id TEXT,
        agent_id TEXT,
        thread_id TEXT,
        turn_id TEXT,
        method TEXT NOT NULL,
        status TEXT NOT NULL,
        request_json TEXT NOT NULL DEFAULT '{}',
        decision TEXT,
        created_at TEXT NOT NULL,
        resolved_at TEXT,
        expires_at TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}'
      );

      CREATE INDEX IF NOT EXISTS approvals_status_idx ON approvals(status, created_at DESC);

      CREATE TABLE IF NOT EXISTS plan_revisions (
        plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
        version INTEGER NOT NULL,
        plan_json TEXT NOT NULL,
        feedback TEXT,
        created_at TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        PRIMARY KEY (plan_id, version)
      );
      CREATE INDEX IF NOT EXISTS approvals_task_idx ON approvals(task_id);

      CREATE TABLE IF NOT EXISTS managed_worktrees (
        id TEXT PRIMARY KEY,
        repo_root TEXT NOT NULL,
        path TEXT NOT NULL UNIQUE,
        branch TEXT,
        base_ref TEXT,
        status TEXT NOT NULL,
        owner_task_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        removed_at TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}'
      );

      CREATE INDEX IF NOT EXISTS managed_worktrees_status_idx ON managed_worktrees(status, updated_at DESC);

      CREATE TABLE IF NOT EXISTS role_templates (
        name TEXT PRIMARY KEY,
        description TEXT,
        developer_instructions TEXT NOT NULL,
        capabilities_json TEXT NOT NULL DEFAULT '[]',
        tools_json TEXT NOT NULL DEFAULT '[]',
        skills_json TEXT NOT NULL DEFAULT '[]',
        model TEXT,
        effort TEXT,
        sandbox TEXT NOT NULL DEFAULT 'read-only',
        approval_policy TEXT NOT NULL DEFAULT 'never',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}'
      );

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value_json TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS dashboard_leases (
        project_key TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        lease_token TEXT NOT NULL,
        acquired_at TEXT NOT NULL,
        heartbeat_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS dashboard_leases_expiry_idx ON dashboard_leases(expires_at);

      CREATE TABLE IF NOT EXISTS project_queue_items (
        id TEXT PRIMARY KEY,
        project_key TEXT NOT NULL,
        run_id TEXT NOT NULL UNIQUE,
        cwd TEXT,
        status TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        lease_owner TEXT,
        lease_token TEXT,
        lease_expires_at TEXT,
        attempt INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 3,
        not_before TEXT,
        last_error TEXT,
        payload_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS project_queue_ready_idx ON project_queue_items(status, not_before, sequence);
      CREATE INDEX IF NOT EXISTS project_queue_project_idx ON project_queue_items(project_key, status);

      CREATE TABLE IF NOT EXISTS notifications (
        id TEXT PRIMARY KEY,
        project_key TEXT NOT NULL,
        run_id TEXT,
        task_id TEXT,
        kind TEXT NOT NULL,
        severity TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        dedupe_key TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}'
      );

      CREATE INDEX IF NOT EXISTS notifications_project_idx ON notifications(project_key, created_at DESC);

      CREATE TABLE IF NOT EXISTS notification_receipts (
        notification_id TEXT NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
        audience_id TEXT NOT NULL,
        read_at TEXT NOT NULL,
        PRIMARY KEY (notification_id, audience_id)
      );

      CREATE TABLE IF NOT EXISTS run_results (
        run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
        status TEXT NOT NULL,
        summary TEXT,
        task_results_json TEXT NOT NULL DEFAULT '[]',
        validation_json TEXT NOT NULL DEFAULT '[]',
        artifacts_json TEXT NOT NULL DEFAULT '[]',
        unresolved_risks_json TEXT NOT NULL DEFAULT '[]',
        synthesis_status TEXT NOT NULL DEFAULT 'not_applicable',
        synthesis_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS control_result_deliveries (
        id TEXT PRIMARY KEY,
        delivery_key TEXT NOT NULL UNIQUE,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        origin_thread_id TEXT NOT NULL,
        origin_turn_id TEXT,
        status TEXT NOT NULL,
        payload_json TEXT NOT NULL DEFAULT '{}',
        attempt INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 20,
        not_before TEXT,
        last_error TEXT,
        delivered_turn_id TEXT,
        delivery_method TEXT,
        direct_delivered_at TEXT,
        acknowledged_at TEXT,
        acknowledged_turn_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        delivered_at TEXT
      );

      CREATE INDEX IF NOT EXISTS control_result_deliveries_ready_idx
        ON control_result_deliveries(status, not_before, created_at);
      CREATE INDEX IF NOT EXISTS control_result_deliveries_origin_idx
        ON control_result_deliveries(origin_thread_id, status, created_at);

      CREATE TABLE IF NOT EXISTS task_dependencies (
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        depends_on_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (task_id, depends_on_task_id),
        CHECK (task_id != depends_on_task_id)
      );

      CREATE INDEX IF NOT EXISTS task_dependencies_parent_idx ON task_dependencies(depends_on_task_id);

      CREATE TABLE IF NOT EXISTS worktree_leases (
        lease_key TEXT PRIMARY KEY,
        owner_task_id TEXT NOT NULL,
        owner_agent_id TEXT,
        owner_token TEXT,
        cwd TEXT,
        worktree_path TEXT,
        status TEXT NOT NULL,
        acquired_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        heartbeat_at TEXT NOT NULL,
        released_at TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}'
      );

      CREATE INDEX IF NOT EXISTS worktree_leases_status_idx ON worktree_leases(status, expires_at);

      CREATE TABLE IF NOT EXISTS agent_leases (
        agent_id TEXT PRIMARY KEY,
        owner_task_id TEXT NOT NULL,
        owner_token TEXT NOT NULL,
        status TEXT NOT NULL,
        acquired_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        heartbeat_at TEXT NOT NULL,
        released_at TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}'
      );

      CREATE INDEX IF NOT EXISTS agent_leases_status_idx ON agent_leases(status, expires_at);

      CREATE TABLE IF NOT EXISTS integration_journal (
        id TEXT PRIMARY KEY,
        journal_key TEXT NOT NULL UNIQUE,
        worktree_id TEXT NOT NULL REFERENCES managed_worktrees(id) ON DELETE RESTRICT,
        task_id TEXT,
        repo_root TEXT NOT NULL,
        strategy TEXT NOT NULL CHECK (strategy IN ('patch', 'commit')),
        status TEXT NOT NULL CHECK (status IN ('prepared', 'applying', 'applied', 'recorded')),
        artifact_json TEXT NOT NULL,
        evidence_json TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        applied_at TEXT,
        recorded_at TEXT
      );

      CREATE INDEX IF NOT EXISTS integration_journal_pending_idx ON integration_journal(status, repo_root, created_at);

      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        entity_type TEXT NOT NULL,
        entity_id TEXT,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS events_entity_idx ON events(entity_type, entity_id, id DESC);
      `);
    this.#ensureColumn("tasks", "worker_id", "TEXT");
    this.#ensureColumn("agents", "archived_at", "TEXT");
    this.#ensureColumn("runs", "archived_at", "TEXT");
    this.#ensureColumn("project_memories", "authority", "TEXT");
    this.#ensureColumn("project_memories", "subject", "TEXT");
    this.#ensureColumn("project_memories", "semantic_version", "TEXT");
    this.#ensureColumn("project_memories", "supersedes_json", "TEXT NOT NULL DEFAULT '[]'");
    this.#ensureColumn("tasks", "heartbeat_at", "TEXT");
    this.#ensureColumn("tasks", "attempt", "INTEGER NOT NULL DEFAULT 0");
    this.#ensureColumn("tasks", "max_attempts", "INTEGER NOT NULL DEFAULT 1");
    this.#ensureColumn("tasks", "retry_delay_ms", "INTEGER NOT NULL DEFAULT 0");
    this.#ensureColumn("tasks", "next_retry_at", "TEXT");
    this.#ensureColumn("tasks", "claim_token", "TEXT");
    this.#ensureColumn("tasks", "version", "INTEGER NOT NULL DEFAULT 0");
    this.#ensureColumn("tasks", "run_id", "TEXT");
    this.#ensureColumn("tasks", "project_id", "TEXT REFERENCES projects(id) ON DELETE SET NULL");
    this.#ensureColumn("agents", "project_id", "TEXT REFERENCES projects(id) ON DELETE SET NULL");
    this.#ensureColumn("runs", "project_id", "TEXT REFERENCES projects(id) ON DELETE SET NULL");
    this.#ensureColumn("project_memories", "project_id", "TEXT REFERENCES projects(id) ON DELETE SET NULL");
    this.#ensureColumn("plans", "project_id", "TEXT REFERENCES projects(id) ON DELETE SET NULL");
    this.#ensureColumn("worktree_leases", "owner_token", "TEXT");
    this.#ensureColumn("runs", "request_key", "TEXT");
    this.#ensureColumn("runs", "plan_id", "TEXT");
    this.#ensureColumn("role_templates", "skills_json", "TEXT NOT NULL DEFAULT '[]'");
    this.#ensureColumn("role_templates", "effort", "TEXT");
    this.#ensureColumn("control_result_deliveries", "delivery_method", "TEXT");
    this.#ensureColumn("control_result_deliveries", "direct_delivered_at", "TEXT");
    this.#ensureColumn("control_result_deliveries", "acknowledged_at", "TEXT");
    this.#ensureColumn("control_result_deliveries", "acknowledged_turn_id", "TEXT");
    this.#ensureColumn("cross_project_dependencies", "required_outputs_json", "TEXT NOT NULL DEFAULT '[]'");
    this.#ensureColumn("cross_project_dependencies", "acceptance_criteria_json", "TEXT NOT NULL DEFAULT '[]'");
    this.#ensureColumn("cross_project_dependencies", "handoff_schema_version", "INTEGER NOT NULL DEFAULT 1");
    this.#rebuildTasksTableIfNeeded();
    this.#rebuildRoutingDecisionsTableIfNeeded();
    this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS runs_request_key_idx ON runs(request_key) WHERE request_key IS NOT NULL");
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS tasks_run_idx ON tasks(run_id, created_at);
      CREATE INDEX IF NOT EXISTS tasks_project_idx ON tasks(project_id, created_at);
      CREATE INDEX IF NOT EXISTS agents_project_idx ON agents(project_id, updated_at);
      CREATE INDEX IF NOT EXISTS runs_project_idx ON runs(project_id, created_at);
      CREATE INDEX IF NOT EXISTS project_memories_project_idx ON project_memories(project_id, updated_at);
      CREATE INDEX IF NOT EXISTS plans_project_idx ON plans(project_id, updated_at);
      CREATE INDEX IF NOT EXISTS routing_decisions_task_idx ON routing_decisions(task_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS routing_decisions_project_idx ON routing_decisions(project_id, created_at DESC);
      DROP TRIGGER IF EXISTS tasks_sync_run_id_insert;
      DROP TRIGGER IF EXISTS tasks_sync_run_id_update;
      CREATE TRIGGER tasks_sync_run_id_insert AFTER INSERT ON tasks
      WHEN NEW.run_id IS NULL AND json_extract(NEW.metadata_json, '$.runId') IS NOT NULL
      BEGIN
        UPDATE tasks SET run_id = (
          SELECT id FROM runs WHERE id = json_extract(NEW.metadata_json, '$.runId')
        ) WHERE id = NEW.id;
      END;
      CREATE TRIGGER tasks_sync_run_id_update AFTER UPDATE OF metadata_json ON tasks
      BEGIN
        UPDATE tasks SET run_id = (
          SELECT id FROM runs WHERE id = json_extract(NEW.metadata_json, '$.runId')
        ) WHERE id = NEW.id;
      END;
    `);
    this.#backfillProjectsAndLegacyMemories();
    const lifecycleTimestamp = now();
    this.db.prepare(`
      INSERT OR IGNORE INTO thread_lifecycle (
        thread_id, project_id, role, thread_type, status, context_health, snapshot_id,
        successor_thread_id, policy_version, created_at, updated_at, metadata_json
      ) SELECT id, project_id, role,
        CASE WHEN ephemeral = 1 THEN 'ephemeral_worker'
             WHEN json_extract(metadata_json, '$.executionPlane') = 'orchestrator' THEN 'run_orchestrator'
             ELSE 'durable_specialist' END,
        CASE WHEN archived_at IS NOT NULL THEN 'archived'
             WHEN status IN ('leased', 'running', 'validating', 'approval_waiting') THEN 'active'
             WHEN status IN ('idle', 'available') THEN 'idle'
             ELSE 'candidate' END,
        0.35, NULL, NULL, 1, ?, ?, '{}'
      FROM agents
    `).run(lifecycleTimestamp, lifecycleTimestamp);
    this.db.exec(`PRAGMA user_version = ${CURRENT_SCHEMA_VERSION}; COMMIT;`);
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* transaction may already be closed */ }
      throw error;
    } finally {
      this.db.exec("PRAGMA foreign_keys = ON");
    }
  }

  #backupBeforeMigration() {
    if (this.path === ":memory:" || this.schemaVersionBeforeMigration >= CURRENT_SCHEMA_VERSION) return null;
    const tableCount = Number(this.db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").get().count ?? 0);
    if (!tableCount) return null;
    const backupPath = `${this.path}.backup-v${this.schemaVersionBeforeMigration}-${Date.now()}.sqlite`;
    this.db.exec(`VACUUM INTO ${sqlString(backupPath)}`);
    return backupPath;
  }

  #rebuildTasksTableIfNeeded() {
    const schema = this.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'tasks'").get()?.sql ?? "";
    const hasRunForeignKey = this.db.prepare("PRAGMA foreign_key_list(tasks)").all().some((entry) => entry.from === "run_id" && entry.table === "runs");
    const hasStatusConstraint = /CHECK\s*\(status\s+IN/i.test(schema);
    if (hasRunForeignKey && hasStatusConstraint) return;
    this.db.exec(`
      UPDATE tasks SET run_id = json_extract(metadata_json, '$.runId')
      WHERE run_id IS NULL AND EXISTS (
        SELECT 1 FROM runs WHERE runs.id = json_extract(tasks.metadata_json, '$.runId')
      );
      CREATE TABLE tasks_migrating (
        id TEXT PRIMARY KEY,
        run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
        project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
        status TEXT NOT NULL CHECK (status IN (${TASK_STATUSES.map(sqlString).join(", ")})),
        prompt TEXT NOT NULL,
        cwd TEXT,
        source_thread_id TEXT,
        agent_id TEXT,
        mode TEXT,
        output TEXT,
        error TEXT,
        turn_id TEXT,
        role TEXT,
        required_capabilities_json TEXT NOT NULL DEFAULT '[]',
        routing_json TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        updated_at TEXT NOT NULL,
        worker_id TEXT,
        heartbeat_at TEXT,
        attempt INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 1,
        retry_delay_ms INTEGER NOT NULL DEFAULT 0,
        next_retry_at TEXT,
        claim_token TEXT,
        version INTEGER NOT NULL DEFAULT 0,
        metadata_json TEXT NOT NULL DEFAULT '{}'
      );
      INSERT INTO tasks_migrating (
        id, run_id, project_id, status, prompt, cwd, source_thread_id, agent_id, mode, output, error,
        turn_id, role, required_capabilities_json, routing_json, created_at, started_at,
        completed_at, updated_at, worker_id, heartbeat_at, attempt, max_attempts,
        retry_delay_ms, next_retry_at, claim_token, version, metadata_json
      ) SELECT
        id, run_id, project_id, status, prompt, cwd, source_thread_id, agent_id, mode, output, error,
        turn_id, role, required_capabilities_json, routing_json, created_at, started_at,
        completed_at, updated_at, worker_id, heartbeat_at, attempt, max_attempts,
        retry_delay_ms, next_retry_at, claim_token, version, metadata_json
      FROM tasks;
      DROP TABLE tasks;
      ALTER TABLE tasks_migrating RENAME TO tasks;
      CREATE INDEX tasks_status_idx ON tasks(status);
      CREATE INDEX tasks_agent_idx ON tasks(agent_id);
      CREATE INDEX tasks_created_idx ON tasks(created_at DESC);
      CREATE INDEX tasks_run_idx ON tasks(run_id, created_at);
      CREATE INDEX tasks_project_idx ON tasks(project_id, created_at);
    `);
  }

  #rebuildRoutingDecisionsTableIfNeeded() {
    const schema = this.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'routing_decisions'").get()?.sql ?? "";
    if (/['"]ephemeral['"]/.test(schema) && /['"]wait['"]/.test(schema)) return;
    this.db.exec(`
      CREATE TABLE routing_decisions_migrating (
        id TEXT PRIMARY KEY,
        task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
        run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
        project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
        context_snapshot_id TEXT,
        decision TEXT NOT NULL CHECK (decision IN ('reuse', 'fork', 'spawn', 'ephemeral', 'wait')),
        selected_agent_id TEXT,
        candidates_json TEXT NOT NULL DEFAULT '[]',
        evidence_json TEXT NOT NULL DEFAULT '[]',
        rejection_reasons_json TEXT NOT NULL DEFAULT '[]',
        provenance_json TEXT NOT NULL DEFAULT '{}',
        fingerprint TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      INSERT INTO routing_decisions_migrating SELECT * FROM routing_decisions;
      DROP TABLE routing_decisions;
      ALTER TABLE routing_decisions_migrating RENAME TO routing_decisions;
    `);
  }

  #backfillProjectsAndLegacyMemories() {
    const sources = ["agents", "runs", "tasks", "project_memories", "plans"];
    const paths = new Set();
    for (const table of sources) {
      for (const row of this.db.prepare(`SELECT DISTINCT cwd FROM ${table} WHERE cwd IS NOT NULL AND TRIM(cwd) != ''`).all()) {
        paths.add(row.cwd);
      }
    }

    for (const cwd of paths) {
      let project;
      try {
        project = this.registerProject(cwd);
      } catch (error) {
        this.#recordMigrationAttention({
          kind: "project_identity_unresolved",
          sourceTable: "cwd_backfill",
          sourceValue: cwd,
          cause: error.message,
          metadata: { code: error.code ?? "PROJECT_IDENTITY_FAILED" },
        });
        continue;
      }
      for (const table of sources) {
        this.db.prepare(`UPDATE ${table} SET project_id = ? WHERE cwd = ? AND project_id IS NULL`).run(project.id, cwd);
      }
    }

    for (const row of this.db.prepare("SELECT id FROM project_memories").all()) {
      this.#backfillMemoryClaim(row.id);
    }
  }

  #resolveProjectId(cwd, explicitProjectId = null, context = {}) {
    if (explicitProjectId) {
      if (!this.getProject(explicitProjectId)) {
        throw Object.assign(new Error(`Project not found: ${explicitProjectId}`), { code: "PROJECT_NOT_FOUND" });
      }
      return explicitProjectId;
    }
    if (!cwd) return null;
    try {
      return this.registerProject(cwd).id;
    } catch (error) {
      this.#recordMigrationAttention({
        kind: "project_identity_unresolved",
        sourceTable: context.sourceTable ?? null,
        sourceId: context.sourceId ?? null,
        sourceValue: cwd,
        cause: error.message,
        metadata: { code: error.code ?? "PROJECT_IDENTITY_FAILED", runtimeWrite: true },
      });
      return null;
    }
  }

  #assignProject(table, id, cwd, explicitProjectId = null) {
    const allowedTables = new Set(["agents", "tasks", "runs", "project_memories", "plans"]);
    if (!allowedTables.has(table)) throw new TypeError(`Unsupported project assignment table: ${table}`);
    const projectId = this.#resolveProjectId(cwd, explicitProjectId, { sourceTable: table, sourceId: id });
    if (projectId) this.db.prepare(`UPDATE ${table} SET project_id = ? WHERE id = ?`).run(projectId, id);
    return projectId;
  }

  #backfillMemoryClaim(memoryId) {
    const memory = this.db.prepare("SELECT * FROM project_memories WHERE id = ?").get(memoryId);
    if (!memory) return null;
    let projectId = memory.project_id ?? null;
    if (!projectId) {
      try {
        const project = this.registerProject(memory.cwd);
        projectId = project.id;
        this.db.prepare("UPDATE project_memories SET project_id = ? WHERE id = ?").run(projectId, memory.id);
      } catch (error) {
        this.#recordMigrationAttention({
          kind: "legacy_memory_project_unresolved",
          sourceTable: "project_memories",
          sourceId: memory.id,
          sourceValue: memory.cwd,
          cause: error.message,
          metadata: { code: error.code ?? "PROJECT_IDENTITY_FAILED" },
        });
      }
    }

    const claimId = `claim_legacy_${createHash("sha256").update(memory.id).digest("hex").slice(0, 24)}`;
    const authority = memoryClaimAuthority(memory);
    const status = authority === "legacy_unverified" ? "candidate" : "active";
    const subject = normalizedContractSubject(memory);
    const contentHash = contextContentHash({ kind: memory.kind ?? "note", subject, body: memory.content, scope: "project", projectId });
    const timestamp = now();
    this.db.prepare(`
      INSERT INTO context_claims (
        id, project_id, kind, subject, body, scope, authority, status, revision,
        content_hash, created_at, updated_at, metadata_json
      ) VALUES (?, ?, ?, ?, ?, 'project', ?, 'candidate', 1, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        project_id = excluded.project_id,
        kind = excluded.kind,
        subject = excluded.subject,
        body = excluded.body,
        authority = excluded.authority,
        content_hash = excluded.content_hash,
        updated_at = excluded.updated_at,
        metadata_json = excluded.metadata_json
    `).run(
      claimId,
      projectId,
      memory.kind ?? "note",
      subject,
      memory.content,
      authority,
      contentHash,
      memory.created_at ?? timestamp,
      timestamp,
      json({ legacyMemoryId: memory.id, legacyCwd: memory.cwd }, {}),
    );
    this.db.prepare(`
      INSERT INTO context_claim_sources (
        claim_id, source_kind, source_id, source_revision, source_digest, created_at, metadata_json
      ) VALUES (?, 'legacy_memory', ?, '', ?, ?, '{}')
      ON CONFLICT(claim_id, source_kind, source_id, source_revision)
      DO UPDATE SET source_digest = excluded.source_digest
    `).run(claimId, memory.id, contentHash, timestamp);
    if (status === "active") {
      this.db.prepare("UPDATE context_claims SET status = 'active', updated_at = ? WHERE id = ? AND status = 'candidate'").run(timestamp, claimId);
    }
    return normalizeContextClaim(this.db.prepare("SELECT * FROM context_claims WHERE id = ?").get(claimId));
  }

  #recordMigrationAttention(entry) {
    const dedupeKey = [entry.kind, entry.sourceTable ?? "", entry.sourceId ?? "", entry.sourceValue ?? ""].join(":");
    const id = `migration_attention_${createHash("sha256").update(dedupeKey).digest("hex").slice(0, 24)}`;
    const timestamp = now();
    this.db.prepare(`
      INSERT INTO migration_attention (
        id, dedupe_key, kind, source_table, source_id, source_value, status,
        cause, created_at, resolved_at, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, NULL, ?)
      ON CONFLICT(dedupe_key) DO UPDATE SET cause = excluded.cause, metadata_json = excluded.metadata_json
    `).run(
      id,
      dedupeKey,
      entry.kind,
      entry.sourceTable ?? null,
      entry.sourceId ?? null,
      entry.sourceValue ?? null,
      entry.cause,
      timestamp,
      json(entry.metadata ?? {}, {}),
    );
    return normalizeMigrationAttention(this.db.prepare("SELECT * FROM migration_attention WHERE id = ?").get(id));
  }

  #ensureColumn(table, column, definition) {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all();
    if (!columns.some((entry) => entry.name === column)) {
      try {
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
      } catch (error) {
        if (!String(error.message).includes("duplicate column name")) throw error;
      }
    }
  }
}

export { CURRENT_SCHEMA_VERSION, DEFAULT_DB_PATH, LEGACY_DB_PATH };
