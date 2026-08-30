export function roleIcon() {
  return "🤖";
}

export function agentDisplayName(role, title, prompt) {
  const label = String(role || "agent").trim().replace(/\s+/g, " ");
  const subject = String(title || prompt || "작업").trim().replace(/\s+/g, " ").slice(0, 42);
  return `[${roleIcon(label)} ${label}] ${subject}`;
}
