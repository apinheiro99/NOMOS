import { test } from "node:test";
import assert from "node:assert/strict";
import { isAdminHostAllowed, parseAdminConfig } from "../dist/config.js";
import { createPool } from "../dist/policy/repository.js";

// Audit F2 #13/#14: the admin Host contract and the operational limits that come from the environment.
test("a loopback bind accepts loopback Host names only; a non-loopback bind needs its host names configured", () => {
  assert.equal(isAdminHostAllowed("localhost:8788", "127.0.0.1", []), true);
  assert.equal(isAdminHostAllowed("evil.example:8788", "127.0.0.1", []), false);
  assert.equal(isAdminHostAllowed(undefined, "127.0.0.1", []), false);
  assert.throws(() => parseAdminConfig({ TAIGA_MCP_ADMIN_HOST: "0.0.0.0", TAIGA_MCP_HTTP_ALLOW_NON_LOOPBACK: "1" }), /ALLOWED_HOSTS/);
  const cfg = parseAdminConfig({ TAIGA_MCP_ADMIN_HOST: "0.0.0.0", TAIGA_MCP_HTTP_ALLOW_NON_LOOPBACK: "1", TAIGA_MCP_ADMIN_ALLOWED_HOSTS: "Policy.example.com" });
  assert.equal(isAdminHostAllowed("policy.example.com:8788", cfg.host, cfg.allowedHosts), true);
  assert.equal(isAdminHostAllowed("other.example.com:8788", cfg.host, cfg.allowedHosts), false);
});

test("pool limits come from the environment and a malformed value stops the start", async () => {
  process.env.TAIGA_MCP_DB_POOL_MAX = "3";
  const pool = createPool("postgresql://x:y@127.0.0.1:1/none");
  assert.equal((pool.options as { max: number }).max, 3);
  await pool.end();
  process.env.TAIGA_MCP_DB_CONNECT_TIMEOUT_MS = "soon";
  try { assert.throws(() => createPool("postgresql://x:y@127.0.0.1:1/none"), /TAIGA_MCP_DB_CONNECT_TIMEOUT_MS must be a positive integer/); }
  finally { delete process.env.TAIGA_MCP_DB_POOL_MAX; delete process.env.TAIGA_MCP_DB_CONNECT_TIMEOUT_MS; }
});

test("a resident with no DATABASE_URL does not start, unless the engine is turned off on purpose", async () => {
  const { spawnSync } = await import("node:child_process");
  const env = { PATH: process.env.PATH, TAIGA_MCP_TRANSPORT: "http", TAIGA_MCP_HTTP_PORT: "0", TAIGA_URL: "http://taiga.invalid", TAIGA_USERNAME: "u", TAIGA_PASSWORD: "p" };
  const r = spawnSync("node", ["dist/index.js"], { env, encoding: "utf8", timeout: 10_000 });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /DATABASE_URL is not set/);
});
