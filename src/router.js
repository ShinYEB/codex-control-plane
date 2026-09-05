import { normalizeAgentStatus } from "./domain-states.js";
import { estimateContextHealth, isEphemeralTask } from "./thread-lifecycle.js";

function tokens(value) {
  return new Set(String(value ?? "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}_-]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length > 1));
}

function overlap(left, right) {
  let count = 0;
  for (const value of left) if (right.has(value)) count += 1;
  return count;
}

const normalizeStatus = normalizeAgentStatus;

function relatedPath(left, right) {
  if (!left || !right) return false;
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function add(breakdown, reasons, key, value, reason) {
  breakdown[key] = (breakdown[key] ?? 0) + value;
  if (reason) reasons.push(reason);
}

function confidence(best, second, minimumScore) {
  if (!best || best.score < minimumScore) return { level: "low", margin: best?.score ?? 0 };
  const margin = best.score - (second?.score ?? minimumScore);
  return { level: margin >= 30 ? "high" : margin >= 12 ? "medium" : "low", margin };
}

function satisfaction(requiredValues = [], providedValues = []) {
  const required = [...new Set(requiredValues.map((value) => String(value).toLowerCase()))];
  const provided = [...new Set(providedValues.map((value) => String(value).toLowerCase()))];
  const available = new Set(provided);
  const cells = required.map((requirement) => ({ requirement, satisfied: available.has(requirement) }));
  return {
    required,
    provided,
    cells,
    satisfied: cells.filter((cell) => cell.satisfied).map((cell) => cell.requirement),
    missing: cells.filter((cell) => !cell.satisfied).map((cell) => cell.requirement),
    allSatisfied: cells.every((cell) => cell.satisfied),
  };
}

const SANDBOX_LEVEL = { "read-only": 0, "workspace-write": 1, "danger-full-access": 2 };

function executionCompatibility(request = {}, agent = {}) {
  const contract = request.executionContract ?? {};
  const ceiling = agent.metadata?.permissionCeiling ?? agent.metadata?.roleTemplate?.sandbox ?? null;
  const sandboxSatisfied = !ceiling || (SANDBOX_LEVEL[ceiling] ?? -1) >= (SANDBOX_LEVEL[contract.sandbox] ?? 0);
  const branchSatisfied = !request.branch || !agent.metadata?.branch || request.branch === agent.metadata.branch;
  const workspaceSatisfied = contract.workspaceMode !== "worktree" || !agent.metadata?.effectiveCwd || relatedPath(request.cwd, agent.metadata.effectiveCwd);
  const lockedApprovalPolicy = agent.metadata?.approvalPolicyLocked ? agent.metadata?.approvalPolicy : null;
  const approvalSatisfied = !lockedApprovalPolicy || lockedApprovalPolicy === contract.approvalPolicy;
  const writerOwnerTaskId = agent.metadata?.currentTaskId ?? agent.metadata?.writerOwnerTaskId ?? null;
  const writerAvailable = !writerOwnerTaskId || writerOwnerTaskId === request.taskId;
  return { ceiling, sandboxSatisfied, branchSatisfied, workspaceSatisfied, approvalSatisfied, writerOwnerTaskId, writerAvailable, allSatisfied: sandboxSatisfied && branchSatisfied && workspaceSatisfied && approvalSatisfied };
}

function requirementMatrix(request = {}, agent = {}) {
  const capabilities = satisfaction(request.capabilities ?? [], agent.capabilities ?? []);
  const tools = satisfaction(request.tools ?? [], agent.metadata?.tools ?? []);
  const execution = executionCompatibility(request, agent);
  return { capabilities, tools, execution, eligible: capabilities.allSatisfied && tools.allSatisfied && execution.allSatisfied };
}

export class AgentRouter {
  rank(agents, request = {}) {
    const contextText = (request.context?.memories ?? []).map((memory) => `${memory.title ?? ""} ${memory.content ?? ""}`).join(" ");
    const taskTokens = tokens(`${request.prompt ?? ""} ${contextText}`);
    const requiredCapabilities = new Set((request.capabilities ?? []).map((value) => String(value).toLowerCase()));
    const requiredTools = new Set((request.tools ?? []).map((value) => String(value).toLowerCase()));
    const requestedRole = request.role?.trim().toLowerCase() ?? null;

    return agents.map((agent) => {
      const breakdown = {};
      const reasons = [];
      const blockers = [];
      const status = normalizeStatus(agent.status);
      const knowledge = request.threadKnowledge?.[agent.id] ?? null;
      const lifecycle = request.lifecycleByAgent?.[agent.id] ?? agent.lifecycle ?? null;
      const contextHealth = lifecycle?.contextHealth ?? estimateContextHealth({ ...agent, lifecycle }, knowledge);
      const profileTokens = tokens([
        agent.name,
        agent.role,
        agent.summary,
        ...(agent.capabilities ?? []),
        ...(agent.metadata?.tools ?? []),
        ...(knowledge?.topics ?? []),
      ].filter(Boolean).join(" "));

      if (request.cwd && agent.cwd === request.cwd) add(breakdown, reasons, "project", 30, "same working directory");
      else if (relatedPath(request.cwd, agent.cwd)) add(breakdown, reasons, "project", 18, "related project directory");
      else if (request.cwd) add(breakdown, reasons, "project", -30, "different project directory");

      if (requestedRole && agent.role?.toLowerCase() === requestedRole) add(breakdown, reasons, "role", 45, "exact role match");
      else if (requestedRole && profileTokens.has(requestedRole)) add(breakdown, reasons, "role", 18, "role keyword match");
      else if (requestedRole) {
        add(breakdown, reasons, "role", -28, "requested role does not match");
        blockers.push("role mismatch");
      }

      const matrix = requirementMatrix(request, agent);
      const capabilityMatches = matrix.capabilities.satisfied.length;
      if (capabilityMatches) add(breakdown, reasons, "capabilities", capabilityMatches * 18, `${capabilityMatches} capability match${capabilityMatches === 1 ? "" : "es"}`);
      if (requiredCapabilities.size > capabilityMatches) {
        const missing = matrix.capabilities.missing;
        add(breakdown, reasons, "capabilities", missing.length * -20, `missing capabilities: ${missing.join(", ")}`);
        blockers.push(`missing capabilities: ${missing.join(", ")}`);
      }

      const toolMatches = matrix.tools.satisfied.length;
      if (toolMatches) add(breakdown, reasons, "tools", toolMatches * 12, `${toolMatches} tool match${toolMatches === 1 ? "" : "es"}`);
      if (requiredTools.size > toolMatches) {
        const missing = matrix.tools.missing;
        add(breakdown, reasons, "tools", missing.length * -14, `missing tools: ${missing.join(", ")}`);
        blockers.push(`missing tools: ${missing.join(", ")}`);
      }

      if (!matrix.execution.sandboxSatisfied) blockers.push(`sandbox exceeds agent permission ceiling (${matrix.execution.ceiling})`);
      if (!matrix.execution.branchSatisfied) blockers.push("branch mismatch");
      if (!matrix.execution.workspaceSatisfied) blockers.push("worktree workspace mismatch");
      if (!matrix.execution.approvalSatisfied) blockers.push("approval policy is locked to another mode");
      if (!matrix.execution.writerAvailable) reasons.push(`thread writer is owned by task ${matrix.execution.writerOwnerTaskId}; fork required`);

      if (["compacted", "superseded", "archived"].includes(lifecycle?.status)) blockers.push(`thread lifecycle is ${lifecycle.status}`);
      if (contextHealth < (request.threadBudget?.policy?.minContextHealth ?? 0)) blockers.push(`context health ${contextHealth} is below policy minimum`);
      let eligible = matrix.eligible && !blockers.some((blocker) => blocker.startsWith("thread lifecycle") || blocker.startsWith("context health"));

      const contextMatches = overlap(taskTokens, profileTokens);
      if (contextMatches) add(breakdown, reasons, "context", Math.min(contextMatches * 6, 36), `${contextMatches} context keyword match${contextMatches === 1 ? "" : "es"}`);
      if (knowledge?.id) {
        add(breakdown, reasons, "knowledge", 8, `thread knowledge snapshot ${knowledge.id}`);
        if (knowledge.claimIds?.length) add(breakdown, reasons, "knowledge", Math.min(knowledge.claimIds.length * 2, 10), `${knowledge.claimIds.length} provenance-backed claim${knowledge.claimIds.length === 1 ? "" : "s"}`);
      }

      if (request.branch && agent.metadata?.branch === request.branch) add(breakdown, reasons, "branch", 20, "same branch context");
      else if (request.branch && agent.metadata?.branch) add(breakdown, reasons, "branch", -12, `branch differs (${agent.metadata.branch})`);
      if (request.provider && agent.provider === request.provider) add(breakdown, reasons, "provider", 12, "requested provider");
      else if (request.provider && agent.provider !== request.provider) {
        add(breakdown, reasons, "provider", -40, "provider mismatch");
        blockers.push("provider mismatch");
        eligible = false;
      }
      if (request.model && agent.model === request.model) add(breakdown, reasons, "model", 8, "same model");

      if (["idle", "available", "unknown"].includes(status)) add(breakdown, reasons, "availability", 12, "available");
      else if (["running", "active", "approval_waiting"].includes(status)) add(breakdown, reasons, "availability", -18, "currently busy; fork only");
      if (agent.ephemeral) add(breakdown, reasons, "durability", -8, "ephemeral thread");

      const contextTimestamp = agent.metadata?.contextUpdatedAt ?? agent.lastTaskAt;
      if (contextTimestamp) {
        const ageDays = Math.max((Date.now() - new Date(contextTimestamp).valueOf()) / 86_400_000, 0);
        if (ageDays <= 7) add(breakdown, reasons, "freshness", 10, "context refreshed within 7 days");
        else if (ageDays > 90) add(breakdown, reasons, "freshness", -10, "context older than 90 days");
      }

      const score = Object.values(breakdown).reduce((sum, value) => sum + value, 0);
      return { agent: { ...agent, status, lifecycle }, score, breakdown, reasons, blockers, eligible, requirementMatrix: matrix, knowledge, contextHealth };
    }).sort((left, right) => right.score - left.score || String(right.agent.updatedAt ?? "").localeCompare(String(left.agent.updatedAt ?? "")));
  }

  select(agents, request = {}) {
    const ranked = this.rank(agents, request);
    const minimumScore = request.minimumScore ?? 35;
    const eligible = ranked.filter((entry) => entry.eligible);
    // Prefer a usable idle candidate over a busy higher-scoring candidate when
    // there is no capacity for the latter's fork.
    const best = eligible.find((entry) => {
      const budget = request.threadBudgetStateByAgent?.[entry.agent.id] ?? request.threadBudgetState;
      return entry.score >= minimumScore && request.reuseExisting && entry.requirementMatrix.execution.writerAvailable
        && ["idle", "available"].includes(entry.agent.status)
        && Number(entry.agent.metadata?.reuseCount ?? 0) < (request.maxReuseCount ?? request.threadBudget?.policy?.maxReuseCount ?? 12)
        && budget && (!budget.canCreateProject || !budget.canCreateRole || !budget.canForkLineage);
    }) ?? eligible[0] ?? null;
    const selected = best && best.score >= minimumScore;
    const reuseCount = Number(best?.agent?.metadata?.reuseCount ?? 0);
    const maxReuseCount = request.maxReuseCount ?? request.threadBudget?.policy?.maxReuseCount ?? 12;
    const writerConflict = Boolean(best && !best.requirementMatrix.execution.writerAvailable);
    const busy = Boolean(best && !["idle", "available", "unknown"].includes(best.agent.status));
    const rolloverRequired = Boolean(selected && request.reuseExisting && reuseCount >= maxReuseCount);
    const budgetState = request.threadBudgetStateByAgent?.[best?.agent?.id]
      ?? request.threadBudgetState
      ?? { canCreateProject: true, canCreateRole: true, canForkLineage: true };
    const canCreate = budgetState.canCreateProject && budgetState.canCreateRole;
    const needsFork = selected && !(request.reuseExisting && !rolloverRequired && !writerConflict && !busy);
    const canFork = canCreate && budgetState.canForkLineage;
    let decision;
    if (selected && !needsFork) decision = "reuse";
    else if (selected && canFork) decision = "fork";
    else if (selected) decision = "wait";
    else if (canCreate) decision = "spawn";
    else if (isEphemeralTask(request)) decision = "ephemeral";
    else decision = "wait";
    const temporaryWait = Boolean(selected && (busy || writerConflict) && !rolloverRequired);
    if (decision === "wait" && (!temporaryWait || request.threadBudget?.policy?.queueWhenBusy === false)) decision = "blocked";
    const certainty = confidence(best, eligible[1], minimumScore);
    return {
      provenance: {
        version: 1,
        evaluatedAt: new Date().toISOString(),
        decisionSource: "agent_router",
        candidateSource: "durable_registry",
        request: {
          cwd: request.cwd ?? null,
          role: request.role ?? null,
          capabilities: [...requiredValues(request.capabilities)],
          tools: [...requiredValues(request.tools)],
          provider: request.provider ?? null,
          model: request.model ?? null,
          branch: request.branch ?? null,
          executionContract: request.executionContract ? {
            fingerprint: request.executionContract.fingerprint,
            sandbox: request.executionContract.sandbox,
            workspaceMode: request.executionContract.workspaceMode,
          } : null,
          threadKnowledgeSnapshotIds: Object.values(request.threadKnowledge ?? {}).map((snapshot) => snapshot.id).filter(Boolean),
        },
      },
      decision,
      waitReason: decision === "wait" ? "candidate_busy" : decision === "blocked" ? "thread_capacity_unavailable" : null,
      nextAction: decision === "blocked" ? "repair_routing" : decision === "wait" ? "wait_for_lease" : null,
      minimumScore,
      selectedAgent: selected ? best.agent : null,
      score: best?.score ?? 0,
      scoreBreakdown: best?.breakdown ?? {},
      confidence: certainty,
      reasons: selected
        ? [...best.reasons, ...(rolloverRequired ? [`reuse history reached ${reuseCount}/${maxReuseCount}; fresh context window required`] : []), ...(writerConflict || busy ? ["active writer ownership prevents direct reuse"] : []), ...(decision === "wait" ? ["thread budget prevents a fork; wait for the existing lease"] : [])]
        : [...(best?.reasons ?? []), "no candidate met the routing threshold", ...(decision === "ephemeral" ? ["durable thread budget is full; use an ephemeral worker"] : decision === "wait" ? ["durable thread budget is full"] : [])],
      rolloverRequired,
      ephemeral: decision === "ephemeral",
      budget: request.threadBudget ?? null,
      budgetState,
      blockers: best?.blockers ?? (ranked.length ? ["no candidate satisfies every required capability and tool"] : ["no registered agents"]),
      selectedRequirementMatrix: selected ? best.requirementMatrix : null,
      candidates: ranked.slice(0, request.limit ?? 5).map((entry) => ({
        agentId: entry.agent.id,
        name: entry.agent.name,
        role: entry.agent.role,
        provider: entry.agent.provider,
        model: entry.agent.model,
        branch: entry.agent.metadata?.branch ?? null,
        status: entry.agent.status,
        score: entry.score,
        scoreBreakdown: entry.breakdown,
        reasons: entry.reasons,
        blockers: entry.blockers,
        eligible: entry.eligible,
        requirementMatrix: entry.requirementMatrix,
        knowledgeSnapshotId: entry.knowledge?.id ?? null,
        knowledgeClaimIds: entry.knowledge?.claimIds ?? [],
        lifecycleStatus: entry.agent.lifecycle?.status ?? null,
        contextHealth: entry.contextHealth,
      })),
    };
  }
}

function requiredValues(values = []) {
  return new Set(values.map((value) => String(value).toLowerCase()));
}

export { normalizeStatus, relatedPath, requirementMatrix };
