import { ACTIVE_RUN_STATUSES, ACTIVE_TASK_STATUSES, SUCCESSFUL_TASK_STATUSES, TERMINAL_RUN_STATUSES, TERMINAL_TASK_STATUSES } from "./domain-states.js";

const ARCHIVABLE_AGENT_STATUSES = new Set(["idle", "available"]);

function agentSummary(agent, registry) {
  const lease = registry.getAgentLease?.(agent.id);
  const lifecycle = registry.getThreadLifecycle?.(agent.id) ?? null;
  const leased = Boolean(lease && ["active", "leased"].includes(lease.status)
    && (!lease.expiresAt || new Date(lease.expiresAt).valueOf() > Date.now()));
  return {
    id: agent.id, name: agent.name, status: agent.status, role: agent.role,
    cwd: agent.cwd, capabilities: agent.capabilities,
    tools: agent.metadata?.tools ?? [], currentTaskId: agent.metadata?.currentTaskId ?? null,
    archivedAt: agent.archivedAt, archiveAllowed: !agent.archivedAt && ARCHIVABLE_AGENT_STATUSES.has(agent.status) && !agent.metadata?.currentTaskId && !leased,
    unarchiveAllowed: Boolean(agent.archivedAt) && !leased, updatedAt: agent.updatedAt,
    lifecycle: lifecycle ? {
      status: lifecycle.status, threadType: lifecycle.threadType, contextHealth: lifecycle.contextHealth,
      snapshotId: lifecycle.snapshotId, successorThreadId: lifecycle.successorThreadId,
    } : null,
  };
}

