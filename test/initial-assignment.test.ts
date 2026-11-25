import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { TaigaClient } from "../dist/client.js";
import { createTaigaMcpServer } from "../dist/server.js";
import { actorFor } from "../dist/workflow/actor.js";
import { backfillSprintAssignees, createdWithOwner } from "../dist/workflow/assignment.js";

// Task 384: a card CREATED in an owned status gets its owner, bulk and promoted cards included; the backfill repairs open Sprint cards, writes
// only assigned_to, never reads watchers and is idempotent.
const env = { TAIGA_URL: "http://taiga.invalid", TAIGA_USERNAME: "u", TAIGA_PASSWORD: "p" };
const ACCOUNTS = { TAIGA_MCP_EXPECTED_ACCOUNT_GPT: "chatgpt", TAIGA_MCP_EXPECTED_ACCOUNT_CLAUDE: "claudecode", TAIGA_MCP_EXPECTED_ACCOUNT_PO: "po" };
const TASK_ST = [[1, "To Do"], [2, "In Progress"], [3, "GPT Validation"], [4, "Human Decision"], [5, "Done"], [6, "Cancelled"]].map(([id, name]) => ({ id, name }));
const STORY_ST = [[10, "Ready"], [11, "In Progress"], [12, "GPT Validation"], [13, "Done"], [14, "Human Decision"], [15, "Cancelled"]].map(([id, name]) => ({ id, name }));
const USERS = [{ id: 71, username: "chatgpt", is_active: true }, { id: 72, username: "claudecode", is_active: true }, { id: 73, username: "po", is_active: true }];

const realFetch = globalThis.fetch;
const saved: Record<string, string | undefined> = {};
type Row = Record<string, unknown>;
let world: { tasks: Row[]; stories: Row[]; users: Row[]; next: number; writes: { method: string; path: string; body: unknown }[]; ignoreAssignee: boolean; afterCreate?: (row: Row) => void };
let dir: string;

beforeEach(() => {
  for (const k of [...Object.keys(env), "TAIGA_MCP_GOVERNANCE_FILE", ...Object.keys(ACCOUNTS)]) saved[k] = process.env[k];
  Object.assign(process.env, env, ACCOUNTS);
  dir = mkdtempSync(join(tmpdir(), "ia-"));
  writeFileSync(join(dir, "governance.json"), JSON.stringify({ enabled: false }));
  process.env.TAIGA_MCP_GOVERNANCE_FILE = join(dir, "governance.json");
  world = { tasks: [], stories: [], users: USERS, next: 100, writes: [], ignoreAssignee: false };
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
  globalThis.fetch = (async (url: string, init: { method?: string; body?: string } = {}) => {
    const u = new URL(String(url));
    const path = u.pathname.replace(/^.*\/api\/v1/, "");
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(init.body) : undefined;
    if (path === "/auth") return json({ auth_token: "t", refresh: "r" });
    if (method !== "GET") world.writes.push({ method, path, body });
    const make = (list: Row[], extra: Row) => { const row = { id: world.next++, ref: world.next, version: 1, watchers: [71], assigned_to: null, ...extra }; list.push(row); return row; };
    let m: RegExpExecArray | null;
    if (method === "GET") {
      if (path === "/projects/49") return json({ default_task_status: 1, default_us_status: 10 });
      if (path === "/task-statuses") return json(TASK_ST);
      if (path === "/userstory-statuses") return json(STORY_ST);
      if (path === "/users") return json(world.users);
      if (path === "/users/me") return json({ username: "chatgpt" });
      if (path === "/milestones/187") return json({ id: 187, project: 49 });
      if (path === "/tasks") return json(world.tasks);
      if (path === "/userstories") return json(world.stories);
      if (path === "/userstories/by_ref") return json(world.stories.at(-1));
      if ((m = /^\/(tasks|userstories)\/(\d+)$/.exec(path))) return json((m[1] === "tasks" ? world.tasks : world.stories).find((r) => r.id === Number(m![2])));
      return json([]);
    }
    if (method === "POST") {
      if (path === "/tasks") { const row = make(world.tasks, { project: body.project, status: body.status ?? 1, subject: body.subject }); const response = json(row, 201); world.afterCreate?.(row); return response; }
      if (path === "/userstories") return json(make(world.stories, { project: body.project, status: body.status ?? 10, subject: body.subject }), 201);
      if (path === "/tasks/bulk_create") return json(["a", "b"].map((s) => make(world.tasks, { project: body.project_id, status: body.status_id ?? 1, subject: s })), 200);
      if (path === "/issues/9/promote_to_user_story") { make(world.stories, { project: body.project_id, status: 10, subject: "from issue" }); return json([world.stories.at(-1)!.ref]); }
      return json({}, 201);
    }
    if (method === "PATCH" && (m = /^\/(tasks|userstories)\/(\d+)$/.exec(path))) {
      const row = (m[1] === "tasks" ? world.tasks : world.stories).find((r) => r.id === Number(m![2]))!;
      // eslint-disable-next-line @typescript-eslint/no-unused-vars -- rest-omit
      const { version, ...rest } = body;
      if (world.ignoreAssignee) delete rest.assigned_to;
      Object.assign(row, rest, { version: row.version + 1 });
      return json(row);
    }
    return json({});
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  rmSync(dir, { recursive: true, force: true });
});

async function call(name: string, args: Record<string, unknown>) {
  const server = createTaigaMcpServer(new TaigaClient(), { mode: "authenticated", actor: actorFor("gpt") });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "1" });
  await Promise.all([server.connect(a), client.connect(b)]);
  try { const r = await client.callTool({ name, arguments: args }); return { isError: r.isError, text: (r.content as { text: string }[])[0].text }; } finally { await client.close(); }
}

