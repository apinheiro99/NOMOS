import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { TaigaClient } from "../dist/client.js";
import { createTaigaMcpServer } from "../dist/server.js";
import { migrate } from "../dist/policy/migrate.js";
import { createPool } from "../dist/policy/repository.js";
import { createPolicyRuntime } from "../dist/policy/runtime.js";
import { approve, propose } from "../dist/policy/service.js";
import { actorFor } from "../dist/workflow/actor.js";
import type { Policy } from "../dist/policy/types.js";
import { connect, createTestDatabase } from "./support/pg.ts";

// F2.6: the MCP decides a managed (laboratory) project by its ACTIVE policy and journals the writes; an unmanaged project keeps the legacy rules.
// Taiga is a fake here (the same shape workflow.test.ts uses); the policy database is real PostgreSQL.
const BASE = "http://taiga.invalid";
const T = { todo: 1, prog: 2, val: 3, human: 4, done: 5, canc: 6, req: 7 };
const STATUSES = [[1, "To Do"], [2, "In Progress"], [3, "GPT Validation"], [4, "Human Decision"], [5, "Done"], [6, "Cancelled"], [7, "Request"]].map(([id, name]) => ({ id, name }));
const GOOD = ["Purpose", "Context", "What to do", "Deliverables", "Acceptance / Evidence", "Do not", "Dependencies", "Documentation", "Execution Notes"].map((h) => `**${h}**\ntext`).join("\n\n");
const L = (x = "x") => [x];
const blueprint = () => ({
  type: "implementation_blueprint", mode: "initial", objective: "o", verified_baseline: "b", problem_model: "The retry guard ignores throttled-only failures.",
  binding_contracts: L(), architecture_owners: [{ responsibility: "r", current_owner: "a", intended_owner: "a", forbidden_parallel_owner: "none" }],
  implementation_scope: L(), files_and_interfaces: L(), invariants: L(), known_traps_and_risks: L(), focused_test_matrix: L(), evidence_expected: L(),
  operational_steps: L("None."), prohibited_actions: L("No push."), stop_condition: "Stop at GPT Validation.", open_questions: [],
});
const handoff = (blueprintId: string) => ({
  type: "execution_handoff", blueprint_comment_id: blueprintId, branch: "feature/x", commits: [{ id: "abc123", contains: "fix" }], implementation_summary: L(), files_changed: L(),
  focused_tests: [{ command: "node --test", result: "pass", counts: "3/3" }], typecheck: "clean", runtime_evidence: L("None."), migrations_or_service_actions: L("None."),
  deviations_from_blueprint: L("No deviations."), known_limits: L("None."), bug_hunt: L(), unrelated_findings: L("None."), prohibited_actions_not_performed: L("No push."), working_tree_notes: L("clean"),
});

let db: Awaited<ReturnType<typeof createTestDatabase>>;
let pool: ReturnType<typeof createPool>;
let runtime: ReturnType<typeof createPolicyRuntime>;
let binding = "";
const realFetch = globalThis.fetch;
let dir = "";
let task: { id: number; ref: number; project: number; version: number; status: number; subject: string; description: string; is_blocked: boolean; blocked_note: string; milestone: null };
let comments: { id: string; comment: string; created_at: string }[] = [];
let writes: string[] = [];
const saved: Record<string, string | undefined> = {};

before(async () => {
  db = await createTestDatabase();
  const c = await connect(db.url);
  await migrate(c, fileURLToPath(new URL("../db/migrations", import.meta.url)));
  await c.end();
  pool = createPool(db.url, 5);
  runtime = createPolicyRuntime(pool, BASE);
  const instance = randomUUID();
  binding = randomUUID();
  await pool.query("INSERT INTO taiga_instance (id, instance_key, base_url) VALUES ($1,'lab',$2)", [instance, BASE]);
  await pool.query("INSERT INTO project_binding (id, instance_id, taiga_project_id, slug, name, lifecycle) VALUES ($1,$2,49,'lab','Lab','managed')", [binding, instance]);
  await pool.query("INSERT INTO project_binding (id, instance_id, taiga_project_id, slug, name, lifecycle) VALUES ($1,$2,50,'old','Old','legacy')", [randomUUID(), instance]);
});
after(async () => {
  await pool.end();
  await db.drop();
});

