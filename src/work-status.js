import { ACTIVE_TASK_STATUSES, WAITING_TASK_STATUSES, TERMINAL_TASK_STATUSES } from "./domain-states.js";
import { publicWorkName } from "./agent-names.js";
import { hostPinning } from "./host-pinning.js";

// Deliberately excludes prompts, contracts, events and results. Navigation is
// a read-only convenience, never a new turn or an execution authority.
export function workProgress(tasks) {
  const progress = { total: tasks.length, finished: 0, succeeded: 0, warnings: 0,
    rejected: 0, failed: 0, cancelled: 0, skipped: 0, attention: 0, active: 0, waiting: 0, unknown: 0 };
  for (const task of tasks) {
    const status = task.status;
    if (TERMINAL_TASK_STATUSES.has(status)) progress.finished++;
    if (["completed", "completed_with_warnings"].includes(status)) {
      progress.succeeded++;
      if (status === "completed_with_warnings") progress.warnings++;
    } else if (["rejected", "validation_failed"].includes(status)) progress.rejected++;
    else if (["failed", "interrupted"].includes(status)) progress.failed++;
    else if (status === "canceled") progress.cancelled++;
    else if (status === "skipped") progress.skipped++;
    else if (["approval_waiting", "recovery_attention", "blocked_by_policy", "integration_blocked"].includes(status)) progress.attention++;
    else if (ACTIVE_TASK_STATUSES.has(status)) progress.active++;
    else if (WAITING_TASK_STATUSES.has(status)) progress.waiting++;
    else progress.unknown++;
  }
  return progress;
}

export function workStatus(registry, run) {
  const tasks = registry.listTasks({ runId: run.id, limit: 1000000 });
  const masterId = run.metadata?.orchestratorSessionIdentity?.agentId
    ?? run.metadata?.orchestratorAgentId
    ?? (tasks.length === 1 ? tasks[0].agentId : null);
  const master = masterId ? registry.getAgent(masterId) : null;
  const orchestrated = Boolean(run.metadata?.orchestratorSessionIdentity?.agentId
    || run.metadata?.orchestratorAgentId || tasks.length > 1);
  const workUrl = master && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(master.id)
    ? `codex://threads/${master.id}` : null;
  const progress = workProgress(tasks);
  const attention = tasks.find(t => ["rejected", "validation_failed", "failed", "interrupted", "approval_waiting", "recovery_attention", "blocked_by_policy", "integration_blocked"].includes(t.status));
  return {
    runId: run.id, name: run.name, status: run.status,
    progress,
    presentation: {
      kind: orchestrated ? "orchestrated" : tasks.length === 1 ? "single" : "preparing",
      workUrl,
      initialPanel: orchestrated && workUrl
        ? { tool: "show_work_progress", arguments: { runId: run.id } } : null,
    },
    pinning: hostPinning(master?.ephemeral ? null : master?.id, run.metadata?.controlRequest?.pin === true),
    needsAttention: Boolean(attention || run.metadata?.failure || progress.unknown),
    observedAt: new Date().toISOString(),
    lastUpdatedAt: [run.updatedAt, ...tasks.map(t => t.updatedAt)].filter(Boolean).sort().at(-1) ?? null,
    master: master ? { threadId: master.id, name: publicWorkName(run.name || master.name),
      label: ["completed", "failed", "cancelled"].includes(run.status) && run.metadata?.controlResultFinalizedAt ? "최종 결과 보기" : "작업 열기",
      navigation: { kind: "host_tool", tool: "navigate_to_codex_page", arguments: { threadId: master.id } },
      access: "observe_while_running" } : null,
    ...(attention || run.metadata?.failure ? { attention: {
      cause: String(attention?.error ?? run.metadata?.failure?.cause ?? (attention?.status === "approval_waiting" ? "사용자 승인을 기다리고 있습니다." : "작업 상태를 확인해야 합니다.")).slice(0, 300),
      nextAction: attention?.routing?.nextAction ?? attention?.metadata?.failure?.nextAction ?? run.metadata?.failure?.nextAction ?? "inspect_failure",
    } } : {}),
    detailsAvailable: true,
  };
}
