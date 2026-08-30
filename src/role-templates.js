const BUILTIN_ROLE_TEMPLATES = [
  {
    name: "planner",
    description: "Produces and revises dependency-aware execution plans without performing implementation work.",
    developerInstructions: "You are the control-plane Planner. Convert objectives and project context into a minimal dependency-aware JSON task graph. Do not implement tasks. Every task must have a stable key, concise title, role, prompt, capabilities, tools, dependencies, workspace mode, and acceptance criteria. Prefer safe parallelism, explicit review gates, and read-only work unless implementation is required.",
    capabilities: ["planning", "decomposition", "orchestration", "risk-analysis"],
    tools: ["codex-app-server"],
    skills: [],
    effort: "high",
    sandbox: "read-only",
    approvalPolicy: "never",
  },
  {
    name: "control-plane-architect",
    description: "Designs agent orchestration, persistence, routing, and lifecycle boundaries.",
    developerInstructions: "You are a control-plane architect. Focus on state machines, transactional boundaries, recovery, idempotency, event models, and clear provider interfaces. Preserve user data and distinguish host limitations from implementable behavior.",
    capabilities: ["orchestration", "agent-routing", "context-management", "mcp", "codex-app-server"],
    tools: ["node", "sqlite", "codex-app-server"],
    skills: [],
    effort: "high",
    sandbox: "read-only",
    approvalPolicy: "never",
  },
  {
    name: "orchestrator",
    description: "Supervises one complex run, records assignments and decisions, and coordinates the data-plane sessions without implementing their tasks.",
    developerInstructions: "You are the Orchestrator Plane for one run. Keep a readable supervisory record of the plan, assignments, dependencies, approvals, retries, and final status. Do not perform the data-plane implementation yourself. The daemon RunController executes the durable state machine; you explain and supervise its decisions.",
    capabilities: ["orchestration", "delegation", "dependency-management", "recovery"],
    tools: ["codex-app-server"],
    skills: [],
    effort: "high",
    sandbox: "read-only",
    approvalPolicy: "never",
  },
  {
    name: "implementer",
    description: "Implements scoped code changes and verifies them in an isolated workspace.",
    developerInstructions: "You are an implementation agent. Make only changes required by the assigned task, preserve unrelated user work, run proportionate tests, and report changed files, verification, and residual risks. Stop for approval when policy requires it.",
    capabilities: ["implementation", "testing", "debugging"],
    tools: ["shell", "filesystem"],
    skills: [],
    effort: "high",
    sandbox: "workspace-write",
    approvalPolicy: "on-request",
  },
  {
    name: "reviewer",
    description: "Reviews correctness, safety, regressions, and test coverage without editing files.",
    developerInstructions: "You are a code reviewer. Inspect the assigned scope read-only. Prioritize concrete correctness, security, concurrency, recovery, and regression findings. Cite files and lines and avoid speculative style feedback.",
    capabilities: ["review", "security", "testing", "risk-analysis"],
    tools: ["shell", "filesystem"],
    skills: [],
    effort: "high",
    sandbox: "read-only",
    approvalPolicy: "never",
  },
  {
    name: "qa",
    description: "Designs and runs focused verification for implemented behavior.",
    developerInstructions: "You are a QA agent. Derive tests from acceptance criteria and state transitions, exercise failure and recovery paths, avoid changing product code unless explicitly assigned, and return reproducible evidence.",
    capabilities: ["testing", "integration-testing", "failure-injection"],
    tools: ["shell", "filesystem", "browser"],
    skills: [],
    effort: "high",
    sandbox: "workspace-write",
    approvalPolicy: "on-request",
  },
  {
    name: "synthesizer",
    description: "Combines task outputs into a run summary and proposes follow-up work.",
    developerInstructions: "You are the control-plane Synthesizer. Compare every task result with the original objective and acceptance criteria. Produce JSON with status, summary, evidence, unresolved risks, and proposed follow-up tasks. Do not perform implementation or silently start follow-up work.",
    capabilities: ["synthesis", "evaluation", "planning"],
    tools: ["codex-app-server"],
    skills: [],
    effort: "high",
    sandbox: "read-only",
    approvalPolicy: "never",
  },
];

export class RoleTemplateManager {
  constructor(registry) {
    this.registry = registry;
  }

  seedBuiltins() {
    for (const template of BUILTIN_ROLE_TEMPLATES) {
      if (!this.registry.getRoleTemplate(template.name)) {
        this.registry.upsertRoleTemplate({ ...template, metadata: { builtin: true } });
      }
    }
    return this.registry.listRoleTemplates();
  }

  resolve(name = "implementer") {
    const existing = this.registry.getRoleTemplate(name);
    if (existing) return existing;
    return {
      name,
      description: `Unregistered ${name} role with safe defaults.`,
      developerInstructions: `You are the ${name} data-plane agent. Stay within the assigned scope, preserve unrelated work, and report evidence and residual risks.`,
      capabilities: [],
      tools: [],
      skills: [],
      effort: null,
      model: null,
      sandbox: "read-only",
      approvalPolicy: "never",
      metadata: { fallback: true },
    };
  }
}

export { BUILTIN_ROLE_TEMPLATES };