function failureSummary(failure) {
  if (!failure) return null;
  return {
    type: failure.type ?? null, category: failure.category ?? null, cause: failure.cause ?? failure.message ?? null,
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

function contextSnapshotSummary(registry, snapshotId, expectedFingerprint = null) {
  if (!snapshotId) return null;
  const snapshot = registry.getContextSnapshot?.(snapshotId);
  if (!snapshot) return { id: snapshotId, status: "missing", revision: null, fingerprint: expectedFingerprint, selectedCount: 0, excludedCount: 0, conflictCount: 0, blockingConflictCount: 0 };
  const fingerprintMatches = !expectedFingerprint || expectedFingerprint === snapshot.fingerprint;
  return {
    id: snapshot.id,
    status: fingerprintMatches ? snapshot.status : "fingerprint_mismatch",
    revision: snapshot.revision,
    fingerprint: snapshot.fingerprint,
    selectedCount: snapshot.claims.filter((item) => item.disposition === "selected").length,
    excludedCount: snapshot.claims.filter((item) => item.disposition === "excluded").length,
    conflictCount: snapshot.conflicts.length,
    blockingConflictCount: snapshot.conflicts.filter((item) => item.blocking && item.status === "unresolved").length,
  };
}

function taskSummary(task, taskById, agentById = new Map(), registry = null) {
  const dependsOn = (task.dependencies ?? []).map((dependency) => typeof dependency === "string" ? dependency : dependency?.id ?? dependency?.taskId).filter(Boolean);
  const blockedBy = dependsOn.filter((dependencyId) => !SUCCESSFUL_TASK_STATUSES.has(taskById.get(dependencyId)?.status));
  const validation = task.metadata?.validationInProgress ?? null;
  const agent = task.agentId ? agentById.get(task.agentId) : null;
  return {
    id: task.id, runId: task.metadata?.runId ?? null,
    title: task.metadata?.title ?? task.prompt.slice(0, 80), status: task.status,
    agentId: task.agentId, role: task.role, attempt: task.attempt,
    maxAttempts: task.maxAttempts, createdAt: task.createdAt, updatedAt: task.updatedAt,
    dependsOn, blockedBy,
    runnable: task.status === "queued" && blockedBy.length === 0,
    currentWork: ACTIVE_TASK_STATUSES.has(task.status) ? {
      phase: task.status,
      agentId: validation?.agentId ?? task.agentId ?? null,
      turnId: validation?.turnId ?? task.turnId ?? null,
      workerId: task.workerId ?? null,
      startedAt: task.startedAt ?? null,
      heartbeatAt: task.heartbeatAt ?? null,
    } : null,
    resultSession: task.agentId ? {
      threadId: task.agentId,
      turnId: task.turnId ?? null,
      name: agent?.name ?? null,
      role: agent?.role ?? task.role ?? null,
      available: TERMINAL_TASK_STATUSES.has(task.status),
    } : null,
    failure: failureSummary(task.metadata?.failure), routing: routingSummary(task.metadata?.execution?.preparedRouting ?? task.routing),
    contextSnapshot: registry ? contextSnapshotSummary(registry, task.metadata?.contextSnapshotId, task.metadata?.contextSnapshotFingerprint) : null,
    executionContract: task.metadata?.executionContract ? {
      status: task.metadata.contractStatus ?? "missing",
      validatedAt: task.metadata.contractValidatedAt ?? null,
      revision: task.metadata.contractRevision ?? null,
      taskKind: task.metadata.executionContract.taskKind,
      sandbox: task.metadata.executionContract.sandbox,
      networkAccess: task.metadata.executionContract.networkAccess,
      workspaceMode: task.metadata.executionContract.workspaceMode,
      integrationStrategy: task.metadata.executionContract.integrationStrategy,
      fingerprint: task.metadata.executionContract.fingerprint,
    } : null,
    integration: task.metadata?.integration ?? null,
    completionVerdict: task.metadata?.completionVerdict ?? null,
    postconditionEvidence: task.metadata?.postconditionEvidence ?? null,
  };
}

function globalRunSummary(graph) {
  if (!graph) return null;
  return {
    id: graph.globalRun.id, objective: graph.globalRun.objective, status: graph.globalRun.status,
    currentRevision: graph.globalRun.currentRevision,
    cancellationRequestedAt: graph.globalRun.cancellationRequestedAt,
    projectCount: graph.memberships.length,
    requiredCount: graph.memberships.filter((membership) => membership.membership === "required").length,
    optionalCount: graph.memberships.filter((membership) => membership.membership === "optional").length,
    dependencyCount: graph.dependencies.length,
    authorizationManifestCount: graph.authorizationManifests?.length ?? 0,
    handoffCount: graph.handoffs?.length ?? 0,
    pendingHandoffCount: graph.dependencies.filter((dependency) => dependency.status === "satisfied"
      && !graph.handoffs?.some((handoff) => handoff.dependencyId === dependency.id && handoff.status === "received")).length,
    invalidHandoffCount: graph.handoffs?.filter((handoff) => handoff.status === "invalid").length ?? 0,
    warningCount: graph.result?.warnings?.length ?? graph.globalRun.metadata?.warningCount ?? 0,
    createdAt: graph.globalRun.createdAt, updatedAt: graph.globalRun.updatedAt,
  };
}

function runSummary(run, taskByRunId = new Map(), agentById = new Map(), result = null, registry = null, parentGlobalRun = null) {
  const orchestratorId = run.metadata?.orchestratorSessionIdentity?.agentId ?? run.metadata?.orchestratorAgentId ?? null;
  const orchestrator = orchestratorId ? agentById.get(orchestratorId) : null;
  const dataAgentIds = [...new Set((taskByRunId.get(run.id) ?? []).map((task) => task.agentId).filter(Boolean))];
  return {
    id: run.id, name: run.name, status: run.status, cwd: run.cwd,
    createdAt: run.createdAt, updatedAt: run.updatedAt, startedAt: run.startedAt,
    completedAt: run.completedAt,
    archivedAt: run.archivedAt,
    archiveAllowed: !run.archivedAt && TERMINAL_RUN_STATUSES.has(run.status),
    unarchiveAllowed: Boolean(run.archivedAt) && TERMINAL_RUN_STATUSES.has(run.status),
    dispatchPath: run.metadata?.dispatchPath ?? null,
    dispatchPhase: run.metadata?.dispatchPhase ?? null,
    failure: run.metadata?.dispatchError ? {
      type: "configuration",
      category: "configuration",
      stage: run.metadata?.dispatchPhase ?? "dispatch",
      cause: run.metadata.dispatchError,
      nextAction: "repair_contract",
      retryable: false,
    } : null,
    workspacePreflight: run.metadata?.workspacePreflight ?? null,
    contextSnapshot: registry ? contextSnapshotSummary(
      registry,
      run.metadata?.contextSnapshotId ?? run.metadata?.failure?.contextSnapshotId,
      run.metadata?.contextSnapshotFingerprint,
    ) : null,
    globalRun: globalRunSummary(parentGlobalRun),
    schedulerIdentity: run.metadata?.schedulerIdentity ?? null,
    orchestratorSessionIdentity: run.metadata?.orchestratorSessionIdentity ?? null,
    resultAccess: {
      mode: run.metadata?.resultAccess ?? run.metadata?.controlRequest?.resultAccess ?? "dashboard_thread_navigation",
      automaticOriginAppend: false,
    },
    executionParticipants: {
      orchestrator: orchestratorId ? { id: orchestratorId, name: orchestrator?.name ?? null, role: orchestrator?.role ?? "orchestrator", status: orchestrator?.status ?? "unknown" } : null,
      dataAgents: dataAgentIds.map((id) => {
        const agent = agentById.get(id);
        return { id, name: agent?.name ?? null, role: agent?.role ?? "agent", status: agent?.status ?? "unknown" };
      }),
    },
    result: result ? {
      status: result.status,
      summary: result.synthesis?.text ?? result.summary ?? null,
      synthesisStatus: result.synthesisStatus,
      artifacts: result.artifacts ?? [],
      unresolvedRisks: result.unresolvedRisks ?? [],
      validationCount: result.validation?.length ?? 0,
    } : null,
  };
}

function planSummary(plan) {
  return {
    id: plan.id, objective: plan.objective, status: plan.status, version: plan.version,
    cwd: plan.cwd, summary: plan.plan?.summary ?? null, updatedAt: plan.updatedAt,
  };
}

function worktreeSummary(worktree) {
  return {
    id: worktree.id, path: worktree.path, branch: worktree.branch,
    status: worktree.status, ownerTaskId: worktree.ownerTaskId, updatedAt: worktree.updatedAt,
    baseline: worktree.metadata?.baseline ?? null,
    artifact: worktree.metadata?.artifact ?? null,
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

function notificationSummary(notification) {
  return {
    id: notification.id, runId: notification.runId, taskId: notification.taskId,
    kind: notification.kind, severity: notification.severity,
    title: notification.title, body: notification.body,
    createdAt: notification.createdAt, readAt: notification.readAt,
    unread: notification.unread,
  };
}

function turnDispatchSummary(dispatch) {
  return {
    id: dispatch.id, subjectType: dispatch.subjectType, subjectId: dispatch.subjectId,
    purpose: dispatch.purpose, revision: dispatch.revision, status: dispatch.status,
    parentRunId: dispatch.parentRunId, parentTaskId: dispatch.parentTaskId,
    threadId: dispatch.threadId, turnId: dispatch.turnId, threadAction: dispatch.threadAction,
    promptFingerprint: dispatch.promptFingerprint,
    executionContractFingerprint: dispatch.executionContractFingerprint,
    ownerInstanceId: dispatch.ownerInstanceId, heartbeatAt: dispatch.heartbeatAt,
    deadlineAt: dispatch.deadlineAt, cancellationGeneration: dispatch.cancellationGeneration,
    reconciliationDecision: dispatch.reconciliationDecision,
    failure: failureSummary(dispatch.failure), createdAt: dispatch.createdAt, updatedAt: dispatch.updatedAt,
  };
}

const THREAD_PURPOSE_LABELS = {
  planning: "Planner",
  orchestration: "Orchestrator",
  execution: "Data Plane",
  validation: "Validator",
  synthesis: "Synthesizer",
};
const THREAD_PURPOSE_ORDER = ["planning", "orchestration", "execution", "validation", "synthesis"];
const ACTIVE_THREAD_STATES = new Set([
  "prepared", "thread_acquiring", "thread_created", "turn_submitting", "turn_running", "cancelling",
  "running", "validating", "agent_done", "integration_pending", "approval_waiting", "leased",
]);

function runThreadSummaries(dispatches, run, tasks, agentById) {
  const byThread = new Map();
  const add = ({ threadId, purpose, status, turnId = null, taskId = null, updatedAt = null }) => {
    if (!threadId) return;
    const agent = agentById.get(threadId);
    const current = byThread.get(threadId) ?? {
      id: threadId, threadId, name: agent?.name ?? null, role: agent?.role ?? null,
      purposes: [], taskIds: [], status: "idle", turnId: null, active: false,
      managedByDaemon: true, updatedAt: null,
    };
    if (purpose && !current.purposes.includes(purpose)) current.purposes.push(purpose);
    if (taskId && !current.taskIds.includes(taskId)) current.taskIds.push(taskId);
    const active = ACTIVE_THREAD_STATES.has(status);
    if (active || !current.active) {
      current.status = status ?? current.status;
      current.turnId = turnId ?? current.turnId;
    }
    current.active ||= active;
    if (!current.updatedAt || String(updatedAt ?? "").localeCompare(current.updatedAt) > 0) current.updatedAt = updatedAt;
    byThread.set(threadId, current);
  };
  for (const dispatch of dispatches) add({
    threadId: dispatch.threadId, purpose: dispatch.purpose, status: dispatch.status,
    turnId: dispatch.turnId, taskId: dispatch.parentTaskId, updatedAt: dispatch.updatedAt,
  });
  const orchestratorId = run?.metadata?.orchestratorSessionIdentity?.agentId ?? run?.metadata?.orchestratorAgentId;
  add({ threadId: orchestratorId, purpose: "orchestration", status: agentById.get(orchestratorId)?.status ?? "idle", updatedAt: run?.updatedAt });
  for (const task of tasks) add({
    threadId: task.agentId, purpose: "execution", status: task.status,
    turnId: task.turnId, taskId: task.id, updatedAt: task.updatedAt,
  });
  return [...byThread.values()].map((entry) => {
    const purposes = entry.purposes.sort((left, right) => THREAD_PURPOSE_ORDER.indexOf(left) - THREAD_PURPOSE_ORDER.indexOf(right));
    return {
      ...entry, purposes,
      displayRole: purposes.map((purpose) => THREAD_PURPOSE_LABELS[purpose] ?? purpose).join(" · ") || entry.role || "Codex thread",
    };
  }).sort((left, right) => Number(right.active) - Number(left.active) || String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")));
}

export function dashboardRevision(registry) {
  return registry.listEvents({ limit: 1 })[0]?.id ?? 0;
}

export function buildDashboardSnapshot(registry, options = {}) {
  const cwd = options.cwd || undefined;
  const scope = ["active", "archived", "all"].includes(options.scope) ? options.scope : "active";
  let runs = registry.listRuns({ cwd, scope, limit: options.limit ?? 50 });
  const allTasks = registry.listTasks({ cwd, limit: options.taskLimit ?? 1000 });
  const taskByRunId = new Map();
  for (const task of allTasks) {
    const taskRunId = task.metadata?.runId;
    if (!taskRunId) continue;
    const group = taskByRunId.get(taskRunId) ?? [];
    group.push(task);
    taskByRunId.set(taskRunId, group);
  }
  const allAgents = registry.listAgents({ cwd, scope: "all", limit: 500 });
  const globalRunGraphs = (registry.listGlobalRuns?.({ limit: 50 }) ?? []).map((globalRun) => registry.getGlobalRunGraph(globalRun.id));
  const globalRunByProjectRunId = new Map(globalRunGraphs.flatMap((graph) => graph.memberships.map((membership) => [membership.runId, graph])));
  const agentById = new Map(allAgents.map((agent) => [agent.id, agent]));
  const participantIds = new Set([
    ...allTasks.map((task) => task.agentId).filter(Boolean),
    ...runs.map((run) => run.metadata?.orchestratorSessionIdentity?.agentId ?? run.metadata?.orchestratorAgentId).filter(Boolean),
  ]);
  for (const id of participantIds) {
    if (!agentById.has(id)) {
      const participant = registry.getAgent(id);
      if (participant) agentById.set(id, participant);
    }
  }
  const rawAgents = scope === "all"
    ? allAgents
    : allAgents.filter((agent) => scope === "archived" ? Boolean(agent.archivedAt) : !agent.archivedAt);
  const requestedRun = options.runId ? runs.find((candidate) => candidate.id === options.runId) : null;
  const runId = requestedRun?.id
    ?? runs.find((run) => ACTIVE_RUN_STATUSES.has(run.status))?.id
    ?? runs[0]?.id
    ?? null;
  const graph = runId && options.getGraph ? options.getGraph(runId, { detail: false }) : null;
  // getGraph may reconcile a stale terminal Run. Re-read the lightweight list
  // so the selected card, Run list, and graph always describe one state.
  if (graph) runs = registry.listRuns({ cwd, scope, limit: options.limit ?? 50 });
  const run = runId ? registry.getRun(runId) : null;
  const tasks = options.tasksForSelectedRun === false
    ? allTasks.slice(0, 100)
    : runId ? (taskByRunId.get(runId) ?? []).slice(0, 100) : [];
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const selectedTurnDispatches = runId ? (registry.listTurnDispatches?.({ parentRunId: runId, limit: 200 }) ?? []) : [];
  return {
    kind: "snapshot",
    revision: dashboardRevision(registry),
    generatedAt: new Date().toISOString(),
    cwd: cwd ?? null,
    scope,
    runId,
    status: run?.status ?? null,
    run: run ? runSummary(run, taskByRunId, agentById, registry.getRunResult?.(run.id), registry, globalRunByProjectRunId.get(run.id)) : null,
    graph,
    runs: runs.map((item) => runSummary(item, taskByRunId, agentById, registry.getRunResult?.(item.id), registry, globalRunByProjectRunId.get(item.id))),
    globalRuns: globalRunGraphs.map(globalRunSummary),
    agents: rawAgents.slice(0, 100).map((agent) => agentSummary(agent, registry)),
    threadBudget: registry.getThreadBudgetState?.({ cwd }) ?? null,
    tasks: tasks.map((task) => taskSummary(task, taskById, agentById, registry)),
    plans: (registry.listPlans?.({ cwd, limit: 100 }) ?? []).map(planSummary),
    worktrees: (registry.listManagedWorktrees?.({ limit: 100 }) ?? []).map(worktreeSummary),
    roles: (registry.listRoleTemplates?.({ limit: 100 }) ?? []).map(({ developerInstructions: _instructions, metadata: _metadata, ...role }) => role),
    memories: (registry.listMemories?.({ cwd, limit: 100 }) ?? []).map(memorySummary),
    notifications: (registry.listNotifications?.({ cwd, limit: 20 }) ?? []).map(notificationSummary),
    turnDispatches: selectedTurnDispatches.map(turnDispatchSummary),
    runThreads: run ? runThreadSummaries(selectedTurnDispatches, run, tasks, agentById) : [],
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
    ...(["agent", "thread_lifecycle"].some((type) => changedTypes.has(type)) ? { agents: snapshot.agents, runThreads: snapshot.runThreads } : {}),
    ...(["agent", "thread_lifecycle", "thread_budget"].some((type) => changedTypes.has(type)) ? { threadBudget: snapshot.threadBudget } : {}),
    ...(changedTypes.has("task") ? { tasks: snapshot.tasks, runThreads: snapshot.runThreads } : {}),
    ...(["task", "run"].some((type) => changedTypes.has(type)) ? { runs: snapshot.runs, run: snapshot.run, runThreads: snapshot.runThreads } : {}),
    ...(changedTypes.has("plan") ? { plans: snapshot.plans } : {}),
    ...(changedTypes.has("worktree") ? { worktrees: snapshot.worktrees } : {}),
    ...(changedTypes.has("role") ? { roles: snapshot.roles } : {}),
    ...(changedTypes.has("memory") ? { memories: snapshot.memories } : {}),
    ...(changedTypes.has("notification") ? { notifications: snapshot.notifications } : {}),
    ...(changedTypes.has("turn_dispatch") ? { turnDispatches: snapshot.turnDispatches, runThreads: snapshot.runThreads, agents: snapshot.agents, tasks: snapshot.tasks } : {}),
    ...(changedTypes.has("global_run") ? { globalRuns: snapshot.globalRuns, runs: snapshot.runs, run: snapshot.run } : {}),
    ...(["task", "run", "worktree"].some((type) => changedTypes.has(type)) ? { graph: snapshot.graph } : {}),
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
    case "thread_lifecycle": return registry.getThreadLifecycle(entityId);
    case "task": return registry.getTask(entityId);
    case "run": return registry.getRun(entityId);
    case "graph": return options.getGraph?.(entityId, { detail: true }) ?? null;
    case "plan": {
      const plan = registry.getPlan(entityId);
      return plan ? { ...plan, revisions: registry.listPlanRevisions(entityId) } : null;
    }
    case "worktree": return registry.getManagedWorktree(entityId);
    case "memory": return registry.getMemory(entityId);
    case "context_snapshot": return registry.getContextSnapshot(entityId);
    case "global_run": return registry.getGlobalRunGraph(entityId);
    case "turn_dispatch": return registry.getTurnDispatch(entityId);
    default: throw new Error(`Unsupported dashboard entity type: ${entityType}`);
  }
}
