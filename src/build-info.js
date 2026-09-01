import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

export const DAEMON_PROTOCOL_VERSION = 2;

const runtimeRoot = fileURLToPath(new URL("..", import.meta.url));
const packageJson = JSON.parse(readFileSync(join(runtimeRoot, "package.json"), "utf8"));
function runtimeFiles(path) {
  return readdirSync(path).flatMap((name) => {
    const child = join(path, name);
    return statSync(child).isDirectory() ? runtimeFiles(child) : [child];
  });
}
const buildInputs = [join(runtimeRoot, "package.json"), ...["src", "ui", "scripts"].flatMap((root) => runtimeFiles(join(runtimeRoot, root)))].sort();
const digest = createHash("sha256");
for (const input of buildInputs) {
  digest.update(relative(runtimeRoot, input));
  digest.update(readFileSync(input));
}

export const RUNTIME_VERSION = packageJson.version;
export const RUNTIME_BUILD_ID = process.env.CODEX_CONTROL_BUILD_ID ?? `${RUNTIME_VERSION}+${digest.digest("hex").slice(0, 12)}`;

export function runtimeIdentity(runtimePath = fileURLToPath(new URL("./daemon.js", import.meta.url))) {
  return { version: RUNTIME_VERSION, buildId: RUNTIME_BUILD_ID, protocolVersion: DAEMON_PROTOCOL_VERSION, runtimePath };
}
