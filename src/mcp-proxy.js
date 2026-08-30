#!/usr/bin/env node

import readline from "node:readline";

import { ControlPlaneDaemonClient } from "./daemon-client.js";

export class McpDaemonProxy {
  constructor(options = {}) {
    this.input = options.input ?? process.stdin;
    this.output = options.output ?? process.stdout;
    this.client = options.client ?? new ControlPlaneDaemonClient(options);
    this.lines = null;
  }

  start() {
    this.lines = readline.createInterface({ input: this.input });
    this.lines.on("line", (line) => void this.#handleLine(line));
  }

  close() {
    this.lines?.close();
  }

  async #handleLine(line) {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.#write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      return;
    }
    if (message.id === undefined) return;
    try {
      const result = await this.client.call(message.method, message.params ?? {});
      this.#write({ jsonrpc: "2.0", id: message.id, result });
    } catch (error) {
      this.#write({ jsonrpc: "2.0", id: message.id, error: { code: error.code ?? -32603, message: error.message } });
    }
  }

  #write(message) {
    this.output.write(`${JSON.stringify(message)}\n`);
  }
}

const proxy = new McpDaemonProxy();
proxy.start();
process.once("SIGINT", () => process.exit(0));
process.once("SIGTERM", () => process.exit(0));
