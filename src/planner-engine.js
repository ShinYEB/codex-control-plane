import { randomUUID } from "node:crypto";
import { agentDisplayName } from "./agent-names.js";

const PLAN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "risks", "tasks"],
  properties: {
    summary: { type: "string" },
    risks: { type: "array", items: { type: "string" } },
    tasks: {
      type: "array",
      minItems: 1,
      maxItems: 20,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["key", "title", "prompt", "role", "capabilities", "tools", "dependsOn", "workspaceMode", "acceptanceCriteria"],
        properties: {
          key: { type: "string" },
          title: { type: "string" },
          prompt: { type: "string" },
          role: { type: "string" },
          capabilities: { type: "array", items: { type: "string" } },
          tools: { type: "array", items: { type: "string" } },
          dependsOn: { type: "array", items: { type: "string" } },
          workspaceMode: { type: "string", enum: ["shared", "worktree"] },
          acceptanceCriteria: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
};

const SYNTHESIS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["status", "summary", "evidence", "unresolvedRisks", "followUps"],
  properties: {
    status: { type: "string", enum: ["completed", "partial", "failed"] },
    summary: { type: "string" },
    evidence: { type: "array", items: { type: "string" } },
    unresolvedRisks: { type: "array", items: { type: "string" } },
    followUps: { type: "array", items: { type: "string" } },
  },
};

function parseJsonOutput(output) {
  const value = String(output ?? "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  if (!value) throw new Error("Planner returned no structured output");
  return JSON.parse(value);
}

export class PlannerEngine {
  constructor(options) {
    this.registry = options.registry;
    this.contextManager = options.contextManager;
    this.roleTemplates = options.roleTemplates;
    this.getControl = options.getControl;
    this.decorateAgent = options.decorateAgent;
  }

  async plan(options) {
    const id = options.planId ?? `plan_${randomUUID()}`;
    const existing = options.requestKey ? this.registry.listPlans({ limit: 200 }).find((plan) => plan.requestKey === options.requestKey) : null;
    if (existing?.status === "planned" && existing.plan?.tasks?.length) return existing;
    const targetId = existing?.id ?? id;
    if (!existing) this.registry.createPlan({ id: targetId, requestKey: options.requestKey, objective: options.objective, cwd: options.cwd, metadata: { constraints: options.constraints ?? [] } });
    else this.registry.updatePlan(targetId, { status: "planning", metadata: { resumedAt: new Date().toISOString() } });
    try {
      return await this.#invoke(targetId, null);
    } catch (error) {
      this.registry.updatePlan(targetId, { status: "failed", metadata: { error: error.message } });
      throw error;
    }
  }

  async revise(planId, feedback) {
    const plan = this.registry.getPlan(planId);
    if (!plan) throw new Error(`Plan not found: ${planId}`);
    this.registry.updatePlan(planId, { status: "revising", feedback });
    try {
      return await this.#invoke(planId, feedback);
    } catch (error) {
      this.registry.updatePlan(planId, { status: "failed", metadata: { error: error.message } });
      throw error;
    }
  }

  async synthesize(planId, tasks) {
    const plan = this.registry.getPlan(planId);
    if (!plan) throw new Error(`Plan not found: ${planId}`);
    const { control, agent } = await this.#ensureAgent(plan.cwd, "synthesizer");
    const result = await control.runTask(agent.id, [
      "Synthesize this completed control-plane run. Return only JSON matching the supplied schema.",
      `Objective: ${plan.objective}`,
      `Plan: ${JSON.stringify(plan.plan)}`,
      `Task results: ${JSON.stringify(tasks.map(({ id, status, title, result, error }) => ({ id, status, title, result, error })))}`,
    ].join("\n\n"), { cwd: plan.cwd, outputSchema: SYNTHESIS_SCHEMA, approvalPolicy: "never" });
    const synthesis = parseJsonOutput(result.output);
    return this.registry.updatePlan(planId, { status: "synthesized", synthesis, completedAt: new Date().toISOString() });
  }

  async #invoke(planId, feedback) {
    const plan = this.registry.getPlan(planId);
    const { control, agent } = await this.#ensureAgent(plan.cwd, "planner", plan.plannerAgentId);
    const context = this.contextManager.build({ cwd: plan.cwd, prompt: plan.objective, role: "planner", touch: true });
    const prompt = [
      "Create or revise an executable control-plane task graph. Return only JSON matching the supplied schema.",
      `Objective: ${plan.objective}`,
      feedback ? `Revision feedback: ${feedback}` : null,
      plan.plan ? `Previous plan: ${JSON.stringify(plan.plan)}` : null,
      `Project context:\n${this.contextManager.format(context)}`,
      "Use worktree workspace mode for concurrent file-writing tasks. Follow-up work must never start automatically.",
    ].filter(Boolean).join("\n\n");
    const result = await control.runTask(agent.id, prompt, { cwd: plan.cwd, outputSchema: PLAN_SCHEMA, approvalPolicy: "never" });
    const materialized = parseJsonOutput(result.output);
    if (!materialized || !Array.isArray(materialized.tasks) || materialized.tasks.length === 0) {
      throw new Error("Planner returned an invalid graph without tasks");
    }
    return this.registry.updatePlan(planId, {
      status: "planned",
      version: plan.version + (feedback ? 1 : 0),
      plannerAgentId: agent.id,
      plan: materialized,
      feedback: feedback ?? plan.feedback,
      metadata: { contextMemoryIds: context.memories.map((item) => item.id) },
    });
  }

  async #ensureAgent(cwd, role, preferredId = null) {
    const control = await this.getControl();
    const template = this.roleTemplates.resolve(role);
    let agent;
    if (preferredId) {
      try {
        agent = await control.resumeAgent(preferredId, { cwd, sandbox: template.sandbox, approvalPolicy: template.approvalPolicy, model: template.model });
      } catch {
        agent = null;
      }
    }
    if (!agent) {
      agent = await control.spawnAgent({ cwd, sandbox: template.sandbox, approvalPolicy: template.approvalPolicy, model: template.model, developerInstructions: template.developerInstructions });
      await this.decorateAgent(control, agent, agentDisplayName(role, String(cwd ?? "workspace").split("/").pop()), true);
    }
    this.registry.upsertAgent({ ...agent, status: "idle" }, { role, capabilities: template.capabilities, metadata: { tools: template.tools, controlPlane: true } });
    return { control, agent };
  }
}

export { PLAN_SCHEMA, SYNTHESIS_SCHEMA, parseJsonOutput };
