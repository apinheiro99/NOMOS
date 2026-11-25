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
import { reconcileJournal } from "./policy/journal-recovery.js";
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
    // API (same process, own port) proposes and approves it. A resident without DATABASE_URL does not start, unless the operator turns the engine
    // off on purpose with TAIGA_MCP_POLICY_ENGINE=off (then only the legacy rules apply, and the log says so).
    if (!process.env.DATABASE_URL && process.env.TAIGA_MCP_POLICY_ENGINE !== "off") throw new Error("DATABASE_URL is not set: the policy engine needs its database (set TAIGA_MCP_POLICY_ENGINE=off to run on the legacy rules on purpose)");
    if (!process.env.DATABASE_URL) console.error("policy engine is OFF (TAIGA_MCP_POLICY_ENGINE=off): legacy rules only");
    const pool = process.env.DATABASE_URL ? createPool(process.env.DATABASE_URL) : undefined;
    const runtime = pool ? createPolicyRuntime(pool, instanceBaseUrl()) : undefined;
    // Startup: nothing of ours is in flight, so every journal entry left at `intent` is settled from Taiga now, and every Done that still owes its merge authorization
    // (or its delivery) is finished before serving. The journal pass repeats while the process runs, for entries a failed request left behind.
    const po = clients?.get("po");
    const settle = async (minutes: number) => {
      if (!runtime || !po) return;
      process.stderr.write(`mutation journal: ${JSON.stringify(await reconcileJournal(runtime, po, minutes))}\n`);
      if (process.env[PRIVATE_KEY_ENV]) process.stderr.write(`merge obligations: ${JSON.stringify(await recoverMergeObligations(runtime, po, loadSigner(), minutes))}\n`);
    };
    await settle(0);
    if (runtime && po) setInterval(() => { settle(5).catch((e: Error) => process.stderr.write(`recovery pass failed: ${e.message}\n`)); }, 5 * 60_000).unref();
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
