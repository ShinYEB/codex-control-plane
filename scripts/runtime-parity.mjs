#!/usr/bin/env node

import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function files(root, relative = "") {
  const directory = join(root, relative);
  if (!existsSync(directory)) return [];
  return readdirSync(directory).flatMap((name) => {
    const child = join(relative, name);
    return statSync(join(root, child)).isDirectory() ? files(root, child) : [child];
  }).sort();
}

function digest(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

const source = resolve(argument("--source") ?? process.cwd());
const target = argument("--target") ? resolve(argument("--target")) : null;
const write = process.argv.includes("--write");
if (!target) throw new Error("Usage: runtime-parity.mjs --target <plugin runtime directory> [--source <repo>] [--write]");

const roots = ["src", "ui", "scripts"];
const sourceFiles = [...roots.flatMap((root) => files(join(source, root)).map((path) => join(root, path))), "package.json"].sort();
if (write) {
  for (const root of roots) {
    rmSync(join(target, root), { recursive: true, force: true });
    mkdirSync(join(target, root), { recursive: true });
    cpSync(join(source, root), join(target, root), { recursive: true });
  }
  cpSync(join(source, "package.json"), join(target, "package.json"));
}

const targetFiles = [...roots.flatMap((root) => files(join(target, root)).map((path) => join(root, path))), ...(existsSync(join(target, "package.json")) ? ["package.json"] : [])].sort();
const missing = sourceFiles.filter((file) => !targetFiles.includes(file));
const extra = targetFiles.filter((file) => !sourceFiles.includes(file));
const changed = sourceFiles.filter((file) => targetFiles.includes(file) && digest(join(source, file)) !== digest(join(target, file)));
const result = { source, target, mode: write ? "sync-and-verify" : "verify", sourceName: basename(source), missing, extra, changed, identical: !missing.length && !extra.length && !changed.length };
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (!result.identical) process.exitCode = 1;
