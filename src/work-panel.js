import { workStatus } from "./work-status.js";
import { publicWorkName } from "./agent-names.js";

export function workPanelSnapshot(registry, runId) {
  const run = registry.getRun(runId);
  if (!run) return null;
  return { work: workStatus(registry, run), tasks: registry.listTasks({ runId, limit: 1000000 }).map(task => ({
    id: task.id,
    name: publicWorkName(task.metadata?.title ?? "작업"),
    status: task.status,
    description: task.metadata?.description ?? ({test:'지정된 검증을 실행하고 결과를 확인합니다.',analysis:'요청한 내용을 검토하고 근거를 정리합니다.',implementation:'요청한 변경을 구현하고 검증합니다.'}[task.metadata?.executionContract?.taskKind] ?? '요청한 범위의 작업을 수행합니다.'),
    dependsOn: (task.dependencies ?? []).map(dep => typeof dep === 'string' ? dep : dep.taskId ?? dep.dependsOnTaskId).filter(Boolean),
    nextAction: task.routing?.nextAction ?? task.metadata?.failure?.nextAction ?? null,
    threadId: task.agentId ?? null,
    updatedAt: task.updatedAt ?? null,
    issue: task.error ? String(task.error).slice(0, 500) : null,
  })) };
}
