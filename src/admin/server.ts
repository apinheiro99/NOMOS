import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type pg from "pg";
import { ZodError } from "zod";
import { isHostAllowed, isLoopback, isOriginAllowed, type AdminConfig } from "../config.js";
import { ProjectLockBusyError } from "../policy/repository.js";
import { PolicyError } from "../policy/service.js";
import { uuidv7 } from "../identity.js";
import { actorFromAuthorization, type ActorConfig } from "../workflow/actor.js";
import { createAdminApi, type MirrorDeps } from "./api.js";
import { DEV_RELOAD_PATH } from "../dev-reload.js";

const PREFIX = "/admin/api/v1";
const MAX_BODY = 1_048_576;

// Network and I/O failures are "dependency unavailable"; anything else is a bug and says nothing about its cause.
const UNAVAILABLE = /^(08|57|53)|^(ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET)$/;
const isUnavailable = (e: unknown) => /Connection terminated|timeout exceeded when trying to connect|statement timeout/.test((e as Error)?.message ?? "") || UNAVAILABLE.test((e as { code?: string })?.code ?? "");

function failure(e: unknown): { status: number; code: string; message: string; problems: unknown[] } {
  if (e instanceof PolicyError) return { status: e.status, code: e.code, message: e.message, problems: e.problems };
  if (e instanceof ProjectLockBusyError) return { status: 409, code: "busy", message: e.message, problems: [] };
  if (e instanceof ZodError) return { status: 422, code: "invalid_request", message: "the request is not valid", problems: e.issues.map((i) => ({ path: i.path.join("."), message: i.message })) };
  if (isUnavailable(e)) return { status: 503, code: "dependency_unavailable", message: "the policy database is not available", problems: [] };
  return { status: 500, code: "internal", message: "internal error", problems: [] };
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY) throw new PolicyError(413, "too_large", "the request body is too large");
    chunks.push(chunk);
  }
  if (!size) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ZodError([{ code: "custom", path: [], message: "the body is not valid JSON", input: undefined }]);
  }
}

// The private admin listener, in the same process as /mcp but on its own port. Never reachable through the tunnel.
export function startAdminServer(config: AdminConfig, pool: pg.Pool, actors: ActorConfig, extras: { devReload?: (res: ServerResponse) => void; mirror?: MirrorDeps } = {}): Promise<Server> {
  const { devReload, mirror } = extras;
  if (!actors.tokens.has("po")) throw new Error("the admin API needs TAIGA_MCP_PO_TOKEN");
  const api = createAdminApi(pool, mirror);
  const send = (res: ServerResponse, status: number, body: unknown, correlation: string) =>
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", "x-correlation-id": correlation }).end(JSON.stringify(body));

  const http = createServer(async (req, res) => {
    const correlation = uuidv7();
    const fail = (e: unknown) => {
      const f = failure(e);
      if (f.status === 500) process.stderr.write(`admin: ${correlation} ${(e as Error)?.stack ?? e}\n`);
      send(res, f.status, { code: f.code, message: f.message, problems: f.problems, correlation_id: correlation }, correlation);
    };
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      // DEV only: the page's reload stream carries nothing but a process id, and a browser EventSource cannot send a bearer header.
      if (devReload && req.method === "GET" && url.pathname === DEV_RELOAD_PATH) return devReload(res);
      if (!url.pathname.startsWith(`${PREFIX}/`)) return send(res, 404, { code: "not_found", message: "route does not exist", problems: [], correlation_id: correlation }, correlation);
      const origin = req.headers.origin;
      if ((origin !== undefined && !isOriginAllowed(origin, config.allowedOrigins)) || (isLoopback(config.host) && !isHostAllowed(req.headers.host))) {
        return send(res, 403, { code: "forbidden", message: "origin or host not allowed", problems: [], correlation_id: correlation }, correlation);
      }
      // Authentication comes first and covers every method: no token, no answer, not even for GET.
      const actor = actorFromAuthorization(actors, req.headers.authorization);
      if (!actor) return send(res, 401, { code: "unauthorized", message: "a PO bearer token is required", problems: [], correlation_id: correlation }, correlation);
      if (actor.role !== "po") return send(res, 403, { code: "forbidden", message: "only the PO may use the admin API", problems: [], correlation_id: correlation }, correlation);
      const body = req.method === "POST" ? await readJson(req) : undefined;
      const out = await api({ method: req.method ?? "GET", path: url.pathname.slice(PREFIX.length), query: url.searchParams, body });
      send(res, out.status, out.body, correlation);
    } catch (e) {
      fail(e);
    }
  });
  http.requestTimeout = 30_000;
  return new Promise((resolve, reject) => {
    http.once("error", reject);
    http.listen(config.port, config.host, () => resolve(http));
  });
}
