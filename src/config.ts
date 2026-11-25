export type TransportConfig =
  | { transport: "stdio" }
  | { transport: "http"; host: string; port: number; path: string; allowedOrigins: string[] };

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);

export function isLoopback(host: string): boolean {
  return LOOPBACK.has(host);
}

export function parseTransportConfig(env: NodeJS.ProcessEnv = process.env): TransportConfig {
  const transport = (env.TAIGA_MCP_TRANSPORT ?? "stdio").trim().toLowerCase();
  if (transport === "stdio") return { transport: "stdio" };
  if (transport !== "http") throw new Error(`Unsupported TAIGA_MCP_TRANSPORT "${transport}" (use stdio or http)`);

  const host = (env.TAIGA_MCP_HTTP_HOST ?? "127.0.0.1").trim();
  if (!isLoopback(host) && env.TAIGA_MCP_HTTP_ALLOW_NON_LOOPBACK !== "1") {
    throw new Error(`Refusing non-loopback bind "${host}": set TAIGA_MCP_HTTP_ALLOW_NON_LOOPBACK=1 to opt in`);
  }
  const rawPort = env.TAIGA_MCP_HTTP_PORT ?? "8787";
  const port = Number(rawPort);
  if (!/^\d+$/.test(rawPort) || port > 65535) throw new Error(`Invalid TAIGA_MCP_HTTP_PORT "${rawPort}"`);
  const path = (env.TAIGA_MCP_HTTP_PATH ?? "/mcp").trim();
  if (!path.startsWith("/")) throw new Error(`TAIGA_MCP_HTTP_PATH must start with "/"`);
  const allowedOrigins = (env.TAIGA_MCP_HTTP_ALLOWED_ORIGINS ?? "").split(",").map((o) => o.trim()).filter(Boolean);
  return { transport: "http", host, port, path, allowedOrigins };
}

// Loopback origins (any port) are always acceptable; anything else must be listed exactly.
export function isOriginAllowed(origin: string, allowedOrigins: string[]): boolean {
  if (allowedOrigins.includes(origin)) return true;
  try {
    return isLoopback(new URL(origin).hostname.replace(/^\[|\]$/g, ""));
  } catch {
    return false;
  }
}

// Host header of a loopback-bound server must itself be loopback (DNS-rebinding guard).
export function isHostAllowed(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  try {
    return isLoopback(new URL(`http://${hostHeader}`).hostname.replace(/^\[|\]$/g, ""));
  } catch {
    return false;
  }
}

// The Host header of an admin request must be a loopback name on a loopback bind, or one of the configured host names (DNS-rebinding guard).
export function isAdminHostAllowed(hostHeader: string | undefined, bindHost: string, allowedHosts: string[]): boolean {
  if (!hostHeader) return false;
  try {
    const name = new URL(`http://${hostHeader}`).hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return allowedHosts.includes(name) || (isLoopback(bindHost) && isLoopback(name));
  } catch {
    return false;
  }
}

export interface AdminConfig { host: string; port: number; allowedOrigins: string[]; allowedHosts: string[] }

// The admin listener is private: loopback unless the operator opts in, never on the tunnel's port.
export function parseAdminConfig(env: NodeJS.ProcessEnv = process.env): AdminConfig {
  const host = (env.TAIGA_MCP_ADMIN_HOST ?? "127.0.0.1").trim();
  if (!isLoopback(host) && env.TAIGA_MCP_HTTP_ALLOW_NON_LOOPBACK !== "1") {
    throw new Error(`Refusing non-loopback admin bind "${host}": set TAIGA_MCP_HTTP_ALLOW_NON_LOOPBACK=1 to opt in`);
  }
  const rawPort = env.TAIGA_MCP_ADMIN_PORT ?? "8788";
  const port = Number(rawPort);
  if (!/^\d+$/.test(rawPort) || port > 65535) throw new Error(`Invalid TAIGA_MCP_ADMIN_PORT "${rawPort}"`);
  const allowedOrigins = (env.TAIGA_MCP_ADMIN_ALLOWED_ORIGINS ?? "").split(",").map((o) => o.trim()).filter(Boolean);
  const allowedHosts = (env.TAIGA_MCP_ADMIN_ALLOWED_HOSTS ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
  if (!isLoopback(host) && !allowedHosts.length) throw new Error("A non-loopback admin bind needs TAIGA_MCP_ADMIN_ALLOWED_HOSTS: the host names the PO's browser uses");
  return { host, port, allowedOrigins, allowedHosts };
}
