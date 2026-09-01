#!/usr/bin/env node

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ControlPlaneDaemonClient } from "../src/daemon-client.js";
import { DAEMON_PROTOCOL_VERSION, RUNTIME_BUILD_ID } from "../src/build-info.js";
import { assertRuntimeHealth } from "./runtime-deployment.mjs";

function runtimeDigest(root) {
  const files = [];
  for (const entry of ["package.json", "src", "ui", "scripts"]) {
    const start = join(root, entry);
    if (!existsSync(start)) throw new Error(`Runtime input missing: ${start}`);
    const visit = (path) => {
      if (statSync(path).isDirectory()) for (const child of readdirSync(path).sort()) visit(join(path, child));
      else files.push(path);
    };
    visit(start);
  }
  const digest = createHash("sha256");
  for (const file of files.sort()) {
    digest.update(relative(root, file));
    digest.update(readFileSync(file));
  }
  return digest.digest("hex");
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

const source = resolve(argument("--source") ?? process.cwd());
const targetValue = argument("--target");
if (!targetValue) throw new Error("Usage: deploy-runtime.mjs --target <installed plugin runtime directory> [--source <repo>]");
const target = resolve(targetValue);
if (basename(target) !== "runtime" || target === source || !existsSync(join(source, "package.json"))) throw new Error(`Refusing unsafe runtime target: ${target}`);

const parent = dirname(target);
const staging = join(parent, `.runtime-staging-${randomUUID()}`);
const backup = join(parent, `.runtime-backup-${randomUUID()}`);
mkdirSync(staging, { recursive: true });
let swapped = false;
try {
  for (const root of ["src", "ui", "scripts"]) cpSync(join(source, root), join(staging, root), { recursive: true });
  cpSync(join(source, "package.json"), join(staging, "package.json"));
  const sourcePackage = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
  const stagedPackage = JSON.parse(readFileSync(join(staging, "package.json"), "utf8"));
  if (sourcePackage.version !== stagedPackage.version) throw new Error("Staged runtime package version mismatch");
  const sourceDigest = runtimeDigest(source);
  const stagedDigest = runtimeDigest(staging);
  if (sourceDigest !== stagedDigest) throw new Error("Staged runtime source digest mismatch");
  if (existsSync(target)) renameSync(target, backup);
  renameSync(staging, target);
  swapped = true;
  const client = new ControlPlaneDaemonClient({ daemonPath: join(target, "src", "daemon.js"), allowBuildHandover: true });
  await client.ensureStarted();
  const health = await client.health();
  assertRuntimeHealth(health, { runtimePath: join(target, "src", "daemon.js"), buildId: RUNTIME_BUILD_ID, protocolVersion: DAEMON_PROTOCOL_VERSION });
  rmSync(backup, { recursive: true, force: true });
  process.stdout.write(`${JSON.stringify({ deployed: true, target, version: stagedPackage.version, sourceDigest, health }, null, 2)}\n`);
} catch (error) {
  rmSync(staging, { recursive: true, force: true });
  if (swapped && existsSync(backup)) {
    rmSync(target, { recursive: true, force: true });
    renameSync(backup, target);
    try {
      const restoredInfoUrl = pathToFileURL(join(target, "src", "build-info.js"));
      restoredInfoUrl.searchParams.set("rollback", randomUUID());
      const restoredInfo = await import(restoredInfoUrl.href);
      const rollbackClient = new ControlPlaneDaemonClient({
        daemonPath: join(target, "src", "daemon.js"),
        expectedBuildId: restoredInfo.RUNTIME_BUILD_ID,
        expectedProtocolVersion: restoredInfo.DAEMON_PROTOCOL_VERSION,
        allowBuildHandover: true,
      });
      await rollbackClient.ensureStarted();
      const rollbackHealth = await rollbackClient.health();
      assertRuntimeHealth(rollbackHealth, {
        runtimePath: join(target, "src", "daemon.js"),
        buildId: restoredInfo.RUNTIME_BUILD_ID,
        protocolVersion: restoredInfo.DAEMON_PROTOCOL_VERSION,
      });
      error.rollbackHealth = rollbackHealth;
    } catch (rollbackError) {
      error.rollbackVerificationError = rollbackError;
      error.message = `${error.message}; rollback daemon verification failed: ${rollbackError.message}`;
    }
  }
  throw error;
}
