#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createTaigaMcpServer } from "./server.js";
import { fatalMessage } from "./errors.js";
import { parseAdminConfig, parseTransportConfig } from "./config.js";
import { startAdminServer } from "./admin/server.js";
import { createPool } from "./policy/repository.js";
import { startHttpServer } from "./http.js";
import { loadActorConfig } from "./workflow/actor.js";
import { loadActorClients, verifyActorAccounts } from "./workflow/actor-clients.js";

async function main() {
  const config = parseTransportConfig();
  if (config.transport === "http") {
    const actors = loadActorConfig();
    // With actor tokens configured every actor has its own Taiga account; without tokens (local development) one shared session serves all.
    const clients = actors.tokens.size ? loadActorClients(actors) : undefined;
    if (clients) await verifyActorAccounts(clients);
    await startHttpServer(config, clients, actors);
    // The policy database turns the private admin API on (same process, own port). Without DATABASE_URL there is no policy engine yet.
    if (process.env.DATABASE_URL) {
      const admin = parseAdminConfig();
      await startAdminServer(admin, createPool(process.env.DATABASE_URL), actors);
      console.error(`taiga-mcp admin listening on http://${admin.host}:${admin.port}/admin/api/v1`);
    }
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