test("a fresh Task in To Do and a fresh Story in Ready are created already assigned to ChatGPT", async () => {
  const t = await call("taiga_tasks_create", { user_story: 1, project: 49, subject: "t" });
  assert.equal(world.tasks[0].assigned_to, 71, t.text);
  const s = await call("taiga_userstories_create", { project: 49, subject: "s" });
  assert.equal(world.stories[0].assigned_to, 71, s.text);
});

test("the owner follows the status the card is created in", async () => {
  await call("taiga_tasks_create", { user_story: 1, project: 49, subject: "running", status: 2 });
  assert.equal(world.tasks[0].assigned_to, 72, "In Progress is Claude-owned");
  await call("taiga_tasks_create", { user_story: 1, project: 49, subject: "closed", status: 5 });
  assert.equal(world.tasks[1].assigned_to, null, "Done is not projected");
});

test("bulk-created Tasks, bulk Stories and an Issue promoted to a Story are assigned too", async () => {
  await call("taiga_tasks_bulk_create", { project_id: 49, us_id: 1, bulk_tasks: "a\nb" });
  assert.deepEqual(world.tasks.map((x) => x.assigned_to), [71, 71]);
  await call("taiga_issues_promote_to_userstory", { id: 9, project_id: 49 });
  assert.equal(world.stories[0].assigned_to, 71);
});

test("an unresolvable owner creates nothing", async () => {
  world.users = USERS.filter((u) => u.username !== "chatgpt");
  const r = await call("taiga_tasks_create", { user_story: 1, project: 49, subject: "t" });
  assert.match(r.text, /WORKFLOW_ASSIGNEE_UNRESOLVED/);
  assert.equal(world.writes.length, 0, "no create, no patch");
});

test("without any expected account the creation is untouched (legacy behaviour)", async () => {
  for (const k of Object.keys(ACCOUNTS)) delete process.env[k];
  await call("taiga_tasks_create", { user_story: 1, project: 49, subject: "t" });
  assert.equal(world.tasks[0].assigned_to, null);
  assert.ok(!world.writes.some((w) => w.body?.assigned_to !== undefined), "no assignment write");
});

