#!/usr/bin/env node
import { existsSync } from "node:fs";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createTaigaMcpServer } from "./server.js";
import { fatalMessage } from "./errors.js";
import { parseAdminConfig, parseTransportConfig } from "./config.js";
import { startAdminServer } from "./admin/server.js";
import { createPool } from "./policy/repository.js";
import { createPolicyRuntime, instanceBaseUrl } from "./policy/runtime.js";
import { recoverMergeObligations } from "./policy/merge-recovery.js";
import { loadSigner, PRIVATE_KEY_ENV } from "./workflow/merge-auth.js";
import { startHttpServer } from "./http.js";
import { createDevReload, watchSources } from "./dev-reload.js";
import { loadActorConfig } from "./workflow/actor.js";
import { loadActorClients, verifyActorAccounts } from "./workflow/actor-clients.js";

async function main() {
  const config = parseTransportConfig();
  if (config.transport === "http") {
    const actors = loadActorConfig();
    // With actor tokens configured every actor has its own Taiga account; without tokens (local development) one shared session serves all.
    const clients = actors.tokens.size ? loadActorClients(actors) : undefined;
    if (clients) await verifyActorAccounts(clients);
    // The policy database turns the policy engine on: the MCP decides managed projects by their active policy, and the private admin
    // API (same process, own port) proposes and approves it. Without DATABASE_URL there is no policy engine and the legacy rules apply.
    const pool = process.env.DATABASE_URL ? createPool(process.env.DATABASE_URL) : undefined;
    const runtime = pool ? createPolicyRuntime(pool, instanceBaseUrl()) : undefined;
    // A Done approved before a crash still owes its merge authorization: settle every stored obligation before serving.
    if (runtime && clients?.get("po") && process.env[PRIVATE_KEY_ENV]) process.stderr.write(`merge obligations: ${JSON.stringify(await recoverMergeObligations(runtime, clients.get("po")!, loadSigner()))}\n`);
    await startHttpServer(config, clients, actors, runtime);
    console.error(`taiga-mcp listening on http://${config.host}:${config.port}${config.path}`);
    if (pool) {
      const admin = parseAdminConfig();
      const dev = process.env.TAIGA_MCP_DEV_RELOAD === "1";
      await startAdminServer(admin, pool, actors, { devReload: dev ? createDevReload() : undefined, mirror: clients?.get("po") ? { client: clients.get("po")!, baseUrl: instanceBaseUrl() } : undefined });
      if (dev) watchSources(["src", "db/migrations"].filter((d) => existsSync(d)), () => { console.error("source changed: restarting"); process.exit(0); });
      console.error(`taiga-mcp admin listening on http://${admin.host}:${admin.port}/admin/api/v1`);
    }
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
