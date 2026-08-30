import { existsSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join } from "node:path";

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

export function dataPlaneRuntime(options = {}) {
  const baseEnv = options.env ?? process.env;
  const nodePath = options.nodePath ?? process.execPath;
  const nodeBin = dirname(nodePath);
  const configuredBins = String(baseEnv.CODEX_DATA_PLANE_BIN ?? "")
    .split(delimiter)
    .map((value) => value.trim())
    .filter(Boolean);
  const codexBin = options.codexPath && isAbsolute(options.codexPath) ? dirname(options.codexPath) : null;
  const pathEntries = unique([...configuredBins, nodeBin, codexBin, ...(baseEnv.PATH ?? "").split(delimiter)]);
  const npmPath = [join(nodeBin, "npm"), join(nodeBin, "npm.cmd")].find(existsSync) ?? null;

  return {
    env: {
      ...baseEnv,
      PATH: pathEntries.join(delimiter),
      CODEX_DATA_PLANE_NODE: nodePath,
      ...(npmPath ? { CODEX_DATA_PLANE_NPM: npmPath } : {}),
    },
    nodePath,
    npmPath,
    pathEntries,
  };
}

export function runtimePrompt(runtime = dataPlaneRuntime()) {
  return [
    "[DATA PLANE RUNTIME] The daemon guarantees this toolchain for command execution.",
    `Node: ${runtime.nodePath}`,
    `npm: ${runtime.npmPath ?? "not bundled; run package scripts with the absolute Node executable (for this repository: node --test)"}`,
    "Use the absolute Node executable when node is not resolved by the shell. Do not report tests as executed unless the command actually ran.",
  ].join("\n");
}
