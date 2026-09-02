import { createHash, randomUUID } from "node:crypto";
import { TERMINAL_RUN_STATUSES, TERMINAL_TASK_STATUSES, TERMINAL_TURN_DISPATCH_STATUSES } from "./domain-states.js";

const hash = (value) => createHash("sha256").update(String(value ?? "")).digest("hex");

export function promptFingerprint(prompt) {
  return hash(String(prompt ?? "").replaceAll("\r\n", "\n"));
}

function turnStatus(turn) {
  return turn?.status?.type ?? turn?.status ?? null;
}

function turnPrompt(turn) {
  const messages = (turn?.items ?? []).filter((item) => ["userMessage", "user_message"].includes(item?.type));
  return messages.flatMap((item) => item.content ?? [])
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text).join("\n");
}

function turnOutput(turn) {
  if (typeof turn?.output === "string") return turn.output;
  return (turn?.items ?? [])
    .filter((item) => ["agentMessage", "agent_message"].includes(item?.type))
    .map((item) => item.text ?? item.content ?? "")
    .filter((value) => typeof value === "string")
    .join("\n");
}

function terminalState(status) {
  if (status === "completed") return "completed";
  if (status === "interrupted") return "interrupted";
  return "failed";
}

function dispatchError(message, code, details = {}) {
  return Object.assign(new Error(message), { code, ...details });
}

export class TurnDispatcher {
  constructor(options) {
    this.registry = options.registry;
    this.instanceId = options.instanceId ?? `dispatch_worker_${randomUUID()}`;
    this.leaseTtlMs = options.leaseTtlMs ?? 120_000;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 30 * 60_000;
  }

  prepare(options) {
    if (!options.prompt?.trim()) throw new TypeError("TurnDispatch prompt must not be empty");
    const fingerprint = promptFingerprint(options.prompt);
    const existing = this.registry.listTurnDispatches({
      subjectType: options.subjectType, subjectId: options.subjectId, purpose: options.purpose, limit: 200,
    });
    const matching = existing.find((entry) => entry.promptFingerprint === fingerprint);
    if (matching && options.revision === undefined) return matching;
    const revision = Number(options.revision ?? (existing.reduce((maximum, entry) => Math.max(maximum, entry.revision), 0) + 1));
    const submissionKey = options.submissionKey ?? hash([
      options.subjectType, options.subjectId, options.purpose, revision, fingerprint,
    ].join(":"));
    return this.registry.createTurnDispatch({
      id: options.id,
      subjectType: options.subjectType,
      subjectId: options.subjectId,
      purpose: options.purpose,
      revision,
      parentRunId: options.parentRunId,
      parentTaskId: options.parentTaskId,
      planId: options.planId,
      promptFingerprint: fingerprint,
      executionContractFingerprint: options.executionContractFingerprint,
      contextSnapshotId: options.contextSnapshotId,
      submissionKey,
      deadlineAt: options.deadlineAt ?? new Date(Date.now() + (options.timeoutMs ?? this.defaultTimeoutMs)).toISOString(),
      evidence: {
        promptRef: options.promptRef ?? null,
        allowTerminalParent: options.allowTerminalParent === true,
        settleAgentOnTerminal: options.settleAgentOnTerminal !== false,
      },
    });
  }

  beginThreadAcquisition(options) {
    let dispatch = this.prepare(options);
    if (TERMINAL_TURN_DISPATCH_STATUSES.has(dispatch.status)) return dispatch;
    dispatch = this.registry.claimTurnDispatch(dispatch.id, this.instanceId, this.leaseTtlMs);
    if (!dispatch) throw dispatchError("TurnDispatch is owned by another daemon writer", "TURN_DISPATCH_OWNED");
    this.#assertParent(dispatch);
    if (dispatch.status === "prepared") {
      dispatch = this.registry.transitionTurnDispatch(dispatch.id, "thread_acquiring", {}, {
        ownerToken: dispatch.ownerToken, cancellationGeneration: dispatch.cancellationGeneration,
      });
    }
    return dispatch;
  }

