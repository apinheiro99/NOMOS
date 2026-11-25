import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { migrate } from "../dist/policy/migrate.js";
import { connect, createTestDatabase } from "./support/pg.ts";

// F2.7: the real resident process (node dist/index.js): MCP + admin API in one process, started the way the DEV unit starts it.
let db: Awaited<ReturnType<typeof createTestDatabase>>;
const children: ChildProcess[] = [];
const freePort = () => new Promise<number>((resolve) => { const s = createServer().listen(0, "127.0.0.1", () => { const { port } = s.address() as { port: number }; s.close(() => resolve(port)); }); });
const TOKENS = { TAIGA_MCP_GPT_TOKEN: "g".repeat(20), TAIGA_MCP_CLAUDE_TOKEN: "c".repeat(20), TAIGA_MCP_PO_TOKEN: "p".repeat(20) };
const ACCOUNTS = { TAIGA_URL: "http://taiga.invalid", TAIGA_USERNAME_GPT: "g", TAIGA_PASSWORD_GPT: "x", TAIGA_USERNAME_CLAUDE: "c", TAIGA_PASSWORD_CLAUDE: "x", TAIGA_USERNAME_PO: "p", TAIGA_PASSWORD_PO: "x" };

before(async () => {
  db = await createTestDatabase();
  const c = await connect(db.url);
  await migrate(c, fileURLToPath(new URL("../db/migrations", import.meta.url)));
  await c.end();
});
after(async () => {
  for (const c of children) c.kill();
  await db.drop();
});

function start(env: Record<string, string>) {
  const child = spawn("node", ["dist/index.js"], { env: { ...process.env, ...TOKENS, ...ACCOUNTS, TAIGA_MCP_TRANSPORT: "http", TAIGA_MCP_HTTP_HOST: "127.0.0.1", ...env }, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  let err = "";
  child.stderr!.on("data", (d) => { err += d; });
  return { child, stderr: () => err, exited: new Promise<number | null>((r) => child.on("close", r)) };
}
const run = (script: string[], env: Record<string, string>) => new Promise<{ status: number | null; stdout: string }>((resolve) => {
  const c = spawn("node", script, { env: { ...process.env, ...env } });
  let stdout = "";
  c.stdout.on("data", (d) => { stdout += d; });
  c.on("close", (status) => resolve({ status, stdout }));
});

test("the resident process serves /mcp and the admin API together, and the unit's health gate passes", async () => {
  const [http, admin] = [await freePort(), await freePort()];
  const p = start({ DATABASE_URL: db.url, TAIGA_MCP_HTTP_PORT: String(http), TAIGA_MCP_ADMIN_PORT: String(admin), TAIGA_MCP_BUILD: "test" });
  const health = await run(["scripts/healthcheck.ts", "--wait"], { TAIGA_MCP_ADMIN_URL: `http://127.0.0.1:${admin}`, TAIGA_MCP_PO_TOKEN: TOKENS.TAIGA_MCP_PO_TOKEN });
  assert.equal(health.status, 0, p.stderr());
  assert.match(health.stdout, /schema 0003_merge_obligation\.sql, build test/);
  assert.equal((await fetch(`http://127.0.0.1:${http}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 401, "/mcp needs an actor token");
  p.child.kill();
  await p.exited;
});

test("a process with actor tokens but a missing Taiga account does not start", async () => {
  const p = start({ DATABASE_URL: db.url, TAIGA_MCP_HTTP_PORT: String(await freePort()), TAIGA_MCP_ADMIN_PORT: String(await freePort()), TAIGA_USERNAME_CLAUDE: "" });
  assert.equal(await p.exited, 1);
  assert.match(p.stderr(), /TAIGA_USERNAME_CLAUDE/);
});
