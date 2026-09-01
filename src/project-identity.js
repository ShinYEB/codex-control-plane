import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

export const PROJECT_IDENTITY_VERSION = 1;

function digest(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

function canonicalPath(path) {
  const resolved = realpathSync(path);
  if (!statSync(resolved).isDirectory()) {
    throw Object.assign(new Error(`Project path is not a directory: ${path}`), {
      code: "PROJECT_PATH_NOT_DIRECTORY",
    });
  }
  return resolved;
}

function defaultGit(args, options = {}) {
  return execFileSync(options.gitPath ?? process.env.CODEX_GIT_BIN ?? "git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

export function canonicalizeProjectIdentity(cwd, options = {}) {
  if (typeof cwd !== "string" || !cwd.trim()) {
    throw Object.assign(new TypeError("Project cwd must be a non-empty string"), {
      code: "PROJECT_CWD_REQUIRED",
    });
  }

  let requestedPath;
  try {
    requestedPath = canonicalPath(cwd);
  } catch (error) {
    if (error.code?.startsWith?.("PROJECT_")) throw error;
    throw Object.assign(new Error(`Cannot canonicalize project path ${cwd}: ${error.message}`), {
      code: "PROJECT_PATH_UNRESOLVED",
      cause: error,
    });
  }

  const runGit = options.runGit ?? ((args) => defaultGit(args, options));
  try {
    const workspaceRoot = canonicalPath(runGit(["-C", requestedPath, "rev-parse", "--show-toplevel"]));
    const commonDirValue = runGit(["-C", requestedPath, "rev-parse", "--git-common-dir"]);
    const commonDir = canonicalPath(isAbsolute(commonDirValue) ? commonDirValue : resolve(requestedPath, commonDirValue));
    const canonicalKey = `git:v${PROJECT_IDENTITY_VERSION}:${digest(commonDir)}`;
    return {
      id: `project_${digest(canonicalKey)}`,
      canonicalKey,
      kind: "git",
      canonicalRoot: workspaceRoot,
      repositoryCommonDir: commonDir,
      requestedPath,
      identityVersion: PROJECT_IDENTITY_VERSION,
    };
  } catch (error) {
    const stderr = String(error?.stderr ?? "");
    const notRepository = error?.status === 128 || /not a git repository/i.test(`${error.message}\n${stderr}`);
    if (!notRepository && !options.allowGitFailureFallback) {
      throw Object.assign(new Error(`Cannot inspect Git project identity for ${cwd}: ${error.message}`), {
        code: "PROJECT_GIT_IDENTITY_FAILED",
        cause: error,
      });
    }
  }

  const canonicalKey = `directory:v${PROJECT_IDENTITY_VERSION}:${digest(requestedPath)}`;
  return {
    id: `project_${digest(canonicalKey)}`,
    canonicalKey,
    kind: "directory",
    canonicalRoot: requestedPath,
    repositoryCommonDir: null,
    requestedPath,
    identityVersion: PROJECT_IDENTITY_VERSION,
  };
}

