import assert from "node:assert/strict";
import test from "node:test";

import { ControlRegistry } from "../src/registry.js";
import { ThreadKnowledgeIndexer } from "../src/thread-knowledge-indexer.js";

test("on-demand thread indexing stores only digest, topics, and source range", async () => {
  const registry = new ControlRegistry({ path: ":memory:" });
  try {
    const control = { inspectAgent: async () => ({ thread: { turns: [
      { id: "turn_1", status: "completed", prompt: "Implement billing contract", output: "Billing API contract uses version two" },
      { id: "turn_2", status: "completed", items: [{ type: "agentMessage", text: "Billing validation passed" }] },
    ] } }) };
    const indexer = new ThreadKnowledgeIndexer(registry);
    const first = await indexer.index(control, { threadId: "thread_billing" });
    const repeated = await indexer.index(control, { threadId: "thread_billing" });
    assert.equal(repeated.id, first.id);
    assert.equal(first.throughTurnId, "turn_2");
    assert.ok(first.topics.includes("billing"));
    assert.equal(first.metadata.contentRetained, false);
    assert.doesNotMatch(JSON.stringify(first), /Billing API contract uses version two/);
    assert.equal(registry.listContextClaims().length, 0);
  } finally {
    registry.close();
  }
});

test("requested thread read failure is structured and never fabricates knowledge", async () => {
  const registry = new ControlRegistry({ path: ":memory:" });
  try {
    const indexer = new ThreadKnowledgeIndexer(registry);
    await assert.rejects(
      () => indexer.index({ inspectAgent: async () => { throw new Error("not found"); } }, { threadId: "missing" }),
      (error) => error.code === "THREAD_KNOWLEDGE_READ_FAILED" && error.causeCode === "requested_thread_unavailable" && error.repairable,
    );
    assert.deepEqual(registry.listThreadKnowledgeSnapshots(), []);
  } finally {
    registry.close();
  }
});