test("an assignee that did not persist is reported on the created card, not hidden", async () => {
  world.ignoreAssignee = true;
  const created = (await createdWithOwner(new TaigaClient(), "task", { project: 49 }, async () => { const row = { id: 100, version: 1, status: 1, assigned_to: null }; world.tasks.push(row); return row; })) as Row;
  assert.match(created.assignee_integrity, /not the projected owner/);
});

test("backfill repairs only wrong or empty owners, ignores watchers, skips closed cards and is idempotent", async () => {
  world.stories.push({ id: 1, ref: 370, version: 3, status: 11, assigned_to: null, watchers: [71] }, { id: 2, ref: 371, version: 1, status: 13, assigned_to: null });
  world.tasks.push({ id: 3, ref: 377, version: 2, status: 1, assigned_to: null, watchers: [72] }, { id: 4, ref: 378, version: 2, status: 2, assigned_to: 71 }, { id: 5, ref: 379, version: 2, status: 4, assigned_to: 73 }, { id: 6, ref: 380, version: 2, status: 5, assigned_to: null });
  const dry = await backfillSprintAssignees(new TaigaClient(), 187, true);
  assert.equal(world.writes.length, 0, "dry run writes nothing");
  assert.deepEqual(dry.updated.map((u: { ref: number }) => u.ref), [370, 377, 378]);
  const first = await backfillSprintAssignees(new TaigaClient(), 187, false);
  assert.deepEqual([first.updated.length, first.already_correct, first.skipped, first.failed.length], [3, 1, 2, 0]);
  assert.deepEqual([world.stories[0].assigned_to, world.tasks[0].assigned_to, world.tasks[1].assigned_to], [71, 71, 72], "targets come from the status, not the watchers or the old assignee");
  assert.ok(world.writes.every((w) => w.method === "PATCH" && Object.keys(w.body).sort().join() === "assigned_to,version"), "only assigned_to (plus the version guard) is written");
  assert.deepEqual([world.stories[0].status, world.tasks[1].status], [11, 2], "status untouched");
  const second = await backfillSprintAssignees(new TaigaClient(), 187, false);
  assert.deepEqual([second.updated.length, second.already_correct], [0, 4], "idempotent");
});

test("the backfill tool is dry-run by default and fails closed without a configured owner", async () => {
  world.tasks.push({ id: 3, ref: 377, version: 2, status: 1, assigned_to: null });
  const r = await call("taiga_assignees_backfill", { milestone: 187 });
  assert.equal(JSON.parse(r.text).dry_run, true);
  assert.equal(world.writes.length, 0);
  world.users = USERS.filter((u) => u.username !== "chatgpt");
  const failed = JSON.parse((await call("taiga_assignees_backfill", { milestone: 187, dry_run: false })).text);
  assert.equal(failed.failed.length, 1, "a missing member is reported, nothing is written");
  assert.equal(world.writes.length, 0);
});

test("creation rereads the card from Taiga before the assignment: the fresh version is used, the create response is not (F2)", async () => {
  world.afterCreate = (row) => { row.version = 5; }; // Taiga moved the card on after answering the create
  await call("taiga_tasks_create", { user_story: 1, project: 49, subject: "t" });
  const patch = world.writes.find((w) => w.method === "PATCH" && w.body.assigned_to !== undefined)!;
  assert.equal(patch.body.version, 5, "version from the fresh read, not the create response (1)");
  assert.equal(world.tasks[0].assigned_to, 71);
});

test("creation skips the assignment write when the fresh card is already assigned correctly", async () => {
  world.afterCreate = (row) => { row.assigned_to = 71; }; // Taiga (or a rule) already assigned it
  await call("taiga_tasks_create", { user_story: 1, project: 49, subject: "t" });
  assert.ok(!world.writes.some((w) => w.body?.assigned_to !== undefined), "no assignment PATCH");
  assert.equal(world.tasks[0].assigned_to, 71);
});
