import { createHash } from "node:crypto";

export const THREAD_KNOWLEDGE_EXTRACTOR_VERSION = "thread-knowledge/deterministic-v1";

const STOP_WORDS = new Set([
  "about", "after", "again", "also", "and", "are", "been", "before", "being", "but", "can", "could", "for", "from", "have", "into", "not", "that", "the", "their", "then", "this", "was", "were", "will", "with", "would",
  "그리고", "그러나", "대한", "위한", "에서", "으로", "있는", "한다", "합니다", "했다", "현재", "작업",
]);

function hash(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function itemText(item) {
  if (!item || typeof item !== "object") return "";
  if (typeof item.text === "string") return item.text;
  if (typeof item.output === "string") return item.output;
  if (typeof item.content === "string") return item.content;
  if (Array.isArray(item.content)) return item.content.map(itemText).filter(Boolean).join("\n");
  return "";
}

function turnText(turn) {
  return [turn?.input, turn?.prompt, turn?.output, ...(turn?.items ?? []).map(itemText)]
    .filter((value) => typeof value === "string" && value.trim()).join("\n");
}

function topicsFrom(texts, limit = 24) {
  const counts = new Map();
  for (const text of texts) {
    for (const token of text.toLowerCase().match(/[\p{L}\p{N}_-]{3,}/gu) ?? []) {
      if (STOP_WORDS.has(token) || /^\d+$/.test(token)) continue;
      counts.set(token, (counts.get(token) ?? 0) + 1);
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, limit).map(([topic]) => topic);
}

export class ThreadKnowledgeIndexer {
  constructor(registry, options = {}) {
    this.registry = registry;
    this.extractorVersion = options.extractorVersion ?? THREAD_KNOWLEDGE_EXTRACTOR_VERSION;
  }

  async index(control, options) {
    if (!options?.threadId) throw new TypeError("Thread knowledge indexing requires threadId");
    if (!control?.inspectAgent) throw Object.assign(new Error("The active App Server cannot read thread history"), { code: "THREAD_READ_UNAVAILABLE" });
    let result;
    try {
      result = await control.inspectAgent(options.threadId, { includeTurns: true });
    } catch (cause) {
      const error = new Error(`Cannot read requested thread ${options.threadId}: ${cause.message}`);
      error.code = "THREAD_KNOWLEDGE_READ_FAILED";
      error.category = "configuration";
      error.causeCode = "requested_thread_unavailable";
      error.repairable = true;
      error.nextAction = "Make the requested thread readable or remove it from requestedThreadIds, then create a new context revision.";
      error.threadId = options.threadId;
      throw error;
    }
    const thread = result?.thread ?? result;
    const turns = Array.isArray(thread?.turns) ? thread.turns : [];
    const texts = turns.map(turnText);
    const sourceDigest = hash(turns.map((turn, index) => ({
      id: turn?.id ?? `turn_${index}`, status: turn?.status?.type ?? turn?.status ?? null, text: texts[index],
    })));
    let projectId = options.projectId ?? null;
    if (!projectId && options.cwd) {
      try { projectId = this.registry.resolveProject(options.cwd).id; }
      catch (error) { if (error.code !== "PROJECT_PATH_UNRESOLVED") throw error; }
    }
    const snapshot = this.registry.upsertThreadKnowledgeSnapshot({
      threadId: options.threadId,
      throughTurnId: turns.at(-1)?.id ?? null,
      projectId,
      role: this.registry.getAgent(options.threadId)?.role ?? null,
      topics: topicsFrom(texts),
      sourceDigest,
      extractorVersion: this.extractorVersion,
      status: "current",
      metadata: { indexedOnDemand: true, turnCount: turns.length, contentRetained: false },
    });
    this.registry.recordEvent("thread_knowledge", snapshot.id, "thread_knowledge.indexed", {
      threadId: options.threadId, throughTurnId: snapshot.throughTurnId, topicCount: snapshot.topics.length,
    });
    return snapshot;
  }

  async indexMany(control, options = {}) {
    const snapshots = [];
    for (const threadId of [...new Set(options.threadIds ?? [])].sort()) {
      snapshots.push(await this.index(control, { ...options, threadId }));
    }
    return snapshots;
  }
}

export { topicsFrom as extractThreadTopics };