  async acquireThread(id, acquire, options = {}) {
    const dispatch = this.registry.getTurnDispatch(id);
    if (!dispatch || dispatch.status !== "thread_acquiring") {
      throw dispatchError(`TurnDispatch cannot acquire a thread from ${dispatch?.status ?? "missing"}`, "TURN_DISPATCH_STATE_INVALID", { dispatch });
    }
    const token = dispatch.ownerToken;
    const generation = dispatch.cancellationGeneration;
    this.#assertParent(dispatch);
    const agent = await acquire();
    const current = this.#fenced(id, token, generation);
    this.#assertParent(current);
    const bound = this.#transition(current, "thread_created", {
      threadId: agent.id, agentId: agent.id, threadAction: options.threadAction ?? (dispatch.threadId ? "resume" : "spawn"),
    }, token, generation);
    options.onThread?.({ dispatch: bound, agent });
    return agent;
  }

  failBeforeSubmission(id, error) {
    const dispatch = this.registry.getTurnDispatch(id);
    if (!dispatch || TERMINAL_TURN_DISPATCH_STATUSES.has(dispatch.status) || dispatch.status === "cancelling") return dispatch;
    return this.registry.transitionTurnDispatch(id, "failed", {
      failure: { category: "environment", code: error.code ?? "THREAD_ACQUISITION_FAILED", message: error.message, retryable: true, nextAction: "inspect_failure" },
      reconciliationDecision: "thread_acquisition_failed",
    }, { ownerToken: dispatch.ownerToken });
  }

  async execute(options) {
    let dispatch = this.prepare(options);
    if (dispatch.promptFingerprint !== promptFingerprint(options.prompt)) {
      throw dispatchError(`TurnDispatch ${dispatch.id} prompt fingerprint does not match revision ${dispatch.revision}`, "TURN_DISPATCH_PROMPT_MISMATCH");
    }
    if (TERMINAL_TURN_DISPATCH_STATUSES.has(dispatch.status)) {
      if (dispatch.status === "completed" && dispatch.evidence?.result) return dispatch.evidence.result;
      throw dispatchError(dispatch.failure?.message ?? `TurnDispatch is terminal: ${dispatch.status}`, "TURN_DISPATCH_TERMINAL", { dispatch });
    }
    dispatch = this.registry.claimTurnDispatch(dispatch.id, this.instanceId, this.leaseTtlMs);
    if (!dispatch) throw dispatchError("TurnDispatch is owned by another daemon writer", "TURN_DISPATCH_OWNED");
    const token = dispatch.ownerToken;
    const generation = dispatch.cancellationGeneration;
    let control = options.control;
    let agent = null;
    let heartbeat = null;
    try {
      this.#assertParent(dispatch);
      if (["prepared", "thread_acquiring"].includes(dispatch.status)) {
        if (dispatch.status === "prepared") dispatch = this.#transition(dispatch, "thread_acquiring", {}, token, generation);
        agent = await options.acquireThread(dispatch.threadId);
        dispatch = this.#fenced(dispatch.id, token, generation);
        this.#assertParent(dispatch);
        dispatch = this.#transition(dispatch, "thread_created", {
          threadId: agent.id,
          agentId: agent.id,
          threadAction: options.threadAction ?? (dispatch.threadId ? "resume" : "spawn"),
        }, token, generation);
        options.onThread?.({ dispatch, agent });
      } else {
        agent = options.agent ?? { id: dispatch.threadId };
      }
      if (dispatch.status === "thread_created") {
        this.#assertParent(dispatch);
        dispatch = this.#transition(dispatch, "turn_submitting", {}, token, generation);
      }
      if (dispatch.status === "turn_submitting" && dispatch.turnId) {
        dispatch = this.#transition(dispatch, "turn_running", { startedAt: dispatch.startedAt ?? new Date().toISOString() }, token, generation);
      }
      if (dispatch.status !== "turn_submitting" && dispatch.status !== "turn_running") {
        throw dispatchError(`TurnDispatch cannot execute from ${dispatch.status}`, "TURN_DISPATCH_STATE_INVALID", { dispatch });
      }
      this.#assertParent(dispatch);
      if (dispatch.status === "turn_running") {
        const reconciled = await this.reconcile(dispatch.id, control, { ownerToken: token });
        if (reconciled?.result) return reconciled.result;
        throw dispatchError("Existing Turn is still active; command was not resubmitted", "TURN_DISPATCH_ACTIVE", { dispatch: reconciled?.dispatch ?? dispatch, retryable: true });
      }
      heartbeat = setInterval(() => this.registry.heartbeatTurnDispatch(dispatch.id, this.instanceId, token, this.leaseTtlMs), 15_000);
      heartbeat.unref?.();
      const result = await control.runTask(dispatch.threadId, options.prompt, {
        ...(options.runOptions ?? {}),
        onStarted: (started) => {
          const current = this.#fenced(dispatch.id, token, generation);
          this.#assertParent(current);
          dispatch = this.#transition(current, "turn_running", {
            turnId: started.turnId,
            turnStatus: "running",
            startedAt: new Date().toISOString(),
          }, token, generation);
          if (dispatch.agentId && this.registry.getAgent(dispatch.agentId)) {
            this.registry.updateAgent(dispatch.agentId, { status: "running", metadata: { activeTurnDispatchId: dispatch.id } });
          }
          options.runOptions?.onStarted?.(started);
        },
      });
      const status = turnStatus(result.turn) ?? "completed";
      const state = terminalState(status);
      const current = this.#fenced(dispatch.id, token, generation);
      dispatch = this.#transition(current, state, {
        turnId: result.turnId ?? current.turnId,
        turnStatus: status,
        evidence: { result, completionMethod: result.completionMethod ?? null, outputFingerprint: hash(result.output ?? "") },
        ...(state === "completed" ? {} : { failure: { category: "coordination", code: `TURN_${status.toUpperCase()}`, message: result.turn?.error?.message ?? `Turn ${status}`, retryable: status === "interrupted" } }),
      }, token, generation);
      if (dispatch.evidence?.settleAgentOnTerminal !== false) this.#projectTerminalAgent(dispatch);
      options.onCompleted?.({ dispatch, result });
      return result;
    } catch (error) {
      const current = this.registry.getTurnDispatch(dispatch.id);
      if (current && !TERMINAL_TURN_DISPATCH_STATUSES.has(current.status)) {
        if (error.code === "TURN_DISPATCH_FENCED" || current.status === "cancelling") {
          const turnId = error.turnId ?? current.turnId;
          if (turnId && current.threadId) {
            try { await control?.interruptTask(current.threadId, turnId); } catch { /* reconciliation records uncertainty */ }
          }
          const latest = this.registry.getTurnDispatch(current.id);
          if (latest.status === "cancelling") this.registry.transitionTurnDispatch(latest.id, "cancelled", {
            turnId, turnStatus: "interrupted", reconciliationDecision: "cancel_fenced",
          });
        } else {
          const uncertain = error?.method === "turn/start" && /timed out/i.test(String(error.message));
          this.registry.transitionTurnDispatch(current.id, uncertain ? "recovery_attention" : "failed", {
            failure: {
              category: uncertain ? "coordination" : "environment",
              code: error.code ?? "TURN_DISPATCH_FAILED",
              message: error.message,
              retryable: !uncertain,
              nextAction: uncertain ? "reconcile_dispatch" : "inspect_failure",
            },
            reconciliationDecision: uncertain ? "submission_unknown" : null,
          }, { ownerToken: current.ownerToken });
        }
      }
      throw error;
    } finally {
      if (heartbeat) clearInterval(heartbeat);
    }
  }

  async reconcile(id, control, options = {}) {
    let dispatch = this.registry.getTurnDispatch(id);
    if (!dispatch?.threadId) return { dispatch, result: null };
    const response = await control.inspectAgent(dispatch.threadId, { includeTurns: true });
    const turns = response?.thread?.turns ?? response?.turns ?? [];
    let turn = dispatch.turnId ? turns.find((candidate) => candidate.id === dispatch.turnId) : null;
    if (!turn && dispatch.status === "turn_submitting") {
      turn = [...turns].reverse().find((candidate) => promptFingerprint(turnPrompt(candidate)) === dispatch.promptFingerprint) ?? null;
    }
    const status = turnStatus(turn);
    const terminal = ["completed", "failed", "interrupted"].includes(status);
    const changes = {
      lastProbeAt: new Date().toISOString(),
      probeCount: dispatch.probeCount + 1,
      ...(turn?.id ? { turnId: turn.id, turnStatus: status } : {}),
    };
    if (!terminal) {
      if (turn?.id && dispatch.status === "turn_submitting") {
        dispatch = this.registry.transitionTurnDispatch(id, "turn_running", {
          ...changes, startedAt: turn.startedAt ? new Date(Number(turn.startedAt) * 1000).toISOString() : dispatch.startedAt,
          reconciliationDecision: "existing_turn_bound",
        }, { ownerToken: options.ownerToken ?? dispatch.ownerToken });
      } else {
        dispatch = this.registry.transitionTurnDispatch(id, dispatch.status, { ...changes, reconciliationDecision: turn ? "turn_active" : "turn_not_observed" }, { ownerToken: options.ownerToken ?? dispatch.ownerToken });
      }
      return { dispatch, result: null };
    }
    const result = { threadId: dispatch.threadId, turnId: turn.id, turn: { ...turn, status }, output: turnOutput(turn), executionItems: turn.items ?? [], completionMethod: "thread/read-recovery", recoveredFromRead: true, evidenceComplete: true };
    const state = terminalState(status);
    dispatch = this.registry.transitionTurnDispatch(id, state, {
      ...changes, reconciliationDecision: "terminal_recovered",
      evidence: { result, completionMethod: result.completionMethod, outputFingerprint: hash(result.output) },
      ...(state === "completed" ? {} : { failure: { category: "coordination", code: `TURN_${status.toUpperCase()}`, message: `Turn ${status}`, retryable: status === "interrupted" } }),
    }, { ownerToken: options.ownerToken ?? dispatch.ownerToken });
    if (dispatch.evidence?.settleAgentOnTerminal !== false) this.#projectTerminalAgent(dispatch);
    return { dispatch, result };
  }

  #assertParent(dispatch) {
    if (dispatch.parentRunId) {
      const run = this.registry.getRun(dispatch.parentRunId);
      if (!run || (TERMINAL_RUN_STATUSES.has(run.status) && !dispatch.evidence?.allowTerminalParent)) throw dispatchError(`Parent Run is not active: ${dispatch.parentRunId}`, "TURN_DISPATCH_FENCED");
    }
    if (dispatch.parentTaskId) {
      const task = this.registry.getTask(dispatch.parentTaskId);
      if (!task || TERMINAL_TASK_STATUSES.has(task.status)) throw dispatchError(`Parent Task is not active: ${dispatch.parentTaskId}`, "TURN_DISPATCH_FENCED");
    }
    if (dispatch.planId) {
      const plan = this.registry.getPlan(dispatch.planId);
      if (!plan || ["failed"].includes(plan.status)) throw dispatchError(`Plan is not active: ${dispatch.planId}`, "TURN_DISPATCH_FENCED");
    }
  }

  #fenced(id, ownerToken, cancellationGeneration) {
    const dispatch = this.registry.getTurnDispatch(id);
    if (!dispatch || dispatch.ownerToken !== ownerToken || dispatch.cancellationGeneration !== cancellationGeneration || dispatch.status === "cancelling") {
      throw dispatchError(`TurnDispatch ownership or cancellation fence changed: ${id}`, "TURN_DISPATCH_FENCED", { dispatch });
    }
    return dispatch;
  }

  #transition(dispatch, status, changes, ownerToken, cancellationGeneration) {
    const next = this.registry.transitionTurnDispatch(dispatch.id, status, changes, { ownerToken, cancellationGeneration });
    if (!next) throw dispatchError(`TurnDispatch transition was fenced: ${dispatch.id}`, "TURN_DISPATCH_FENCED", { dispatch });
    return next;
  }

  #projectTerminalAgent(dispatch) {
    if (!dispatch?.agentId || !this.registry.getAgent(dispatch.agentId)) return;
    this.registry.updateAgent(dispatch.agentId, {
      status: "idle",
      metadata: { activeTurnDispatchId: null, lastTurnDispatchId: dispatch.id },
    });
  }
}
