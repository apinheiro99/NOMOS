#!/usr/bin/env node
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { governanceFile } from "./governance.js";

// Human-admin control for workflow governance, outside the MCP. One global switch for the whole MCP:
//   taiga-mcp-governance on|off|status
const [cmd, ...rest] = process.argv.slice(2);
const file = governanceFile();

function current(): boolean {
  try {
    return JSON.parse(readFileSync(file, "utf8"))?.enabled !== false;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw new Error(`governance file is not readable JSON: ${file}`);
  }
}

try {
  if (cmd === "status" && rest.length === 0) {
    console.log(JSON.stringify({ enabled: current() }));
  } else if ((cmd === "on" || cmd === "off") && rest.length === 0) {
    current(); // refuse to overwrite a corrupt file
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ enabled: cmd === "on" }, null, 2) + "\n");
    renameSync(tmp, file);
    console.log(`governance ${cmd.toUpperCase()} (${file})`);
  } else {
    console.error("usage: taiga-mcp-governance on|off|status");
    process.exit(2);
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : "failed");
  process.exit(1);
}
