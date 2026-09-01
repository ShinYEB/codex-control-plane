import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

function safeSegment(value) {
  return String(value ?? "task").toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "task";
}

export class WorktreeManager {
  constructor(registry, options = {}) {
    this.registry = registry;
    this.gitPath = options.gitPath ?? process.env.CODEX_GIT_BIN ?? "git";
    this.root = options.root ?? process.env.CODEX_CONTROL_WORKTREES ?? join(homedir(), ".codex", "control-plane", "worktrees");
    this.execFile = options.execFile ?? execFile;
    this.integrationQueues = new Map();
    this.integrationHook = options.integrationHook ?? null;
  }

  async inspectRepository(cwd) {
    const repoRoot = (await this.#git(["-C", cwd, "rev-parse", "--show-toplevel"])).trim();
    const head = (await this.#git(["-C", repoRoot, "rev-parse", "HEAD"])).trim();
    const status = (await this.#git(["-C", repoRoot, "status", "--porcelain"])).trim();
    return {
      repoRoot,
      head,
      dirty: Boolean(status),
      fingerprint: createHash("sha256").update(`${head}\n${status}`).digest("hex").slice(0, 20),
    };
  }

  async prepare(options) {
    if (!options?.taskId || !options?.cwd) throw new TypeError("taskId and cwd are required for a worktree");
    const id = `worktree_${options.taskId}`;
    const existing = this.registry.getManagedWorktree(id);
    if (existing && ["active", "retained", "quarantined"].includes(existing.status)) return existing;

    const repository = await this.inspectRepository(options.cwd);
    const repoRoot = repository.repoRoot;
    const repoKey = createHash("sha256").update(repoRoot).digest("hex").slice(0, 16);
    const segment = safeSegment(options.taskId);
    const path = join(this.root, repoKey, segment);
    const branch = options.branch ?? `codex/${segment}`;
    const head = repository.head;
    const baselineStatus = repository.dirty ? (await this.#git(["-C", repoRoot, "status", "--porcelain"])).trim() : "";
    const snapshotCommit = !options.baseRef && baselineStatus && options.captureDirtySnapshot !== false
      ? await this.#snapshotCommit(repoRoot, head, `control-plane baseline for ${options.taskId}`)
      : null;
    const baseRef = options.baseRef ?? snapshotCommit ?? head;
    mkdirSync(join(this.root, repoKey), { recursive: true });
    if (existsSync(path)) {
      if (!existing) throw new Error(`Unmanaged worktree path already exists: ${path}`);
      try {
        const inside = (await this.#git(["-C", path, "rev-parse", "--is-inside-work-tree"])).trim();
        if (inside === "true") {
          const recovered = this.registry.upsertManagedWorktree({ ...existing, id, repoRoot, path, branch, baseRef, status: "active", ownerTaskId: options.taskId, metadata: { ...existing.metadata, recovered: true } });
          this.registry.recordEvent("worktree", id, "worktree.recovered", { taskId: options.taskId, path, branch, source: "existing_path" });
          return recovered;
        }
      } catch {
        // A stale non-worktree path must never be overwritten automatically.
      }
      throw new Error(`Managed worktree path exists but is not reusable: ${path}`);
    }

    this.registry.upsertManagedWorktree({ id, repoRoot, path, branch, baseRef, status: "creating", ownerTaskId: options.taskId });
    try {
      const branchExists = await this.#branchExists(repoRoot, branch);
      await this.#git(branchExists
        ? ["-C", repoRoot, "worktree", "add", path, branch]
        : ["-C", repoRoot, "worktree", "add", "-b", branch, path, baseRef]);
      const worktree = this.registry.upsertManagedWorktree({
        id, repoRoot, path, branch, baseRef, status: "active", ownerTaskId: options.taskId,
        metadata: { baseline: { head, dirty: Boolean(baselineStatus), status: baselineStatus, snapshotCommit, fingerprint: repository.fingerprint } },
      });
      this.registry.recordEvent("worktree", id, branchExists ? "worktree.reattached" : "worktree.created", { taskId: options.taskId, repoRoot, path, branch, baseRef });
      return worktree;
    } catch (error) {
      this.registry.upsertManagedWorktree({ id, repoRoot, path, branch, baseRef, status: "failed", ownerTaskId: options.taskId, metadata: { error: error.message } });
      this.registry.recordEvent("worktree", id, "worktree.failed", { taskId: options.taskId, error: error.message });
      throw error;
    }
  }

  async cleanup(worktreeId) {
    const worktree = this.registry.getManagedWorktree(worktreeId);
    if (!worktree) throw new Error(`Managed worktree not found: ${worktreeId}`);
    if (worktree.status === "removed") return worktree;
    let changes;
    try {
      changes = (await this.#git(["-C", worktree.path, "status", "--porcelain"])).trim();
    } catch (error) {
      return this.#quarantine(worktree, `Unable to inspect worktree: ${error.message}`);
    }
    if (changes && worktree.status !== "integrated") {
      const retained = this.registry.upsertManagedWorktree({ ...worktree, status: "retained", metadata: { ...worktree.metadata, reason: "uncommitted changes", changes } });
      this.registry.recordEvent("worktree", worktreeId, "worktree.retained", { reason: "uncommitted changes" });
      return retained;
    }
    try {
      await this.#git(["-C", worktree.repoRoot, "worktree", "remove", ...(worktree.status === "integrated" ? ["--force"] : []), worktree.path]);
      await this.#git(["-C", worktree.repoRoot, "worktree", "prune"]);
      const removed = this.registry.upsertManagedWorktree({ ...worktree, status: "removed", removedAt: new Date().toISOString() });
      this.registry.recordEvent("worktree", worktreeId, "worktree.removed", { path: worktree.path });
      return removed;
    } catch (error) {
      return this.#quarantine(worktree, `Cleanup failed: ${error.message}`);
    }
  }

  async status(worktreeId) {
    const worktree = this.registry.getManagedWorktree(worktreeId);
    if (!worktree) throw new Error(`Managed worktree not found: ${worktreeId}`);
    if (["removed", "failed"].includes(worktree.status)) return { worktree, changes: null };
    try {
      const changes = (await this.#git(["-C", worktree.path, "status", "--porcelain"])).trim();
      return { worktree, changes };
    } catch (error) {
      return { worktree: this.#quarantine(worktree, error.message), changes: null };
    }
  }

  async finalize(worktreeId) {
    const worktree = this.registry.getManagedWorktree(worktreeId);
    if (!worktree) throw new Error(`Managed worktree not found: ${worktreeId}`);
    const changes = (await this.#git(["-C", worktree.path, "status", "--porcelain"])).trim();
    if (!changes) {
      const clean = this.registry.upsertManagedWorktree({ ...worktree, metadata: { ...worktree.metadata, artifact: { changed: false, baseRef: worktree.baseRef } } });
      return clean.metadata.artifact;
    }
    const commit = await this.#snapshotCommit(worktree.path, worktree.baseRef, `control-plane artifact for ${worktree.ownerTaskId}`);
    const patch = await this.#git(["-C", worktree.path, "diff", "--binary", worktree.baseRef, commit]);
    const artifactRoot = join(this.root, "artifacts");
    mkdirSync(artifactRoot, { recursive: true });
    const patchPath = join(artifactRoot, `${safeSegment(worktree.ownerTaskId)}.patch`);
    writeFileSync(patchPath, patch, { mode: 0o600 });
    const artifact = { changed: true, baseRef: worktree.baseRef, commit, patchPath, changes };
    this.registry.upsertManagedWorktree({ ...worktree, status: "artifact_ready", metadata: { ...worktree.metadata, artifact } });
    this.registry.recordEvent("worktree", worktree.id, "worktree.artifact_ready", { commit, patchPath });
    return artifact;
  }

  async integrate(worktreeId, options = {}) {
    const worktree = this.registry.getManagedWorktree(worktreeId);
    if (!worktree) throw new Error(`Managed worktree not found: ${worktreeId}`);
    const previous = this.integrationQueues.get(worktree.repoRoot) ?? Promise.resolve();
    const operation = previous.catch(() => {}).then(() => this.#integrate(worktreeId, options));
    this.integrationQueues.set(worktree.repoRoot, operation);
    try {
      return await operation;
    } finally {
      if (this.integrationQueues.get(worktree.repoRoot) === operation) this.integrationQueues.delete(worktree.repoRoot);
    }
  }

  async #integrate(worktreeId, options = {}) {
    const worktree = this.registry.getManagedWorktree(worktreeId);
    if (!worktree) throw new Error(`Managed worktree not found: ${worktreeId}`);
    const artifact = worktree.metadata?.artifact ?? await this.finalize(worktreeId);
    if (!artifact.changed) {
      this.registry.upsertManagedWorktree({ ...worktree, status: "integrated", metadata: { ...worktree.metadata, artifact, integratedAt: new Date().toISOString() } });
      return { status: "integrated", artifact };
    }
    const strategy = options.strategy ?? "patch";
    const journal = this.registry.prepareIntegrationJournal({
      worktreeId,
      taskId: worktree.ownerTaskId,
      repoRoot: worktree.repoRoot,
      strategy,
      artifact,
    });
    try {
      if (journal.status === "recorded") return { status: "integrated", strategy, artifact, recovered: true, journalId: journal.id };
      if (["applying", "applied"].includes(journal.status)) {
        const applied = journal.status === "applied" || await this.#isArtifactApplied(worktree.repoRoot, artifact);
        if (applied) {
          if (journal.status === "applying") this.registry.transitionIntegrationJournal(journal.id, "applied", { evidence: { detectedAfterRestart: true } });
          return this.#recordIntegration(worktree, artifact, strategy, journal.id, { recovered: true });
        }
        this.registry.transitionIntegrationJournal(journal.id, "prepared", { lastError: "Previous applying stage left no applied patch" });
      }
      this.registry.transitionIntegrationJournal(journal.id, "applying");
      await this.#integrationCheckpoint("applying", { journalId: journal.id, worktreeId });
      if (strategy === "commit") {
        const dirty = (await this.#git(["-C", worktree.repoRoot, "status", "--porcelain"])).trim();
        if (dirty) throw Object.assign(new Error("Commit integration requires a clean main workspace; use patch integration for a dirty baseline"), { code: "WORKSPACE_COMMIT_REQUIRES_CLEAN" });
        await this.#git(["-C", worktree.repoRoot, "apply", "--check", artifact.patchPath]);
        try {
          await this.#git(["-C", worktree.repoRoot, "cherry-pick", artifact.commit]);
        } catch (error) {
          try { await this.#git(["-C", worktree.repoRoot, "cherry-pick", "--abort"]); } catch { /* artifact remains recoverable */ }
          throw error;
        }
      } else if (strategy === "patch") {
        await this.#git(["-C", worktree.repoRoot, "apply", "--check", artifact.patchPath]);
        await this.#git(["-C", worktree.repoRoot, "apply", artifact.patchPath]);
      } else {
        throw new Error(`Unsupported integration strategy: ${strategy}`);
      }
      this.registry.transitionIntegrationJournal(journal.id, "applied", { evidence: { patchReverseCheck: true } });
      await this.#integrationCheckpoint("applied", { journalId: journal.id, worktreeId });
      return this.#recordIntegration(worktree, artifact, strategy, journal.id);
    } catch (error) {
      if (error?.code === "INTEGRATION_CRASH_SIMULATED") throw error;
      this.registry.upsertManagedWorktree({ ...worktree, status: "integration_blocked", metadata: { ...worktree.metadata, artifact, integrationError: error.message } });
      this.registry.recordEvent("worktree", worktree.id, "worktree.integration_blocked", { error: error.message, patchPath: artifact.patchPath });
      throw Object.assign(new Error(`Worktree integration blocked: ${error.message}`), { code: "WORKSPACE_INTEGRATION_CONFLICT", retryable: false, artifact });
    }
  }

  async recoverPendingIntegrations() {
    const pending = this.registry.listIntegrationJournals({ pending: true, limit: 100 });
    const results = [];
    for (const journal of pending) {
      try {
        results.push(await this.integrate(journal.worktreeId, { strategy: journal.strategy }));
      } catch (error) {
        results.push({ status: "integration_blocked", journalId: journal.id, error: error.message });
      }
    }
    return results;
  }

  async #recordIntegration(worktree, artifact, strategy, journalId, extra = {}) {
    const integratedAt = new Date().toISOString();
    this.registry.upsertManagedWorktree({ ...worktree, status: "integrated", metadata: { ...worktree.metadata, artifact, strategy, integratedAt, integrationJournalId: journalId } });
    await this.#integrationCheckpoint("recording", { journalId, worktreeId: worktree.id });
    this.registry.transitionIntegrationJournal(journalId, "recorded", { evidence: { ...extra, recordedAt: integratedAt } });
    this.registry.recordEvent("worktree", worktree.id, "worktree.integrated", { strategy, commit: artifact.commit, patchPath: artifact.patchPath, journalId, ...extra });
    return { status: "integrated", strategy, artifact, integratedAt, journalId, ...extra };
  }

  async #isArtifactApplied(repoRoot, artifact) {
    if (!artifact?.changed || !artifact.patchPath) return true;
    try {
      await this.#git(["-C", repoRoot, "apply", "--reverse", "--check", artifact.patchPath]);
      return true;
    } catch {
      return false;
    }
  }

  async #integrationCheckpoint(stage, details) {
    if (this.integrationHook) await this.integrationHook(stage, details);
  }

  async recover(worktreeId, action = "inspect", options = {}) {
    const worktree = this.registry.getManagedWorktree(worktreeId);
    if (!worktree) throw new Error(`Managed worktree not found: ${worktreeId}`);
    if (action === "inspect") return this.status(worktreeId);
    if (action === "finalize") return { worktree: this.registry.getManagedWorktree(worktreeId), artifact: await this.finalize(worktreeId) };
    if (action === "integrate") return this.integrate(worktreeId, { strategy: options.strategy ?? worktree.metadata?.strategy ?? "patch" });
    if (action === "cleanup") return this.cleanup(worktreeId);
    if (action === "quarantine") return this.#quarantine(worktree, options.reason ?? "Manually quarantined for recovery");
    throw new Error(`Unsupported worktree recovery action: ${action}`);
  }

  #quarantine(worktree, reason) {
    const quarantined = this.registry.upsertManagedWorktree({ ...worktree, status: "quarantined", metadata: { ...worktree.metadata, reason } });
    this.registry.recordEvent("worktree", worktree.id, "worktree.quarantined", { reason });
    return quarantined;
  }

  async #git(args, options = {}) {
    const result = await this.execFile(this.gitPath, args, { maxBuffer: 10 * 1024 * 1024, ...options });
    return typeof result === "string" ? result : result.stdout ?? "";
  }

  async #snapshotCommit(repoRoot, parent, message) {
    const temporary = mkdtempSync(join(tmpdir(), "codex-control-index-"));
    const indexPath = join(temporary, "index");
    const env = { ...process.env, GIT_INDEX_FILE: indexPath };
    try {
      await this.#git(["-C", repoRoot, "read-tree", parent], { env });
      await this.#git(["-C", repoRoot, "add", "-A"], { env });
      const tree = (await this.#git(["-C", repoRoot, "write-tree"], { env })).trim();
      return (await this.#git(["-C", repoRoot, "commit-tree", tree, "-p", parent, "-m", message], { env })).trim();
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }

  async #branchExists(repoRoot, branch) {
    try {
      await this.#git(["-C", repoRoot, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
      return true;
    } catch {
      return false;
    }
  }
}
