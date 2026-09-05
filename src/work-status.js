import { SUCCESSFUL_TASK_STATUSES, TERMINAL_TASK_STATUSES } from "./domain-states.js";
import { publicWorkName } from "./agent-names.js";

// Deliberately excludes prompts, contracts, events and results. Navigation is
// a read-only convenience, never a new turn or an execution authority.
export function workStatus(registry, run) {
  const tasks = registry.listTasks({ runId: run.id, limit: 1000000 });
  const masterId = run.metadata?.orchestratorSessionIdentity?.agentId
    ?? run.metadata?.orchestratorAgentId
    ?? (tasks.length === 1 ? tasks[0].agentId : null);
  const master = masterId ? registry.getAgent(masterId) : null;
  const attention = tasks.find(t => TERMINAL_TASK_STATUSES.has(t.status) && !SUCCESSFUL_TASK_STATUSES.has(t.status));
  return {
    runId: run.id, name: run.name, status: run.status,
    progress: { total: tasks.length, finished: tasks.filter(t => TERMINAL_TASK_STATUSES.has(t.status)).length },
    master: master ? { threadId: master.id, name: publicWorkName(run.name || master.name),
      label: run.status === "completed" && run.metadata?.controlResultFinalizedAt ? "결과 보기" : "작업 열기",
      url: `codex://threads/${master.id}`, access: "observe_while_running" } : null,
    ...(attention || run.metadata?.failure ? { attention: {
      cause: String(attention?.error ?? run.metadata?.failure?.cause ?? "Execution needs attention").slice(0, 300),
      nextAction: attention?.routing?.nextAction ?? attention?.metadata?.failure?.nextAction ?? run.metadata?.failure?.nextAction ?? "inspect_failure",
    } } : {}),
    detailsAvailable: true,
  };
}
