import { workStatus } from "./work-status.js";
import { publicWorkName } from "./agent-names.js";

export function workPanelSnapshot(registry, runId) {
  const run = registry.getRun(runId);
  if (!run) return null;
  return { work: workStatus(registry, run), tasks: registry.listTasks({ runId, limit: 1000000 }).map(task => ({
    id: task.id,
    name: publicWorkName(task.metadata?.title ?? "작업"),
    status: task.status,
    threadId: task.agentId ?? null,
    updatedAt: task.updatedAt ?? null,
    issue: task.error ? String(task.error).slice(0, 500) : null,
  })) };
}
