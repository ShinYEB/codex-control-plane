// Final-answer extraction is identical during live execution and restart recovery.
export function finalTurnOutput(turn) {
  const messages = (turn?.items ?? []).filter(item => ["agentMessage", "agent_message"].includes(item?.type));
  const finals = messages.filter(item => item.phase === "final_answer");
  if (finals.length) return finals.map(item => item.text ?? item.content ?? "").filter(value => typeof value === "string").join("\n");
  if (typeof turn?.output === "string") return turn.output;
  // Older hosts may omit phase. The last completed agent message is the answer,
  // not a concatenation of progress commentary and answer.
  const last = messages.at(-1);
  const value = last?.text ?? last?.content;
  return typeof value === "string" ? value : "";
}
