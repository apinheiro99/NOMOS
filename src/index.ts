#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createTaigaMcpServer } from "./server.js";
import { fatalMessage } from "./errors.js";
import { parseTransportConfig } from "./config.js";
import { startHttpServer } from "./http.js";

async function main() {
  const config = parseTransportConfig();
  if (config.transport === "http") {
    await startHttpServer(config);
    console.error(`taiga-mcp listening on http://${config.host}:${config.port}${config.path}`);
    return;
  }
  const server = createTaigaMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Fatal error:", fatalMessage(err));
  process.exit(1);
});
