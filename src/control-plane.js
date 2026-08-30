const TERMINAL_TURN_STATUSES = new Set(["completed", "failed", "interrupted"]);

function terminalTurnFromRead(result, turnId) {
  const thread = result?.thread ?? result;
  const turns = thread?.turns ?? result?.turns ?? [];
  const turn = turns.find((entry) => entry?.id === turnId);
  const status = turn?.status?.type ?? turn?.status;
  return TERMINAL_TURN_STATUSES.has(status) ? { ...turn, status } : null;
}

function recoveredOutput(turn) {
  if (typeof turn?.output === "string") return turn.output;
  const items = turn?.items ?? [];
  return items
    .filter((item) => ["agentMessage", "agent_message"].includes(item?.type))
    .map((item) => item.text ?? item.content ?? "")
    .filter((value) => typeof value === "string")
    .join("\n");
}

export class CodexControlPlane {
  constructor(client, options = {}) {
    this.client = client;
    this.resumeFlights = new Map();
    this.resumeRetryDelaysMs = options.resumeRetryDelaysMs ?? [100, 300, 750];
    this.delay = options.delay ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async connect() {
    await this.client.connect();
  }

  async listAgents(options = {}) {
    const result = await this.client.request("thread/list", {
      limit: options.limit ?? 20,
      sortKey: options.sortKey ?? "recency_at",
      sortDirection: options.sortDirection ?? "desc",
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.archived !== undefined ? { archived: options.archived } : {}),
      sourceKinds: options.sourceKinds ?? [
        "cli",
        "vscode",
        "appServer",
        "subAgent",
        "subAgentReview",
        "subAgentThreadSpawn",
        "subAgentOther",
      ],
      ...(options.cursor ? { cursor: options.cursor } : {}),
    });

    return {
      agents: (result.data ?? []).map((thread) => this.#toAgent(thread)),
      nextCursor: result.nextCursor ?? null,
    };
  }

  async nameAgent(threadId, name) {
    if (!name?.trim()) throw new TypeError("Agent name must not be empty");
    await this.client.request("thread/name/set", { threadId, name: name.trim() });
    return { threadId, name: name.trim() };
  }

  async pinAgent(threadId, isPinned = true) {
    const result = await this.client.request("thread/metadata/update", { threadId, isPinned });
    return result.thread ?? result;
  }

  async archiveAgent(threadId) {
    const result = await this.client.request("thread/archive", { threadId });
    return result.thread ?? result;
  }

  async unarchiveAgent(threadId) {
    const result = await this.client.request("thread/unarchive", { threadId });
    return result.thread ?? result;
  }

  async spawnAgent(options = {}) {
    const result = await this.client.request("thread/start", {
      cwd: options.cwd ?? process.cwd(),
      approvalPolicy: options.approvalPolicy ?? "never",
      sandbox: options.sandbox ?? "read-only",
      serviceName: "codex_control_plane",
      ...(options.model ? { model: options.model } : {}),
      ...(options.developerInstructions ? { developerInstructions: options.developerInstructions } : {}),
      ...(options.ephemeral !== undefined ? { ephemeral: options.ephemeral } : {}),
    });
    return this.#toAgent(result.thread, result.instructionSources);
  }

  async resumeAgent(threadId, options = {}) {
    if (this.resumeFlights.has(threadId)) return this.resumeFlights.get(threadId);
    const flight = this.#resumeWithOwnershipRetry(threadId, options).finally(() => {
      if (this.resumeFlights.get(threadId) === flight) this.resumeFlights.delete(threadId);
    });
    this.resumeFlights.set(threadId, flight);
    return flight;
  }

  async #resumeWithOwnershipRetry(threadId, options) {
    const params = {
      threadId,
      excludeTurns: true,
      ...(options.model ? { model: options.model } : {}),
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.sandbox ? { sandbox: options.sandbox } : {}),
      ...(options.approvalPolicy ? { approvalPolicy: options.approvalPolicy } : {}),
    };
    let ownershipError;
    for (let attempt = 0; attempt <= this.resumeRetryDelaysMs.length; attempt += 1) {
      try {
        const result = await this.client.request("thread/resume", params);
        return this.#toAgent(result.thread, result.instructionSources);
      } catch (error) {
        if (!isActiveWriterError(error)) throw error;
        ownershipError = error;
        if (attempt === this.resumeRetryDelaysMs.length) break;
        await this.delay(this.resumeRetryDelaysMs[attempt]);
      }
    }
    const error = new Error(`Codex thread ${threadId} is owned by another active App Server writer; close or release it there, then retry`);
    error.name = "ThreadOwnershipError";
    error.code = "THREAD_ACTIVE_WRITER";
    error.method = "thread/resume";
    error.cause = ownershipError;
    error.retryable = true;
    error.threadId = threadId;
    throw error;
  }

  async forkAgent(threadId, options = {}) {
    const result = await this.client.request("thread/fork", {
      threadId,
      ...(options.lastTurnId ? { lastTurnId: options.lastTurnId } : {}),
      ...(options.ephemeral !== undefined ? { ephemeral: options.ephemeral } : {}),
      ...(options.model ? { model: options.model } : {}),
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.sandbox ? { sandbox: options.sandbox } : {}),
      ...(options.approvalPolicy ? { approvalPolicy: options.approvalPolicy } : {}),
    });
    return this.#toAgent(result.thread, result.instructionSources);
  }

  async inspectAgent(threadId, options = {}) {
    return this.client.request("thread/read", {
      threadId,
      includeTurns: options.includeTurns ?? false,
    });
  }

  async runTask(threadId, prompt, options = {}) {
    if (!prompt?.trim()) throw new TypeError("Task prompt must not be empty");

    let output = "";
    const observedItems = [];
    const onDelta = (params) => {
      if (params.threadId === threadId && typeof params.delta === "string") output += params.delta;
    };
    const onItemCompleted = (params) => {
      if (params?.threadId === threadId && params.item) observedItems.push({ turnId: params.turnId ?? null, item: params.item });
    };
    this.client.on("item/agentMessage/delta", onDelta);
    this.client.on("item/completed", onItemCompleted);

    try {
      const result = await this.client.request("turn/start", {
        threadId,
        input: [{ type: "text", text: prompt }],
        ...(options.cwd ? { cwd: options.cwd } : {}),
        ...(options.model ? { model: options.model } : {}),
        ...(options.effort ? { effort: options.effort } : {}),
        ...(options.approvalPolicy ? { approvalPolicy: options.approvalPolicy } : {}),
        ...(options.outputSchema ? { outputSchema: options.outputSchema } : {}),
      });
      const turnId = result.turn.id;
      options.onStarted?.({ threadId, turnId, turn: result.turn });
      let completion;
      const timeoutMs = options.timeoutMs ?? this.client.turnTimeoutMs ?? 30 * 60_000;
      const deadline = Date.now() + timeoutMs;
      const recoveryProbeMs = Math.min(options.recoveryProbeMs ?? 15_000, timeoutMs);
      while (!completion) {
        try {
          completion = await this.client.waitForNotification(
            (message) => {
              if (["turn/completed", "turn/failed", "turn/interrupted"].includes(message.method)) {
                return message.params?.threadId === threadId && message.params?.turn?.id === turnId;
              }
              return message.method === "error" && message.params?.threadId === threadId && message.params?.turnId === turnId;
            },
            Math.max(1, Math.min(recoveryProbeMs, deadline - Date.now())),
          );
        } catch (error) {
          if (!/Timed out waiting for app-server notification/i.test(String(error?.message ?? ""))) throw error;
          const recoveredTurn = terminalTurnFromRead(await this.inspectAgent(threadId, { includeTurns: true }), turnId);
          if (recoveredTurn) {
            const recovered = {
              threadId,
              turnId,
              output: output || recoveredOutput(recoveredTurn),
              turn: recoveredTurn,
              executionItems: recoveredTurn.items ?? [],
              completionMethod: "thread/read-recovery",
              recoveredFromRead: true,
            };
            options.onCompleted?.(recovered);
            return recovered;
          }
          if (Date.now() >= deadline) throw error;
        }
      }
      if (completion.method === "error") {
        throw new Error(completion.params?.error?.message ?? completion.params?.error ?? "Codex App Server turn failed");
      }
      const notificationStatus = completion.method.slice("turn/".length);
      const turn = {
        ...(completion.params.turn ?? {}),
        status: completion.params.turn?.status ?? notificationStatus,
        ...(completion.params.error && !completion.params.turn?.error ? { error: completion.params.error } : {}),
      };
      const executionItems = observedItems.filter((entry) => !entry.turnId || entry.turnId === turnId).map((entry) => entry.item);
      const completed = { threadId, turnId, output, turn, executionItems, completionMethod: completion.method };
      options.onCompleted?.(completed);
      return completed;
    } finally {
      this.client.off("item/agentMessage/delta", onDelta);
      this.client.off("item/completed", onItemCompleted);
    }
  }

  async interruptTask(threadId, turnId) {
    return this.client.request("turn/interrupt", { threadId, turnId });
  }

  #toAgent(thread, instructionSources = []) {
    return {
      id: thread.id,
      sessionId: thread.sessionId ?? thread.id,
      name: thread.name ?? null,
      cwd: thread.cwd ?? null,
      model: thread.model ?? null,
      provider: "codex",
      status: thread.status?.type ?? thread.status ?? "unknown",
      source: thread.source ?? thread.sourceKind ?? null,
      ephemeral: thread.ephemeral ?? false,
      forkedFromId: thread.forkedFromId ?? null,
      createdAt: thread.createdAt ?? null,
      updatedAt: thread.updatedAt ?? null,
      archivedAt: thread.archivedAt ?? null,
      instructionSources,
    };
  }
}

export function isActiveWriterError(error) {
  return error?.method === "thread/resume"
    && /already has an active writer|active elsewhere|owned by another.*writer/i.test(String(error?.message ?? ""));
}
