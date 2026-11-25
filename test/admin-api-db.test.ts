import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { Server } from "node:http";
import { startAdminServer } from "../dist/admin/server.js";
import { createDevReload } from "../dist/dev-reload.js";
import { parseAdminConfig } from "../dist/config.js";
import { migrate } from "../dist/policy/migrate.js";
import { createPool } from "../dist/policy/repository.js";
import { legacySeed } from "../dist/policy/legacy-seed.js";
import { loadActorConfig } from "../dist/workflow/actor.js";
import { connect, createTestDatabase } from "./support/pg.ts";

// F2.5: the admin API over real HTTP and real PostgreSQL.
const TOKENS = { TAIGA_MCP_GPT_TOKEN: "g".repeat(20), TAIGA_MCP_CLAUDE_TOKEN: "c".repeat(20), TAIGA_MCP_PO_TOKEN: "p".repeat(20) };
const PO = { authorization: `Bearer ${TOKENS.TAIGA_MCP_PO_TOKEN}` };
let db: Awaited<ReturnType<typeof createTestDatabase>>;
let pool: ReturnType<typeof createPool>;
let server: Server;
let base = "";
const project = randomUUID();

before(async () => {
  db = await createTestDatabase();
  const c = await connect(db.url);
  await migrate(c, fileURLToPath(new URL("../db/migrations", import.meta.url)));
  await c.end();
  pool = createPool(db.url, 5);
  const instance = randomUUID();
  await pool.query("INSERT INTO taiga_instance (id, instance_key, base_url) VALUES ($1,'lab','http://t')", [instance]);
  await pool.query("INSERT INTO project_binding (id, instance_id, taiga_project_id, slug, name, lifecycle) VALUES ($1,$2,7,'lab','Lab','managed')", [project, instance]);
  server = await startAdminServer({ host: "127.0.0.1", port: 0, allowedOrigins: [] }, pool, loadActorConfig(TOKENS));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/admin/api/v1`;
});
after(async () => {
  server.close();
  await pool.end();
  await db.drop();
});

interface Item { activeRevision: number | null; revision: number; state: string; operation: string }
interface Reply {
  status: string; schema: string; code: string; correlation_id: string; revision: number; hash: string; kind: string;
  items: Item[]; problems: { code: string }[]; policy: { schemaVersion: number };
}
const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = PO) => {
  const res = await fetch(`${base}${path}`, { method, headers: { ...headers, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, headers: res.headers, json: (await res.json()) as Reply };
};

test("every route answers 401 without a token, GET included, and 403 to the agents", async () => {
  for (const [method, path] of [["GET", "/health"], ["GET", "/projects"], ["POST", `/projects/${project}/proposals`]]) {
    assert.equal((await call(method, path, undefined, {})).status, 401, `${method} ${path}`);
    for (const t of [TOKENS.TAIGA_MCP_GPT_TOKEN, TOKENS.TAIGA_MCP_CLAUDE_TOKEN]) assert.equal((await call(method, path, undefined, { authorization: `Bearer ${t}` })).status, 403);
  }
});

test("responses are JSON, never cached, and errors carry a correlation id", async () => {
  const ok = await call("GET", "/health");
  assert.deepEqual([ok.status, ok.json.status, ok.json.schema, ok.headers.get("cache-control")], [200, "ok", "0001_policy_schema.sql", "no-store"]);
  const bad = await call("GET", "/projects/not-a-uuid");
  assert.equal(bad.status, 422);
  assert.deepEqual(Object.keys(bad.json).sort(), ["code", "correlation_id", "message", "problems"]);
  assert.equal(bad.json.correlation_id, bad.headers.get("x-correlation-id"));
  assert.equal((await call("GET", `/projects/${randomUUID()}`)).status, 404);
  assert.equal((await call("GET", "/nothing")).status, 404);
  assert.equal((await call("DELETE", "/projects")).status, 405);
});

test("propose, review, approve, history and audit through the API", async () => {
  assert.equal((await call("GET", "/projects")).json.items[0].activeRevision, null);
  const first = await call("POST", `/projects/${project}/proposals`, { policy: legacySeed() });
  assert.equal(first.status, 201);
  assert.equal((await call("GET", `/projects/${project}/proposals`)).json.items.length, 1);
  const approved = await call("POST", `/projects/${project}/proposals/1/approve`, { expectedRevision: null, hash: first.json.hash, reason: "seed" });
  assert.deepEqual([approved.status, approved.json.revision], [200, 1]);
  assert.equal((await call("GET", `/projects/${project}`)).json.activeRevision, 1);
  const history = (await call("GET", `/projects/${project}/policies`)).json.items;
  assert.deepEqual(history.map((v) => `${v.revision}:${v.state}`), ["1:active"]);
  assert.equal((await call("GET", `/projects/${project}/policies/1`)).json.policy.schemaVersion, 1);
  assert.deepEqual((await call("GET", `/projects/${project}/audit`)).json.items.map((a) => a.operation), ["approve", "propose"]);
  const sim = await call("POST", `/projects/${project}/simulate`, { entity: "task", role: "gpt", from: "to do", to: "in progress" });
  assert.deepEqual([sim.json.kind, sim.json.revision], ["typed", 1]);
});

test("stale, wrong hash, invalid policy and bad bodies map to 409, 409, 422, 422", async () => {
  const p = await call("POST", `/projects/${project}/proposals`, { policy: legacySeed() });
  const rev = (await call("GET", `/projects/${project}/proposals`)).json.items[0].revision;
  assert.equal((await call("POST", `/projects/${project}/proposals/${rev}/approve`, { expectedRevision: 1, hash: "0".repeat(64), reason: "x" })).json.code, "hash_mismatch");
  assert.equal((await call("POST", `/projects/${project}/proposals/${rev}/approve`, { expectedRevision: null, hash: p.json.hash, reason: "x" })).json.code, "stale");
  const bad = legacySeed();
  bad.entities.task.transitions.push({ from: "to do", to: "limbo", allow: ["gpt"], artifact: "po_decision" });
  const invalid = await call("POST", `/projects/${project}/proposals`, { policy: bad });
  assert.deepEqual([invalid.status, invalid.json.code, invalid.json.problems[0].code], [422, "invalid_policy", "unknown_state"]);
  const shape = await call("POST", `/projects/${project}/proposals`, { policy: { nope: true } });
  assert.deepEqual([shape.status, shape.json.code], [422, "invalid_request"]);
  assert.equal((await call("POST", `/projects/${project}/proposals/${rev}/reject`, { reason: "later", role: "po" })).status, 422, "a role in the body is refused, not obeyed");
  assert.equal((await call("POST", `/projects/${project}/proposals/${rev}/reject`, { reason: "later" })).status, 200);
});

test("a rollback proposes a copy and a database that is down answers 503", async () => {
  const back = await call("POST", `/projects/${project}/rollback`, { toRevision: 1 });
  assert.equal(back.status, 201);
  const dead = createPool("postgresql://x:y@127.0.0.1:1/none", 1);
  const s = await startAdminServer({ host: "127.0.0.1", port: 0, allowedOrigins: [] }, dead, loadActorConfig(TOKENS));
  const res = await fetch(`http://127.0.0.1:${(s.address() as { port: number }).port}/admin/api/v1/projects`, { headers: PO });
  assert.equal(res.status, 503);
  s.close();
  await dead.end();
});