beforeEach(() => {
  for (const [k, v] of Object.entries({ TAIGA_URL: BASE, TAIGA_USERNAME: "u", TAIGA_PASSWORD: "p" })) { saved[k] = process.env[k]; process.env[k] = v; }
  dir = mkdtempSync(join(tmpdir(), "lab-"));
  writeFileSync(join(dir, "governance.json"), JSON.stringify({ enabled: true }));
  saved.GOV = process.env.TAIGA_MCP_GOVERNANCE_FILE;
  process.env.TAIGA_MCP_GOVERNANCE_FILE = join(dir, "governance.json");
  process.env.TAIGA_MCP_CONTINUATION_FILE = join(dir, "continuations.jsonl");
  task = { id: 7, ref: 905, project: 49, version: 3, status: T.todo, subject: "s", description: GOOD, is_blocked: false, blocked_note: "", milestone: null };
  comments = [];
  writes = [];
  let n = 0;
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).endsWith("/auth")) return new Response(JSON.stringify({ auth_token: "t", refresh: "r" }), { status: 200 });
    const u = new URL(String(url));
    const path = u.pathname.replace(/^.*\/api\/v1/, "");
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    const ok = (x: unknown) => new Response(JSON.stringify(x), { status: 200 });
    if (method !== "GET") writes.push(`${method} ${path}`);
    if (method === "GET") {
      if (path === "/task-statuses") return ok(STATUSES);
      if (path === "/users/me") return ok({ username: "u" });
      if (path === "/users") return ok([]);
      let m;
      if ((m = /^\/task-statuses\/(\d+)$/.exec(path))) return ok({ id: Number(m[1]), is_closed: [5, 6].includes(Number(m[1])), order: Number(m[1]) });
      if (path === "/history/task/7") return ok(comments);
      if (path === "/tasks/7") return ok({ ...task });
      if (path === "/tasks") return ok([task]);
      if (path === "/milestones") return ok(task.milestone ? [{ id: 1 }] : []);
      if (path === "/userstories") return ok([]);
      if (path === "/userstory-statuses") return ok(["Ready", "In Progress", "GPT Validation", "Done", "Human Decision", "Cancelled"].map((name, i) => ({ id: i + 1, name })));
      if (path === "/projects") return ok([{ id: 49 }]);
    }
    if (method === "PATCH") {
      if (body.comment !== undefined) comments.push({ id: `c${++n}`, comment: body.comment, created_at: new Date(1760000000000 + n * 1000).toISOString() });
      // eslint-disable-next-line @typescript-eslint/no-unused-vars -- rest-omit
      const { comment, version, ...rest } = body;
      Object.assign(task, rest);
      return ok({ ...task });
    }
    return ok({});
  };
});
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const k of ["TAIGA_URL", "TAIGA_USERNAME", "TAIGA_PASSWORD"]) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  if (saved.GOV === undefined) delete process.env.TAIGA_MCP_GOVERNANCE_FILE; else process.env.TAIGA_MCP_GOVERNANCE_FILE = saved.GOV;
  delete process.env.TAIGA_MCP_CONTINUATION_FILE;
  rmSync(dir, { recursive: true, force: true });
});

async function call(role: "gpt" | "claude" | "po", name: string, args: object, rt: typeof runtime | undefined = runtime) {
  writes = [];
  const server = createTaigaMcpServer(new TaigaClient(), { mode: "authenticated", actor: actorFor(role) }, rt);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "1" });
  await Promise.all([server.connect(a), client.connect(b)]);
  try { return await client.callTool({ name, arguments: args }); } finally { await client.close(); }
}
const payload = (r: unknown) => { try { return JSON.parse((r as { content: { text: string }[] }).content[0].text); } catch { return {}; } };
const move = (role: "gpt" | "claude" | "po", status: number, artifact: object, rt?: typeof runtime) => call(role, "taiga_workflow_transition", { entity: "task", id: 7, status, artifact }, rt);
const journal = async () => (await pool.query("SELECT operation, target_key, phase FROM mutation_journal WHERE project_id = $1 ORDER BY created_at", [binding])).rows;
const gptOnly = () => JSON.parse(readFileSync(new URL("./fixtures/policy/gpt-only.json", import.meta.url), "utf8")) as Policy;

