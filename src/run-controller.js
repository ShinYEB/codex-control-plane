import { ACTIVE_TASK_STATUSES, TERMINAL_RUN_STATUSES, TERMINAL_TASK_STATUSES, WAITING_TASK_STATUSES } from "./domain-states.js";

function dependencyId(entry) {
  return typeof entry === "string" ? entry : entry?.taskId ?? entry?.dependsOnTaskId;
}

function nodeProgress(status) {
  if (["completed", "completed_with_warnings", "skipped"].includes(status)) return 100;
  if (TERMINAL_TASK_STATUSES.has(status)) return 100;
  if (ACTIVE_TASK_STATUSES.has(status)) return null;
  return 0;
}

function compactFailure(failure) {
  if (!failure) return null;
  return {
    type: failure.type ?? null, category: failure.category ?? null, cause: failure.cause ?? failure.message ?? null,
    retryable: Boolean(failure.retryable), nextAction: failure.nextAction ?? failure.requestedAction ?? null,
    attemptBudget: failure.attemptBudget ?? null, exhausted: Boolean(failure.exhausted),
  };
}

function compactRouting(routing) {
  if (!routing) return null;
  return {
    decision: routing.decision ?? routing.mode ?? null, reasons: routing.reasons ?? [], blockers: routing.blockers ?? [],
    requirementMatrix: routing.selectedRequirementMatrix ?? routing.assignmentRequirementMatrix ?? routing.requirementMatrix ?? null,
    provenance: routing.provenance ?? null, schedulerIdentity: routing.schedulerIdentity ?? null,
    orchestratorSessionIdentity: routing.orchestratorSessionIdentity ?? null,
  };
}

export function buildRunGraph(registry, runId, options = {}) {
  const run = registry.getRun(runId);
  if (!run) throw new Error(`Run not found: ${runId}`);
  const tasks = registry.listTasks({ runId, limit: 1000 });
  const worktrees = registry.listManagedWorktrees?.({ limit: 1000 }) ?? [];
  const plan = run.planId ? registry.getPlan?.(run.planId) : null;
  const orchestratorSessionIdentity = run.metadata?.orchestratorSessionIdentity
    ?? (run.metadata?.orchestratorAgentId ? { type: "codex_session", agentId: run.metadata.orchestratorAgentId } : null);
  const orchestratorAgent = orchestratorSessionIdentity?.agentId ? registry.getAgent(orchestratorSessionIdentity.agentId) : null;
  const nodes = tasks.map((task) => {
    const execution = task.metadata?.execution ?? {};
    const agent = task.agentId ? registry.getAgent(task.agentId) : null;
    const worktreeId = task.metadata?.managedWorktreeId;
    const worktree = worktreeId ? worktrees.find((item) => item.id === worktreeId) : null;
    const routing = execution.preparedRouting ?? task.routing ?? null;
    return {
      id: task.id,
      key: task.metadata?.key ?? task.id,
      title: task.metadata?.title ?? task.prompt.slice(0, 80),
      ...(options.detail === false ? {} : { prompt: task.prompt }),
      role: task.role ?? "agent",
      status: task.status,
      progress: nodeProgress(task.status),
      attempt: task.attempt,
      maxAttempts: task.maxAttempts,
      dependsOn: (task.dependencies ?? []).map(dependencyId).filter(Boolean),
      agent: agent ? { id: agent.id, name: agent.name, role: agent.role, status: agent.status } : null,
      resultSession: task.agentId ? {
        threadId: task.agentId,
        turnId: task.turnId ?? null,
        name: agent?.name ?? null,
        role: agent?.role ?? task.role ?? "agent",
        available: TERMINAL_TASK_STATUSES.has(task.status),
      } : null,
      workspace: {
        mode: execution.workspaceMode ?? "shared",
        path: worktree?.path ?? task.metadata?.effectiveCwd ?? task.cwd,
        branch: worktree?.branch ?? execution.branch ?? null,
        status: worktree?.status ?? null,
        baseline: worktree?.metadata?.baseline ?? null,
        artifact: worktree?.metadata?.artifact ?? null,
        integration: task.metadata?.integration ?? null,
      },
      executionContract: task.metadata?.executionContract ?? execution.executionContract ?? null,
      failureSummary: compactFailure(task.metadata?.failure),
      routingSummary: compactRouting(routing),
      ...(options.detail === false ? {} : {
        acceptanceCriteria: task.metadata?.acceptanceCriteria ?? [],
        validation: task.metadata?.validation ?? null,
        completionVerdict: task.metadata?.completionVerdict ?? null,
        postconditionEvidence: task.metadata?.postconditionEvidence ?? null,
        failure: task.metadata?.failure ?? null,
        routing,
        output: task.output,
        error: task.error,
      }),
      startedAt: task.startedAt,
      completedAt: task.completedAt,
      updatedAt: task.updatedAt,
    };
  });
  const edges = nodes.flatMap((node) => node.dependsOn.map((source) => ({ id: `${source}:${node.id}`, source, target: node.id, type: "dependency" })));
  const counts = Object.fromEntries([...new Set(nodes.map((node) => node.status))].map((status) => [status, nodes.filter((node) => node.status === status).length]));
  const finished = nodes.filter((node) => TERMINAL_TASK_STATUSES.has(node.status)).length;
  const completed = nodes.filter((node) => ["completed", "completed_with_warnings"].includes(node.status)).length;
  return {
    run: {
      id: run.id,
      name: run.name,
      status: run.status,
      cwd: run.cwd,
      planId: run.planId,
      objective: plan?.objective ?? run.name,
      planVersion: plan?.version ?? null,
      dispatchPath: run.metadata?.dispatchPath ?? (tasks.length === 1 ? "direct" : "orchestrated"),
      complexity: run.metadata?.complexity ?? null,
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
      scheduler: run.metadata?.schedulerIdentity ?? null,
      orchestratorSession: orchestratorSessionIdentity,
      orchestrator: orchestratorSessionIdentity ? {
        id: orchestratorSessionIdentity.agentId,
        name: orchestratorAgent?.name ?? null,
        role: orchestratorAgent?.role ?? "orchestrator",
        status: orchestratorAgent?.status ?? "unknown",
      } : null,
      resultAccess: {
        mode: run.metadata?.resultAccess ?? run.metadata?.controlRequest?.resultAccess ?? "dashboard_thread_navigation",
        automaticOriginAppend: false,
      },
      createdAt: run.createdAt,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
    },
    nodes,
    edges,
    summary: {
      total: nodes.length,
      completed,
      finished,
      active: nodes.filter((node) => ACTIVE_TASK_STATUSES.has(node.status)).length,
      waiting: nodes.filter((node) => WAITING_TASK_STATUSES.has(node.status)).length,
      progress: nodes.length ? Math.round((finished / nodes.length) * 100) : 0,
      counts,
    },
    generatedAt: new Date().toISOString(),
  };
}

