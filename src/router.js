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

function normalizeStatus(status) {
  if (status === "notLoaded") return "available";
  return status ?? "unknown";
}

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

function requirementMatrix(request = {}, agent = {}) {
  const capabilities = satisfaction(request.capabilities ?? [], agent.capabilities ?? []);
  const tools = satisfaction(request.tools ?? [], agent.metadata?.tools ?? []);
  return { capabilities, tools, eligible: capabilities.allSatisfied && tools.allSatisfied };
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
      const profileTokens = tokens([
        agent.name,
        agent.role,
        agent.summary,
        ...(agent.capabilities ?? []),
        ...(agent.metadata?.tools ?? []),
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

      const eligible = matrix.eligible;

      const contextMatches = overlap(taskTokens, profileTokens);
      if (contextMatches) add(breakdown, reasons, "context", Math.min(contextMatches * 6, 36), `${contextMatches} context keyword match${contextMatches === 1 ? "" : "es"}`);

      if (request.branch && agent.metadata?.branch === request.branch) add(breakdown, reasons, "branch", 20, "same branch context");
      else if (request.branch && agent.metadata?.branch) add(breakdown, reasons, "branch", -12, `branch differs (${agent.metadata.branch})`);
      if (request.provider && agent.provider === request.provider) add(breakdown, reasons, "provider", 12, "requested provider");
      else if (request.provider && agent.provider !== request.provider) {
        add(breakdown, reasons, "provider", -40, "provider mismatch");
        blockers.push("provider mismatch");
      }
      if (request.model && agent.model === request.model) add(breakdown, reasons, "model", 8, "same model");

      if (["idle", "available", "unknown"].includes(status)) add(breakdown, reasons, "availability", 12, "available");
      else if (["running", "active", "approval_waiting"].includes(status)) add(breakdown, reasons, "availability", -18, "currently busy; fork only");
      if (agent.ephemeral) add(breakdown, reasons, "durability", -8, "ephemeral session");

      const contextTimestamp = agent.metadata?.contextUpdatedAt ?? agent.lastTaskAt;
      if (contextTimestamp) {
        const ageDays = Math.max((Date.now() - new Date(contextTimestamp).valueOf()) / 86_400_000, 0);
        if (ageDays <= 7) add(breakdown, reasons, "freshness", 10, "context refreshed within 7 days");
        else if (ageDays > 90) add(breakdown, reasons, "freshness", -10, "context older than 90 days");
      }

      const score = Object.values(breakdown).reduce((sum, value) => sum + value, 0);
      return { agent: { ...agent, status }, score, breakdown, reasons, blockers, eligible, requirementMatrix: matrix };
    }).sort((left, right) => right.score - left.score || String(right.agent.updatedAt ?? "").localeCompare(String(left.agent.updatedAt ?? "")));
  }

  select(agents, request = {}) {
    const ranked = this.rank(agents, request);
    const minimumScore = request.minimumScore ?? 35;
    const eligible = ranked.filter((entry) => entry.eligible);
    const best = eligible[0] ?? null;
    const selected = best && best.score >= minimumScore;
    const reuseCount = Number(best?.agent?.metadata?.reuseCount ?? 0);
    const maxReuseCount = request.maxReuseCount ?? 12;
    const rolloverRequired = Boolean(selected && request.reuseExisting && reuseCount >= maxReuseCount);
    const decision = selected ? (request.reuseExisting && !rolloverRequired ? "reuse" : "fork") : "spawn";
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
        },
      },
      decision,
      minimumScore,
      selectedAgent: selected ? best.agent : null,
      score: best?.score ?? 0,
      scoreBreakdown: best?.breakdown ?? {},
      confidence: certainty,
      reasons: selected
        ? [...best.reasons, ...(rolloverRequired ? [`reuse history reached ${reuseCount}/${maxReuseCount}; fork for a fresh context window`] : [])]
        : [...(best?.reasons ?? []), "no candidate met the routing threshold"],
      rolloverRequired,
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
      })),
    };
  }
}

function requiredValues(values = []) {
  return new Set(values.map((value) => String(value).toLowerCase()));
}

export { normalizeStatus, relatedPath, requirementMatrix };
