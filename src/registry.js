import { existsSync, mkdirSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const LEGACY_DB_PATH = join(homedir(), ".codex", "control-plane", "registry.sqlite");
const DEFAULT_DB_PATH = join(homedir(), ".codex", "control-plane", "v2", "registry.sqlite");

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
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    archivedAt: row.archived_at ?? null,
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
  return {
    id: row.id, projectKey: row.project_key, runId: row.run_id, taskId: row.task_id,
    kind: row.kind, severity: row.severity, title: row.title, body: row.body,
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

function normalizeMemory(row) {
  if (!row) return null;
  const metadata = parse(row.metadata_json, {});
  return {
    id: row.id,
    cwd: row.cwd,
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

function normalizePlan(row) {
  if (!row) return null;
  return {
    id: row.id,
    requestKey: row.request_key,
    objective: row.objective,
    cwd: row.cwd,
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
    this.#migrate();
  }

  close() {
    if (!this.closed) {
      this.db.close();
      this.closed = true;
    }
  }

  recoverInterruptedTasks(options = {}) {
    const timestamp = now();
    const staleBefore = options.staleBefore ?? null;
    const rows = this.db.prepare(`
      SELECT * FROM tasks
      WHERE status IN ('running', 'approval_waiting', 'agent_done', 'validating')
        AND (? IS NULL OR COALESCE(heartbeat_at, updated_at, created_at) < ?)
        AND (? IS NULL OR worker_id = ?)
        AND (? IS NULL OR id = ?)
    `).all(staleBefore, staleBefore, options.workerId ?? null, options.workerId ?? null, options.taskId ?? null, options.taskId ?? null).map(normalizeTask);
    const update = this.db.prepare(`
      UPDATE tasks
      SET status = ?, error = ?, worker_id = NULL, claim_token = NULL, turn_id = NULL,
          next_retry_at = NULL, heartbeat_at = NULL, updated_at = ?, version = version + 1,
          metadata_json = json_set(metadata_json, '$.recovery', json(?))
      WHERE id = ?
    `);
    for (const task of rows) {
      const readOnly = task.metadata?.sideEffectPolicy === 'read_only'
        || task.metadata?.execution?.sandbox === 'read-only';
      const status = readOnly && task.status === 'running' ? 'queued' : 'recovery_attention';
      const error = status === 'queued' ? null : 'Control-plane restarted with an uncertain active turn';
      update.run(status, error, timestamp, json({ previousStatus: task.status, recoveredAt: timestamp, automaticRetry: status === 'queued' }, {}), task.id);
      this.recordEvent('task', task.id, `task.${status}`, { previousStatus: task.status, restartRecovery: true });
      if (status === 'recovery_attention') {
        const run = task.metadata?.runId ? this.getRun(task.metadata.runId) : null;
        this.createNotification({ projectKey: run?.cwd ?? task.cwd ?? 'workspace', runId: run?.id, taskId: task.id, kind: 'recovery_attention', severity: 'warning', title: '재시작 후 확인 필요', body: '이전 작업의 부작용 여부가 불확실하여 자동 재실행하지 않았습니다.', dedupeKey: `${task.id}:recovery_attention:${task.version}` });
      }
    }
    return rows.length;
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
      agent.status ?? existing?.status ?? "unknown",
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
    return this.getAgent(agentId);
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
        AND status IN ('running', 'approval_waiting', 'agent_done', 'validating')
      LIMIT 1
    `).get(agentId);
    if (activeTask) {
      throw Object.assign(new Error(`Agent ${agentId} owns active task ${activeTask.id} and cannot be archived`), { code: "ARCHIVE_ACTIVE_AGENT" });
    }
    if (!['idle', 'available', 'unknown'].includes(agent.status)) {
      throw Object.assign(new Error(`Agent ${agentId} must be idle before archive (status: ${agent.status})`), { code: "ARCHIVE_ACTIVE_AGENT" });
    }
    if (options.validateOnly) return agent;
    const archivedAt = now();
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
        AND status IN ('running', 'approval_waiting', 'agent_done', 'validating')
      LIMIT 1
    `).get(agentId);
    if (activeTask) {
      throw Object.assign(new Error(`Agent ${agentId} owns active task ${activeTask.id} and cannot be unarchived`), { code: "ARCHIVE_ACTIVE_AGENT" });
    }
    if (options.validateOnly) return agent;
    const timestamp = now();
    this.db.prepare("UPDATE agents SET archived_at = NULL, updated_at = ? WHERE id = ? AND archived_at IS NOT NULL").run(timestamp, agentId);
    this.recordEvent("agent", agentId, "agent.unarchived", {});
    return this.getAgent(agentId);
  }

  acquireAgentLease(agentId, ownerTaskId, ownerToken, ttlMs = 120_000, metadata = {}) {
    if (!agentId || !ownerTaskId || !ownerToken) throw new TypeError("Agent lease requires agentId, ownerTaskId, and ownerToken");
    const acquiredAt = now();
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
        json(task.metadata ?? {}, {}),
      );
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

  updateTask(taskId, changes = {}) {
    const existing = this.getTask(taskId);
    if (!existing) throw new Error(`Task not found: ${taskId}`);
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
    if (options.runId) {
      clauses.push("json_extract(metadata_json, '$.runId') = ?");
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
            metadata_json = json_set(metadata_json, '$.dashboardReadyAt', ?, '$.dashboardReadySource', ?)
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
        dashboardReady: true,
      });
    }
    this.recordEvent("system", runId, "run.dashboard_ready", {
      source: details.source ?? "manual",
      releasedTasks: released.length,
    });
    if (this.getRun(runId)) this.updateRun(runId, { status: "running", startedAt: timestamp });
    return { runId, status: "ready", releasedTasks: released.length, tasks: this.listTasks({ runId, limit: 100 }) };
  }

  createRun(run) {
    if (!run?.id) throw new TypeError("Run id is required");
    const timestamp = run.createdAt ?? now();
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
    this.recordEvent("run", run.id, `run.${run.status ?? "draft"}`, { name: run.name ?? null, cwd: run.cwd ?? null });
    return this.getRun(run.id);
  }

  createTaskGraph(run, tasks) {
    if (!run?.id) throw new TypeError("Run id is required");
    validateTaskGraph(tasks);
    const timestamp = run.createdAt ?? now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existingRow = this.db.prepare("SELECT * FROM runs WHERE id = ? OR (? IS NOT NULL AND request_key = ?)").get(run.id, run.requestKey ?? null, run.requestKey ?? null);
      const existingTasks = existingRow
        ? this.db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE json_extract(metadata_json, '$.runId') = ?").get(existingRow.id).count
        : 0;
      if (existingRow && (existingRow.id !== run.id || existingTasks > 0)) {
        this.db.exec("COMMIT");
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
          run.status ?? "awaiting_user_start",
          run.cwd ?? existing.cwd,
          timestamp,
          run.startedAt ?? existing.startedAt,
          run.completedAt ?? existing.completedAt,
          json({ ...existing.metadata, ...(run.metadata ?? {}) }, {}),
          run.id,
        );
      } else {
        this.db.prepare(`
          INSERT INTO runs (id, request_key, plan_id, name, status, cwd, created_at, updated_at, started_at, completed_at, metadata_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          run.id, run.requestKey ?? null, run.planId ?? null, run.name ?? null,
          run.status ?? "awaiting_user_start", run.cwd ?? null, timestamp, timestamp,
          run.startedAt ?? null, run.completedAt ?? null, json(run.metadata ?? {}, {}),
        );
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
      for (const task of tasks) {
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
      }
      for (const task of tasks) {
        for (const dependencyId of new Set(task.dependsOn ?? [])) insertDependency.run(task.id, dependencyId, timestamp);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    this.recordEvent("run", run.id, `run.${run.status ?? "awaiting_user_start"}`, { tasks: tasks.length, atomic: true, materialized: true });
    for (const task of tasks) this.recordEvent("task", task.id, "task.created", { status: task.status ?? "staged", dependencies: task.dependsOn ?? [], runId: run.id });
    return { run: this.getRun(run.id), tasks: this.listTasks({ runId: run.id, limit: 1000 }), idempotent: false };
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
    const scope = options.scope ?? "active";
    if (scope === "active") clauses.push("archived_at IS NULL");
    else if (scope === "archived") clauses.push("archived_at IS NOT NULL");
    else if (scope !== "all") throw new TypeError(`Unsupported run scope: ${scope}`);
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    values.push(options.limit ?? 50);
    return this.db.prepare(`SELECT * FROM runs ${where} ORDER BY created_at DESC LIMIT ?`).all(...values).map(normalizeRun);
  }

  updateRun(runId, changes = {}) {
    const existing = this.getRun(runId);
    if (!existing) throw new Error(`Run not found: ${runId}`);
    const status = changes.status ?? existing.status;
    const timestamp = now();
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
      json({ ...existing.metadata, ...(changes.metadata ?? {}) }, {}),
      runId,
    );
    if (status !== existing.status) this.recordEvent("run", runId, `run.${status}`, { previousStatus: existing.status });
    return this.getRun(runId);
  }

  refreshRun(runId) {
    const run = this.getRun(runId);
    if (!run) return null;
    if (["completed", "failed", "cancelled"].includes(run.status)) return run;
    const tasks = this.listTasks({ runId, limit: 1000 });
    if (!tasks.length) return run;
    const terminal = tasks.every((task) => ["completed", "completed_with_warnings", "rejected", "validation_failed", "failed", "canceled", "interrupted"].includes(task.status));
    if (!terminal) return run;
    const status = tasks.some((task) => ["rejected", "validation_failed", "failed", "interrupted"].includes(task.status))
      ? "failed"
      : tasks.every((task) => task.status === "canceled") ? "cancelled" : "completed";
    if (run.status === status) return run;
    const updated = this.updateRun(runId, { status, completedAt: now() });
    this.projectRunResult(runId);
    this.createNotification({
      projectKey: run.cwd ?? "workspace", runId, kind: status === "completed" ? "run_completed" : "run_failed",
      severity: status === "completed" ? "info" : "error",
      title: status === "completed" ? "실행 완료" : "실행 실패",
      body: status === "completed" ? `${run.name ?? runId} 작업이 완료되었습니다.` : `${run.name ?? runId} 작업 결과를 확인하세요.`,
      dedupeKey: `${runId}:${status}`,
    });
    return updated;
  }

  cancelRun(runId) {
    const run = this.getRun(runId);
    if (!run) throw new Error(`Run not found: ${runId}`);
    const tasks = this.listTasks({ runId, limit: 1000 });
    for (const task of tasks) this.cancelTask(task.id);
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
    return this.getMemory(id);
  }

  getMemory(memoryId) {
    return normalizeMemory(this.db.prepare("SELECT * FROM project_memories WHERE id = ?").get(memoryId));
  }

  listMemories(options = {}) {
    const clauses = [];
    const values = [];
    if (options.cwd) addCwdScope(clauses, values, "cwd", options.cwd);
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
      kind: "approval_required", severity: "warning", title: "승인 필요",
      body: `${task?.metadata?.title ?? task?.prompt ?? "에이전트 작업"}에서 승인을 요청했습니다.`,
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
    const timestamp = now();
    const id = notification.id ?? `notification_${randomUUID()}`;
    this.db.prepare(`
      INSERT OR IGNORE INTO notifications (
        id, project_key, run_id, task_id, kind, severity, title, body, dedupe_key, created_at, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, notification.projectKey ?? "workspace", notification.runId ?? null, notification.taskId ?? null,
      notification.kind, notification.severity ?? "info", notification.title ?? notification.kind,
      notification.body ?? "", notification.dedupeKey, timestamp, json(notification.metadata ?? {}, {}));
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
    const taskResults = tasks.map((task) => ({ id: task.id, title: task.metadata?.title ?? task.prompt.slice(0, 80), status: task.status, output: task.output, error: task.error, failure: task.metadata?.failure ?? null }));
    const validations = tasks.filter((task) => task.metadata?.validation).map((task) => ({ taskId: task.id, ...task.metadata.validation }));
    const failures = tasks.filter((task) => !["completed", "completed_with_warnings"].includes(task.status));
    const warnings = tasks.filter((task) => task.status === "completed_with_warnings");
    const summary = run.status === "completed"
      ? warnings.length ? `${tasks.length}개 작업이 완료되었고 ${warnings.length}개에 경고가 있습니다.` : `${tasks.length}개 작업이 완료되었습니다.`
      : `${tasks.length}개 중 ${failures.length}개 작업에 확인이 필요합니다.`;
    const timestamp = now();
    this.db.prepare(`
      INSERT INTO run_results (run_id, status, summary, task_results_json, validation_json, artifacts_json,
        unresolved_risks_json, synthesis_status, synthesis_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, '[]', ?, 'not_applicable', NULL, ?, ?)
      ON CONFLICT(run_id) DO UPDATE SET status = excluded.status, summary = excluded.summary,
        task_results_json = excluded.task_results_json, validation_json = excluded.validation_json,
        unresolved_risks_json = excluded.unresolved_risks_json, updated_at = excluded.updated_at
    `).run(runId, run.status, summary, json(taskResults, []), json(validations, []), json(failures.map((task) => task.error ?? `${task.id}: ${task.status}`), []), timestamp, timestamp);
    return this.getRunResult(runId);
  }

  getRunResult(runId) {
    return normalizeRunResult(this.db.prepare("SELECT * FROM run_results WHERE run_id = ?").get(runId));
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
      attention: notifications.filter((item) => ["approval_required", "run_failed", "recovery_attention"].includes(item.kind)).length,
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
    const blocked = this.db.prepare("SELECT id FROM tasks WHERE status = 'blocked'").all();
    let queued = 0;
    let failed = 0;
    for (const row of blocked) {
      const dependencies = this.listTaskDependencies(row.id);
      const failedDependency = dependencies.find((entry) => ["rejected", "failed"].includes(entry.status));
      if (failedDependency) {
        this.updateTask(row.id, {
          status: "failed",
          error: `Dependency ${failedDependency.taskId} ended with ${failedDependency.status}`,
          completedAt: now(),
        });
        failed += 1;
      } else if (dependencies.every((entry) => ["completed", "completed_with_warnings"].includes(entry.status))) {
        this.updateTask(row.id, { status: "queued", error: null });
        queued += 1;
      }
    }
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
          WHERE d.task_id = t.id AND dependency.status NOT IN ('completed', 'completed_with_warnings')
        )
      ORDER BY t.created_at
      LIMIT ?
    `).all(timestamp, options.limit ?? 20).map(normalizeTask);
  }

  claimTask(taskId, workerId) {
    const timestamp = now();
    const claimToken = randomUUID();
    const row = this.db.prepare(`
      UPDATE tasks
      SET status = 'running', worker_id = ?, heartbeat_at = ?, updated_at = ?,
          started_at = COALESCE(started_at, ?), attempt = attempt + 1,
          next_retry_at = NULL, error = NULL, claim_token = ?, version = version + 1
      WHERE id = ?
        AND status IN ('queued', 'retry_waiting', 'waiting_for_lease')
        AND (next_retry_at IS NULL OR next_retry_at <= ?)
        AND NOT EXISTS (
          SELECT 1 FROM task_dependencies d
          JOIN tasks dependency ON dependency.id = d.depends_on_task_id
          WHERE d.task_id = tasks.id AND dependency.status NOT IN ('completed', 'completed_with_warnings')
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
        AND status IN ('running', 'approval_waiting')
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
        AND status IN ('running', 'approval_waiting', 'agent_done', 'validating')
    `).run(timestamp, timestamp, taskId, workerId, claimToken);
    return Number(result.changes) === 1;
  }

  isClaimOwner(taskId, workerId, claimToken) {
    return Boolean(this.db.prepare(`
      SELECT 1 FROM tasks
      WHERE id = ? AND worker_id = ? AND claim_token = ?
        AND status IN ('running', 'approval_waiting', 'agent_done', 'validating')
    `).get(taskId, workerId, claimToken));
  }

  completeClaim(taskId, workerId, claimToken, changes = {}) {
    const timestamp = now();
    const row = this.db.prepare(`
      UPDATE tasks
      SET status = 'completed', output = ?, turn_id = COALESCE(?, turn_id),
          completed_at = ?, updated_at = ?, heartbeat_at = ?, version = version + 1
      WHERE id = ? AND worker_id = ? AND claim_token = ?
        AND status IN ('running', 'approval_waiting')
      RETURNING *
    `).get(changes.output ?? null, changes.turnId ?? null, timestamp, timestamp, timestamp, taskId, workerId, claimToken);
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

  finishValidationClaim(taskId, workerId, claimToken, validation) {
    const accepted = validation?.decision === "accept";
    const warned = validation?.decision === "accept_with_warnings";
    if (!accepted && !warned) {
      const summary = validation?.summary ?? "Acceptance criteria were not satisfied";
      const infrastructureFailure = validation?.decision === "error"
        ? { type: "infrastructure", stage: "validation", cause: summary, message: summary, retryable: true, nextAction: "retry", at: now() }
        : { type: "validation", stage: "validation", cause: summary, message: summary, retryable: true, nextAction: "rework", at: now() };
      return this.finishFailureClaim(taskId, workerId, claimToken, infrastructureFailure, {
        terminalStatus: infrastructureFailure.type === "validation" ? "rejected" : "validation_failed",
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
      UPDATE tasks SET status = ?, error = ?, completed_at = ?, heartbeat_at = ?,
        updated_at = ?, version = version + 1,
        metadata_json = ?
      WHERE id = ? AND worker_id = ? AND claim_token = ? AND status = 'validating'
      RETURNING *
    `).get(
      status,
      accepted ? null : (validation?.summary ?? "Acceptance criteria were not satisfied"),
      timestamp,
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
          completed_at = ?, updated_at = ?, heartbeat_at = ?, version = version + 1
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
        AND status IN ('running', 'approval_waiting', 'agent_done', 'validating')
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
    const retry = Boolean(failure.retryable) && remaining > 0 && !duplicateFeedback;
    const delay = task.retryDelayMs * (2 ** Math.max(task.attempt - 1, 0));
    const timestamp = now();
    const nextRetryAt = retry ? new Date(Date.now() + delay).toISOString() : null;
    const requestedAction = failure.nextAction ?? (["infrastructure", "coordination", "timeout"].includes(failure.type) ? "retry" : "rework");
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
      at: failure.at ?? timestamp,
    };
    const history = [...(metadata.failureHistory ?? []), record];
    const nextMetadata = { ...metadata, failure: record, failureHistory: history };
    delete nextMetadata.validationInProgress;
    if (feedback) {
      nextMetadata.rework = {
        ...(metadata.rework ?? {}),
        feedbackHashes,
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
    if (task.attempt >= task.maxAttempts) {
      return this.updateTask(taskId, {
        status: "failed",
        error: String(error),
        completedAt: now(),
        workerId: null,
        heartbeatAt: null,
      });
    }
    const delay = task.retryDelayMs * (2 ** Math.max(task.attempt - 1, 0));
    return this.updateTask(taskId, {
      status: "retry_waiting",
      error: String(error),
      nextRetryAt: new Date(Date.now() + delay).toISOString(),
      workerId: null,
      heartbeatAt: null,
    });
  }

  cancelTask(taskId) {
    const task = this.getTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    if (["completed", "completed_with_warnings", "rejected", "validation_failed", "failed", "canceled", "interrupted"].includes(task.status)) return task;
    return this.updateTask(taskId, { status: "canceled", completedAt: now() });
  }

  acquireLease(lease) {
    if (!lease?.key || !lease?.ownerTaskId) throw new TypeError("Lease key and ownerTaskId are required");
    const acquiredAt = now();
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
    const releasedAt = now();
    const row = this.db.prepare(`
      UPDATE worktree_leases
      SET status = ?, released_at = ?, heartbeat_at = ?
      WHERE lease_key = ? AND owner_task_id = ? AND status IN ('active', 'expired')
        AND (? IS NULL OR owner_token = ?)
      RETURNING *
    `).get(options.status ?? "released", releasedAt, releasedAt, key, ownerTaskId, options.ownerToken ?? null, options.ownerToken ?? null);
    if (row) this.recordEvent("task", ownerTaskId, "lease.released", { key, status: options.status ?? "released" });
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
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;

      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        name TEXT,
        cwd TEXT,
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
        status TEXT NOT NULL,
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
    this.#ensureColumn("worktree_leases", "owner_token", "TEXT");
    this.#ensureColumn("runs", "request_key", "TEXT");
    this.#ensureColumn("runs", "plan_id", "TEXT");
    this.#ensureColumn("role_templates", "skills_json", "TEXT NOT NULL DEFAULT '[]'");
    this.#ensureColumn("role_templates", "effort", "TEXT");
    this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS runs_request_key_idx ON runs(request_key) WHERE request_key IS NOT NULL");
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

export { DEFAULT_DB_PATH, LEGACY_DB_PATH };
