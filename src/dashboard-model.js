const ACTIVE_RUN_STATUSES = new Set(["accepted", "planning", "preparing", "awaiting_user_start", "running"]);
const TERMINAL_RUN_STATUSES = new Set(["completed", "failed", "cancelled"]);
const ARCHIVABLE_AGENT_STATUSES = new Set(["idle", "available"]);

function agentSummary(agent, registry) {
  const lease = registry.getAgentLease?.(agent.id);
  const leased = Boolean(lease && ["active", "leased"].includes(lease.status)
    && (!lease.expiresAt || new Date(lease.expiresAt).valueOf() > Date.now()));
  return {
    id: agent.id, name: agent.name, status: agent.status, role: agent.role,
    cwd: agent.cwd, capabilities: agent.capabilities,
    tools: agent.metadata?.tools ?? [], currentTaskId: agent.metadata?.currentTaskId ?? null,
    archivedAt: agent.archivedAt, archiveAllowed: !agent.archivedAt && ARCHIVABLE_AGENT_STATUSES.has(agent.status) && !agent.metadata?.currentTaskId && !leased,
    unarchiveAllowed: Boolean(agent.archivedAt) && !leased, updatedAt: agent.updatedAt,
  };
}

function failureSummary(failure) {
  if (!failure) return null;
  return {
    type: failure.type ?? null, cause: failure.cause ?? failure.message ?? null,
    retryable: Boolean(failure.retryable), nextAction: failure.nextAction ?? failure.requestedAction ?? null,
    attemptBudget: failure.attemptBudget ?? null, exhausted: Boolean(failure.exhausted),
  };
}

function routingSummary(routing) {
  if (!routing) return null;
  return {
    decision: routing.decision ?? routing.mode ?? null,
    reasons: routing.reasons ?? [], blockers: routing.blockers ?? [],
    requirementMatrix: routing.selectedRequirementMatrix ?? routing.assignmentRequirementMatrix ?? routing.requirementMatrix ?? null,
    provenance: routing.provenance ?? null,
    schedulerIdentity: routing.schedulerIdentity ?? null,
    orchestratorSessionIdentity: routing.orchestratorSessionIdentity ?? null,
  };
}

function taskSummary(task) {
  return {
    id: task.id, runId: task.metadata?.runId ?? null,
    title: task.metadata?.title ?? task.prompt.slice(0, 80), status: task.status,
    agentId: task.agentId, role: task.role, attempt: task.attempt,
    maxAttempts: task.maxAttempts, createdAt: task.createdAt, updatedAt: task.updatedAt,
    failure: failureSummary(task.metadata?.failure), routing: routingSummary(task.metadata?.execution?.preparedRouting ?? task.routing),
  };
}

function runSummary(run) {
  return {
    id: run.id, name: run.name, status: run.status, cwd: run.cwd,
    createdAt: run.createdAt, updatedAt: run.updatedAt, startedAt: run.startedAt,
    completedAt: run.completedAt,
    archivedAt: run.archivedAt,
    archiveAllowed: !run.archivedAt && TERMINAL_RUN_STATUSES.has(run.status),
    unarchiveAllowed: Boolean(run.archivedAt) && TERMINAL_RUN_STATUSES.has(run.status),
    dispatchPath: run.metadata?.dispatchPath ?? null,
    schedulerIdentity: run.metadata?.schedulerIdentity ?? null,
    orchestratorSessionIdentity: run.metadata?.orchestratorSessionIdentity ?? null,
  };
}

function planSummary(plan) {
  return {
    id: plan.id, objective: plan.objective, status: plan.status, version: plan.version,
    cwd: plan.cwd, summary: plan.plan?.summary ?? null, updatedAt: plan.updatedAt,
  };
}

function approvalSummary(approval) {
  return {
    id: approval.id, taskId: approval.taskId, threadId: approval.threadId,
    method: approval.method, status: approval.status, decision: approval.decision,
    createdAt: approval.createdAt,
  };
}

function worktreeSummary(worktree) {
  return {
    id: worktree.id, path: worktree.path, branch: worktree.branch,
    status: worktree.status, ownerTaskId: worktree.ownerTaskId, updatedAt: worktree.updatedAt,
  };
}

function memorySummary(memory) {
  return {
    id: memory.id, cwd: memory.cwd, kind: memory.kind, title: memory.title,
    source: memory.source, authority: memory.authority, subject: memory.subject,
    semanticVersion: memory.semanticVersion, supersedes: memory.supersedes,
    tags: memory.tags, updatedAt: memory.updatedAt,
  };
}

export function dashboardRevision(registry) {
  return registry.listEvents({ limit: 1 })[0]?.id ?? 0;
}

