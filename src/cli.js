#!/usr/bin/env node

import { ControlPlaneDaemonClient } from "./daemon-client.js";

function parseArgs(argv) {
  const [command = "help", ...rest] = argv;
  const options = { _: [] };
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith("--")) {
      options._.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = rest[index + 1];
    if (!next || next.startsWith("--")) options[key] = true;
    else {
      options[key] = next;
      index += 1;
    }
  }
  return { command, options };
}

function usage() {
  return `Codex Control Plane

Usage:
  ruvora list [--cwd PATH] [--limit N]
  ruvora start [--cwd PATH] [--sandbox MODE] [--model MODEL] [--ephemeral]
  ruvora resume THREAD_ID
  ruvora fork THREAD_ID [--ephemeral]
  ruvora run THREAD_ID --prompt TEXT [--cwd PATH]
  ruvora ask --prompt TEXT [--cwd PATH] [--sandbox MODE]

All commands are sent to the single local control-plane daemon, which is the only
process allowed to write Codex threads. All output is JSON.`;
}

async function callTool(client, name, args = {}) {
  const response = await client.call("tools/call", { name, arguments: args });
  if (response.isError) {
    const error = new Error(response.structuredContent?.error ?? `${name} failed`);
    error.code = response.structuredContent?.code;
    throw error;
  }
  return response.structuredContent;
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (command === "help" || options.help) {
    console.log(usage());
    return;
  }

  const client = new ControlPlaneDaemonClient();
  let result;
  if (command === "list") {
    result = await callTool(client, "list_agents", {
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.limit ? { limit: Number(options.limit) } : {}),
    });
  } else if (command === "start") {
    result = await callTool(client, "spawn_agent", {
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.sandbox ? { sandbox: options.sandbox } : {}),
      ...(options.model ? { model: options.model } : {}),
      ...(options.ephemeral ? { ephemeral: true } : {}),
    });
  } else if (command === "resume") {
    const [threadId] = options._;
    if (!threadId) throw new Error("resume requires THREAD_ID");
    result = await callTool(client, "inspect_agent", { threadId });
  } else if (command === "fork") {
    const [threadId] = options._;
    if (!threadId) throw new Error("fork requires THREAD_ID");
    result = await callTool(client, "fork_agent", { threadId, ephemeral: Boolean(options.ephemeral) });
  } else if (command === "run") {
    const [threadId] = options._;
    if (!threadId) throw new Error("run requires THREAD_ID");
    if (!options.prompt) throw new Error("run requires --prompt TEXT");
    result = await callTool(client, "run_agent_task", {
      threadId,
      reuseExisting: true,
      prompt: options.prompt,
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.model ? { model: options.model } : {}),
    });
  } else if (command === "ask") {
    if (!options.prompt) throw new Error("ask requires --prompt TEXT");
    result = await callTool(client, "run_agent_task", {
      prompt: options.prompt,
      routingMode: "new",
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.sandbox ? { sandbox: options.sandbox } : {}),
      ...(options.model ? { model: options.model } : {}),
    });
  } else {
    throw new Error(`Unknown command: ${command}\n\n${usage()}`);
  }

  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ error: error.message, code: error.code ?? null }, null, 2));
  process.exitCode = 1;
});
