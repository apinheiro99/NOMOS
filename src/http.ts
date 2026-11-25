import { createServer, type Server } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isHostAllowed, isLoopback, isOriginAllowed } from "./config.js";
import { TaigaClient } from "./client.js";
import { createTaigaMcpServer } from "./server.js";
import { actorFromAuthorization, loadActorConfig, type ActorConfig, type ActorRole, type WorkflowIdentity } from "./workflow/actor.js";

type HttpConfig = { host: string; port: number; path: string; allowedOrigins?: string[] };

// Stateless Streamable HTTP: every POST gets its own McpServer + transport. Authenticated callers use the TaigaClient of their own
// actor (one Taiga account each), so the token is reused per actor. No sessions, no SSE stream (GET/DELETE answer 405).
export function startHttpServer(config: HttpConfig, clients: TaigaClient | Map<ActorRole, TaigaClient> = new TaigaClient(), actors: ActorConfig = loadActorConfig()): Promise<Server> {
  // Any configured actor token turns inbound authentication ON for every request; a fixed stdio actor makes no sense here.
  if (actors.stdioActor) throw new Error("TAIGA_MCP_ACTOR is for stdio only; HTTP callers are identified by TAIGA_MCP_GPT_TOKEN / TAIGA_MCP_CLAUDE_TOKEN / TAIGA_MCP_PO_TOKEN bearer tokens");
  const authenticated = actors.tokens.size > 0;
  const http = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== config.path) {
      res.writeHead(404, { "content-type": "text/plain" }).end("Not found");
      return;
    }
    // DNS-rebinding protection, before any MCP dispatch: reject foreign Origin, and foreign Host on loopback binds.
    const origin = req.headers.origin;
    if ((origin !== undefined && !isOriginAllowed(origin, config.allowedOrigins ?? [])) ||
        (isLoopback(config.host) && !isHostAllowed(req.headers.host))) {
      res.writeHead(403, { "content-type": "text/plain" }).end("Forbidden");
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405, { allow: "POST", "content-type": "text/plain" }).end("Method not allowed");
      return;
    }
    let identity: WorkflowIdentity = { mode: "syntactic", actor: null };
    if (authenticated) {
      const actor = actorFromAuthorization(actors, req.headers.authorization);
      if (!actor) {
        res.writeHead(401, { "content-type": "text/plain", "www-authenticate": "Bearer" }).end("Unauthorized");
        return;
      }
      identity = { mode: "authenticated", actor };
    }
    const client = clients instanceof Map ? clients.get(identity.actor?.role as ActorRole) : clients;
    if (!client) {
      res.writeHead(500, { "content-type": "text/plain" }).end("Internal error");
      return;
    }
    const server = createTaigaMcpServer(client, identity);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch {
      if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" }).end("Internal error");
    }
  });
  return new Promise((resolve, reject) => {
    http.once("error", reject);
    http.listen(config.port, config.host, () => resolve(http));
  });
}