export class RunController {
  constructor(options) {
    this.registry = options.registry;
    this.getControl = options.getControl;
    this.onReleased = options.onReleased ?? (() => {});
  }

  graph(runId, options = {}) {
    // A graph is the authoritative live view of a Run. Repair a stale parent
    // status before projecting it, including Runs left inconsistent by an
    // older daemon that terminalized a dependency cascade without refreshing
    // the parent Run.
    this.registry.refreshRun(runId);
    return buildRunGraph(this.registry, runId, options);
  }

  start(runId, details = {}) {
    const run = this.registry.getRun(runId);
    if (!run) throw new Error(`Run not found: ${runId}`);
    if (run.status === "running") return { runId, status: "running", releasedTasks: 0, tasks: this.registry.listTasks({ runId, limit: 1000 }) };
    if (!["preparing", "agents_prepared", "awaiting_user_start"].includes(run.status)) throw new Error(`Run ${runId} cannot start from ${run.status}`);
    const tasks = this.registry.listTasks({ runId, limit: 1000 });
    if (!tasks.length) throw new Error(`Run has no tasks: ${runId}`);
    const result = this.registry.releaseStagedRun(runId, details);
    this.onReleased(runId);
    return result;
  }

  async cancel(runId) {
    const run = this.registry.getRun(runId);
    if (!run) throw new Error(`Run not found: ${runId}`);
    if (TERMINAL_RUN_STATUSES.has(run.status)) return run;
    const dispatches = this.registry.requestTurnDispatchCancellation({ parentRunId: runId });
    const tasks = this.registry.listTasks({ runId, limit: 1000 });
    const control = dispatches.some((dispatch) => dispatch.threadId && dispatch.turnId)
      || tasks.some((task) => ["running", "validating", "integration_pending"].includes(task.status)) ? await this.getControl() : null;
    for (const dispatch of dispatches) {
      if (!dispatch.threadId || !dispatch.turnId) continue;
      try {
        await control.interruptTask(dispatch.threadId, dispatch.turnId);
      } catch (error) {
        this.registry.recordEvent("turn_dispatch", dispatch.id, "turn_dispatch.interrupt_failed", { error: error.message });
      }
    }
    for (const task of tasks) {
      if (!["running", "validating", "integration_pending"].includes(task.status)) continue;
      const threadId = task.status === "validating" ? task.metadata?.validationInProgress?.agentId : task.agentId;
      const turnId = task.status === "validating" ? task.metadata?.validationInProgress?.turnId : task.turnId;
      if (!threadId || !turnId) continue;
      try {
        await control.interruptTask(threadId, turnId);
      } catch (error) {
        this.registry.recordEvent("task", task.id, "task.interrupt_failed", { error: error.message });
      }
    }
    return this.registry.cancelRun(runId, { dispatchCancellationRequested: true });
  }

  refresh(runId) {
    return this.registry.refreshRun(runId);
  }

  nextTasks(limit) {
    this.registry.refreshBlockedTasks();
    return this.registry.listRunnableTasks({ limit });
  }

  claimTask(taskId, workerId) {
    return this.registry.claimTask(taskId, workerId);
  }

  afterTask(taskId) {
    const task = this.registry.getTask(taskId);
    const runId = task?.metadata?.runId;
    return runId ? { runId, run: this.refresh(runId) } : { runId: null, run: null };
  }
}
