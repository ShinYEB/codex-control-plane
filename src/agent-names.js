export function roleIcon() {
  return "🤖";
}

export function agentDisplayName(role, title, prompt) {
  const subject = String(title || prompt || "작업").trim().replace(/\s+/g, " ").slice(0, 42);
  return `${roleIcon()} ${subject}`;
}

export function publicWorkName(name) {
  return String(name ?? "작업").replace(/^\[🤖[^\]]*\]\s*/, "");
}