async function activate(policy: Policy, expectedRevision: number | null) {
  const v = await propose(pool, binding, "gpt", policy);
  await approve(pool, binding, "po", { policyId: v.policyId, expectedRevision, hash: v.hash, reason: "lab" });
}

test("a managed project with no active policy is refused, never sent to the legacy rules", async () => {
  const r = await move("gpt", T.prog, blueprint());
  assert.equal(r.isError, true);
  assert.match(JSON.stringify(payload(r)), /managed but has no active policy/, "refused by the PEP before the handler");
  assert.deepEqual(writes, []);
});

test("GPT-only policy: GPT releases, executes and hands off alone; Claude is refused with zero writes", async () => {
  await activate(gptOnly(), null);
  const state = payload(await call("gpt", "taiga_task_workflow_state", { id: 7 }));
  assert.deepEqual([state.owner_role, state.policy_revision], ["gpt", 1]);
  assert.equal(payload(await move("gpt", T.prog, blueprint())).transitioned, true);
  const denied = await move("claude", T.val, handoff("x"));
  assert.equal(payload(denied).code, "WORKFLOW_TRANSITION_REJECTED");
  assert.deepEqual(writes, []);
  const bp = comments.find((c) => c.comment.includes("Implementation Blueprint"))!.id;
  assert.equal(payload(await move("gpt", T.val, handoff(bp))).transitioned, true);
  assert.deepEqual((await journal()).map((j) => `${j.operation}:${j.target_key}:${j.phase}`), ["workflow_transition:task:7:completed", "workflow_transition:task:7:completed"]);
});

test("GPT-only stays GPT-only through recovery: a lost ledger is rebuilt with GPT as the recipient, never Claude", async () => {
  assert.equal(payload(await move("gpt", T.prog, blueprint())).transitioned, true);
  task.milestone = 1 as never;
  rmSync(process.env.TAIGA_MCP_CONTINUATION_FILE!, { force: true }); // the ledger is lost, as after a failed append
  const listed = payload(await call("gpt", "taiga_continuations_pending", { project: 49 }));
  assert.equal(listed.recovery.recovered > 0, true, JSON.stringify(listed));
  assert.deepEqual([...new Set(listed.continuations.map((c: { to: string }) => c.to))], ["gpt"]);
  assert.deepEqual(payload(await call("claude", "taiga_continuations_pending", { project: 49 })).continuations, []);
});

test("the next decision uses the newly approved revision, with no restart", async () => {
  const next = gptOnly();
  next.roles.push("claude");
  next.entities.task.transitions.find((t) => t.from === "in progress" && t.to === "gpt validation")!.allow.push("claude");
  await activate(next, 1);
  assert.equal(payload(await move("gpt", T.prog, blueprint())).transitioned, true);
  const bp = comments.find((c) => c.comment.includes("Implementation Blueprint"))!.id;
  const handed = payload(await move("claude", T.val, handoff(bp)));
  assert.equal(handed.transitioned, true, JSON.stringify(handed));
});

test("a project the engine does not manage keeps the legacy rules", async () => {
  task.project = 50;
  const before = (await journal()).length;
  assert.equal(payload(await move("gpt", T.prog, blueprint())).transitioned, true);
  const bp = comments.find((c) => c.comment.includes("Implementation Blueprint"))!.id;
  assert.equal(payload(await move("claude", T.val, handoff(bp))).transitioned, true);
  assert.equal((await journal()).length, before, "nothing was journaled for the unmanaged project");
});

test("a project with no binding at all is refused, never treated as legacy", async () => {
  task.project = 51;
  const r = await move("gpt", T.prog, blueprint());
  assert.match(JSON.stringify(payload(r)), /no binding/);
  assert.deepEqual(writes, []);
});

test("a database that is down refuses the transition with zero writes", async () => {
  const dead = createPolicyRuntime(createPool("postgresql://x:y@127.0.0.1:1/none", 1), BASE);
  const r = await move("gpt", T.prog, blueprint(), dead);
  assert.equal(r.isError, true);
  assert.deepEqual(writes, []);
});