export function buildDashboardSnapshot(registry, options = {}) {
  const cwd = options.cwd || undefined;
  const scope = ["active", "archived", "all"].includes(options.scope) ? options.scope : "active";
  const runs = registry.listRuns({ cwd, scope, limit: options.limit ?? 50 });
  const requestedRun = options.runId ? runs.find((candidate) => candidate.id === options.runId) : null;
  const runId = requestedRun?.id
    ?? runs.find((run) => ACTIVE_RUN_STATUSES.has(run.status))?.id
    ?? runs[0]?.id
    ?? null;
  const run = runId ? registry.getRun(runId) : null;
  const tasks = options.tasksForSelectedRun === false
    ? registry.listTasks({ cwd, limit: 100 })
    : runId ? registry.listTasks({ cwd, runId, limit: 100 }) : [];
  return {
    kind: "snapshot",
    revision: dashboardRevision(registry),
    generatedAt: new Date().toISOString(),
    cwd: cwd ?? null,
    scope,
    runId,
    status: run?.status ?? null,
    run: run ? runSummary(run) : null,
    graph: runId && options.getGraph ? options.getGraph(runId, { detail: false }) : null,
    runs: runs.map(runSummary),
    agents: registry.listAgents({ cwd, scope, limit: 100 }).map((agent) => agentSummary(agent, registry)),
    tasks: tasks.map(taskSummary),
    plans: (registry.listPlans?.({ cwd, limit: 100 }) ?? []).map(planSummary),
    approvals: (registry.listApprovals?.({ limit: 100 }) ?? []).map(approvalSummary),
    worktrees: (registry.listManagedWorktrees?.({ limit: 100 }) ?? []).map(worktreeSummary),
    roles: (registry.listRoleTemplates?.({ limit: 100 }) ?? []).map(({ developerInstructions: _instructions, metadata: _metadata, ...role }) => role),
    memories: (registry.listMemories?.({ cwd, limit: 100 }) ?? []).map(memorySummary),
    events: registry.listEvents({ limit: 50 }),
  };
}

export function buildDashboardDelta(registry, options = {}) {
  const sinceRevision = Math.max(0, Number(options.sinceRevision) || 0);
  const revision = dashboardRevision(registry);
  if (sinceRevision >= revision) {
    return { kind: "delta", baseRevision: sinceRevision, revision, changed: false, events: [], generatedAt: new Date().toISOString() };
  }
  const events = registry.listEvents({ afterId: sinceRevision, limit: options.eventLimit ?? 500 });
  // A bounded snapshot is the safe reset representation when the caller is too far
  // behind. It is still made only of lightweight dashboard DTOs.
  if (events.length >= (options.eventLimit ?? 500)) {
    return { ...buildDashboardSnapshot(registry, options), kind: "reset", baseRevision: sinceRevision };
  }
  const snapshot = buildDashboardSnapshot(registry, options);
  const changedTypes = new Set(events.map((event) => event.entityType));
  if (events.some((event) => event.eventType === "agent.project_reconciled")) changedTypes.add("agent");
  const changed = {
    ...(changedTypes.has("agent") ? { agents: snapshot.agents } : {}),
    ...(changedTypes.has("task") ? { tasks: snapshot.tasks } : {}),
    ...(changedTypes.has("run") ? { runs: snapshot.runs, run: snapshot.run } : {}),
    ...(changedTypes.has("plan") ? { plans: snapshot.plans } : {}),
    ...(changedTypes.has("approval") ? { approvals: snapshot.approvals } : {}),
    ...(changedTypes.has("worktree") ? { worktrees: snapshot.worktrees } : {}),
    ...(changedTypes.has("role") ? { roles: snapshot.roles } : {}),
    ...(changedTypes.has("memory") ? { memories: snapshot.memories } : {}),
    ...(["task", "run", "approval", "worktree"].some((type) => changedTypes.has(type)) ? { graph: snapshot.graph } : {}),
  };
  return {
    kind: "delta",
    baseRevision: sinceRevision,
    revision,
    changed: true,
    generatedAt: snapshot.generatedAt,
    cwd: snapshot.cwd,
    scope: snapshot.scope,
    runId: snapshot.runId,
    status: snapshot.status,
    ...changed,
    events,
  };
}

export function getDashboardDetail(registry, entityType, entityId, options = {}) {
  switch (entityType) {
    case "agent": return registry.getAgent(entityId);
    case "task": return registry.getTask(entityId);
    case "run": return registry.getRun(entityId);
    case "graph": return options.getGraph?.(entityId, { detail: true }) ?? null;
    case "plan": {
      const plan = registry.getPlan(entityId);
      return plan ? { ...plan, revisions: registry.listPlanRevisions(entityId) } : null;
    }
    case "approval": return registry.listApprovals({ limit: 1000 }).find((item) => item.id === entityId) ?? null;
    case "worktree": return registry.getManagedWorktree(entityId);
    case "memory": return registry.getMemory(entityId);
    default: throw new Error(`Unsupported dashboard entity type: ${entityType}`);
  }
}
