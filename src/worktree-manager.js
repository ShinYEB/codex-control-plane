import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
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
  }

  async prepare(options) {
    if (!options?.taskId || !options?.cwd) throw new TypeError("taskId and cwd are required for a worktree");
    const id = `worktree_${options.taskId}`;
    const existing = this.registry.getManagedWorktree(id);
    if (existing && ["active", "retained", "quarantined"].includes(existing.status)) return existing;

    const repoRoot = (await this.#git(["-C", options.cwd, "rev-parse", "--show-toplevel"])).trim();
    const repoKey = createHash("sha256").update(repoRoot).digest("hex").slice(0, 16);
    const segment = safeSegment(options.taskId);
    const path = join(this.root, repoKey, segment);
    const branch = options.branch ?? `codex/${segment}`;
    const baseRef = options.baseRef ?? "HEAD";
    mkdirSync(join(this.root, repoKey), { recursive: true });
    if (existsSync(path) && !existing) throw new Error(`Unmanaged worktree path already exists: ${path}`);

    this.registry.upsertManagedWorktree({ id, repoRoot, path, branch, baseRef, status: "creating", ownerTaskId: options.taskId });
    try {
      await this.#git(["-C", repoRoot, "worktree", "add", "-b", branch, path, baseRef]);
      const worktree = this.registry.upsertManagedWorktree({ id, repoRoot, path, branch, baseRef, status: "active", ownerTaskId: options.taskId });
      this.registry.recordEvent("worktree", id, "worktree.created", { taskId: options.taskId, repoRoot, path, branch, baseRef });
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
    if (changes) {
      const retained = this.registry.upsertManagedWorktree({ ...worktree, status: "retained", metadata: { ...worktree.metadata, reason: "uncommitted changes", changes } });
      this.registry.recordEvent("worktree", worktreeId, "worktree.retained", { reason: "uncommitted changes" });
      return retained;
    }
    try {
      await this.#git(["-C", worktree.repoRoot, "worktree", "remove", worktree.path]);
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

  #quarantine(worktree, reason) {
    const quarantined = this.registry.upsertManagedWorktree({ ...worktree, status: "quarantined", metadata: { ...worktree.metadata, reason } });
    this.registry.recordEvent("worktree", worktree.id, "worktree.quarantined", { reason });
    return quarantined;
  }

  async #git(args) {
    const result = await this.execFile(this.gitPath, args, { maxBuffer: 10 * 1024 * 1024 });
    return typeof result === "string" ? result : result.stdout ?? "";
  }
}
