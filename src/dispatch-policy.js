export function classifyTaskGraph(tasks = [], requestedMode = "auto") {
  if (!["auto", "direct", "orchestrated"].includes(requestedMode)) {
    throw new Error(`Unsupported dispatch mode: ${requestedMode}`);
  }
  const taskCount = tasks.length;
  const dependencyCount = tasks.reduce((total, task) => total + (task.dependsOn?.length ?? 0), 0);
  const roles = new Set(tasks.map((task) => task.role).filter(Boolean));
  const isolatedTasks = tasks.filter((task) => task.workspaceMode === "worktree").length;
  const parallelRoots = tasks.filter((task) => !(task.dependsOn?.length)).length;
  const score = Math.min(100,
    Math.max(0, taskCount - 1) * 22
    + dependencyCount * 12
    + Math.max(0, roles.size - 1) * 10
    + isolatedTasks * 8
    + Math.max(0, parallelRoots - 1) * 6);
  const inferredPath = taskCount === 1 && dependencyCount === 0 ? "direct" : "orchestrated";
  const dispatchPath = requestedMode === "auto" ? inferredPath : requestedMode;
  const level = score >= 65 ? "high" : score >= 25 ? "medium" : "low";
  const reasons = [];
  if (requestedMode !== "auto") reasons.push(`사용자가 ${requestedMode} 경로를 지정함`);
  if (taskCount > 1) reasons.push(`${taskCount}개 작업`);
  if (dependencyCount) reasons.push(`${dependencyCount}개 선후 의존성`);
  if (roles.size > 1) reasons.push(`${roles.size}개 전문 역할`);
  if (parallelRoots > 1) reasons.push(`${parallelRoots}개 병렬 시작점`);
  if (isolatedTasks) reasons.push(`${isolatedTasks}개 격리 작업공간`);
  if (!reasons.length) reasons.push("독립적인 단일 작업");
  return {
    dispatchPath,
    level,
    score,
    taskCount,
    dependencyCount,
    roleCount: roles.size,
    parallelRoots,
    isolatedTasks,
    reasons,
  };
}