test("foreign Origin or Host is refused and the admin bind stays on loopback", async () => {
  assert.equal((await call("GET", "/health", undefined, { ...PO, origin: "https://evil.example" })).status, 403);
  assert.throws(() => parseAdminConfig({ TAIGA_MCP_ADMIN_HOST: "0.0.0.0" }), /non-loopback/);
  assert.equal(parseAdminConfig({}).port, 8788);
});

test("the admin API cannot start without a PO token", () => {
  assert.throws(() => startAdminServer({ host: "127.0.0.1", port: 0, allowedOrigins: [] }, pool, loadActorConfig({ TAIGA_MCP_GPT_TOKEN: TOKENS.TAIGA_MCP_GPT_TOKEN })), /TAIGA_MCP_PO_TOKEN/);
});

test("the DEV reload stream exists only when it is switched on, needs no token, and carries only an id", async () => {
  assert.equal((await fetch(base.replace("/v1", "/dev-reload"))).status, 404);
  const dev = await startAdminServer({ host: "127.0.0.1", port: 0, allowedOrigins: [] }, pool, loadActorConfig(TOKENS), createDevReload());
  const res = await fetch(`http://127.0.0.1:${(dev.address() as { port: number }).port}/admin/api/dev-reload`);
  assert.equal(res.headers.get("content-type"), "text/event-stream");
  const reader = res.body!.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /^data: \d+-\d+\n\n$/);
  await reader.cancel();
  dev.close();
});

// Async on purpose: the server under test lives in this process, which must stay free to answer the child.
const healthcheck = (env: Record<string, string>) => new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
  const child = spawn("node", ["scripts/healthcheck.ts"], { env: { ...process.env, ...env } });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => { stdout += d; });
  child.stderr.on("data", (d) => { stderr += d; });
  child.on("close", (status) => resolve({ status, stdout, stderr }));
});

test("the health check passes against a healthy process and fails with a wrong token or nothing listening", async () => {
  const admin = base.replace("/admin/api/v1", "");
  const good = await healthcheck({ TAIGA_MCP_ADMIN_URL: admin, TAIGA_MCP_PO_TOKEN: TOKENS.TAIGA_MCP_PO_TOKEN });
  assert.equal(good.status, 0, good.stderr);
  assert.match(good.stdout, /healthcheck: ok \(schema 0001_policy_schema\.sql/);
  assert.equal((await healthcheck({ TAIGA_MCP_ADMIN_URL: admin, TAIGA_MCP_PO_TOKEN: "x".repeat(20) })).status, 1);
  assert.equal((await healthcheck({ TAIGA_MCP_ADMIN_URL: "http://127.0.0.1:1", TAIGA_MCP_PO_TOKEN: TOKENS.TAIGA_MCP_PO_TOKEN })).status, 1);
  assert.equal((await healthcheck({ TAIGA_MCP_ADMIN_URL: admin, TAIGA_MCP_PO_TOKEN: "" })).status, 1);
});
