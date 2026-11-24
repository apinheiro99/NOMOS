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
import { ensureEngineeringReview, keepCanonicalOrder, sprintIssueFindings, REVIEW_SUBJECT, REVIEW_TASKS } from "../dist/workflow/engineering-review.js";

// Issue #250: every governed Sprint gets exactly one "FINAL Sprint Engineering Review" Story with the standard Tasks, kept in canonical order (unfinished -> FINAL -> Done history).
// In-memory Taiga: stories, tasks, issues and milestones are real state, so idempotency and order are observed, not assumed. Mock data only.
const realFetch = globalThis.fetch;
const env = { TAIGA_URL: "http://taiga.invalid", TAIGA_USERNAME: "u", TAIGA_PASSWORD: "p" };
const saved: Record<string, string | undefined> = {};
const STRICT = [[10, "Ready"], [11, "In Progress"], [12, "GPT Validation"], [13, "Done"], [14, "Human Decision"], [15, "Cancelled"]].map(([id, name], i) => ({ id, name, order: i + 1, is_closed: name === "Done" || name === "Cancelled" }));
type Row = Record<string, any>;
let world: { milestones: Row[]; stories: Row[]; tasks: Row[]; issues: Row[]; next: number; failReviewPost: boolean }, dir: string, requests: { method: string; path: string }[];

beforeEach(() => {
  for (const k of Object.keys(env)) { saved[k] = process.env[k]; process.env[k] = (env as Record<string, string>)[k]; }
  saved.GOV = process.env.TAIGA_MCP_GOVERNANCE_FILE;
  dir = mkdtempSync(join(tmpdir(), "er-"));
  writeFileSync(join(dir, "governance.json"), JSON.stringify({ enabled: true }));
  process.env.TAIGA_MCP_GOVERNANCE_FILE = join(dir, "governance.json");
  world = { milestones: [{ id: 300, project: 49 }, { id: 400, project: 50 }], stories: [], tasks: [], issues: [], next: 1000, failReviewPost: false };
  requests = [];
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
  globalThis.fetch = (async (url: string, init: { method?: string; body?: string } = {}) => {
    const u = new URL(String(url));
    const path = u.pathname.replace(/^.*\/api\/v1/, "");
    const q = (k: string) => u.searchParams.get(k);
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(init.body) : undefined;
    if (path === "/auth") return json({ auth_token: "t", refresh: "r" });
    requests.push({ method, path });
    let m: RegExpExecArray | null;
    if (path === "/userstory-statuses") return json(Number(q("project")) === 49 ? STRICT : []);
    if (method === "POST" && path === "/milestones") { const row = { id: world.next++, ...body }; world.milestones.push(row); return json(row, 201); }
    if ((m = /^\/milestones\/(\d+)$/.exec(path))) { const row = world.milestones.find((x) => x.id === Number(m![1])); return row ? json(row) : json({}, 404); }
    if (path === "/userstories" && method === "GET") { const ms = Number(q("milestone")); return json(world.stories.filter((s) => s.milestone === ms).sort((a, b) => a.sprint_order - b.sprint_order)); }
    if (path === "/userstories" && method === "POST") {
      if (world.failReviewPost && body.subject === REVIEW_SUBJECT) return json({ error: "boom" }, 500);
      const sprintOrder = Math.max(0, ...world.stories.filter((s) => s.milestone === body.milestone).map((s) => s.sprint_order)) + 1;
      const row = { id: world.next++, ref: world.next, version: 1, sprint_order: sprintOrder, ...body }; world.stories.push(row); return json(row, 201);
    }
    if ((m = /^\/userstories\/(\d+)$/.exec(path))) {
      const row = world.stories.find((x) => x.id === Number(m![1]))!;
      if (method === "PATCH") { Object.assign(row, body, { version: row.version + 1 }); }
      return json(row);
    }
    if (path === "/tasks" && method === "GET") return json(world.tasks.filter((t) => t.user_story === Number(q("user_story"))));
    if (path === "/tasks" && method === "POST") { const row = { id: world.next++, ...body }; world.tasks.push(row); return json(row, 201); }
    if ((m = /^\/issues\/(\d+)$/.exec(path))) { const row = world.issues.find((x) => x.id === Number(m![1])); return row ? json(row) : json({}, 404); }
    if (/promote_to_user_story$/.test(path)) return json([5]);
    if (path === "/userstories/by_ref") return json({ id: 1, ref: 5, project: 49 });
    return json({}, 404);
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const k of Object.keys(env)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  if (saved.GOV === undefined) delete process.env.TAIGA_MCP_GOVERNANCE_FILE; else process.env.TAIGA_MCP_GOVERNANCE_FILE = saved.GOV;
  rmSync(dir, { recursive: true, force: true });
});

async function call(name: string, args: Record<string, unknown>) {
  const server = createTaigaMcpServer(new TaigaClient(), { mode: "authenticated", actor: actorFor("gpt") });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "1" });
  await Promise.all([server.connect(a), client.connect(b)]);
  try { const r = await client.callTool({ name, arguments: args }); return { isError: r.isError, ...JSON.parse((r.content as { text: string }[])[0].text) }; } finally { await client.close(); }
}
const reviews = (sprint: number) => world.stories.filter((s) => s.milestone === sprint && s.subject === REVIEW_SUBJECT);
const lastSubject = (sprint: number) => world.stories.filter((s) => s.milestone === sprint).sort((a, b) => a.sprint_order - b.sprint_order).at(-1)?.subject;
const newSprint = { project: 49, name: "S", estimated_start: "2026-11-01", estimated_finish: "2026-11-14" };

test("governed Sprint creation yields exactly one FINAL review Story with the full standard Task set, last", async () => {
  const r = await call("taiga_milestones_create", newSprint);
  assert.equal(r.isError, undefined);
  assert.equal(r.engineering_review.story_created, true);
  assert.equal(r.engineering_review.tasks_created, REVIEW_TASKS.length);
  assert.equal(reviews(r.id).length, 1);
  assert.deepEqual(world.tasks.filter((t) => t.user_story === r.engineering_review.story_id).map((t) => t.subject), [...REVIEW_TASKS]);
  const story = world.stories.find((x) => x.id === r.engineering_review.story_id)!;
  assert.ok(!story.description.includes("Per the Sprint Engineering Review contract"), "FINAL Story has no generic fallback section");
  for (const section of ["Purpose", "Context", "What to do", "Deliverables", "Acceptance / Evidence", "Do not", "Dependencies", "Documentation", "Execution Notes"]) {
    const body = new RegExp(`\\*\\*${section.replace("/", "\\/")}\\*\\*\\n([^]*?)(?=\\n\\*\\*|$)`).exec(story.description)?.[1].trim() ?? "";
    assert.ok(body.length > 40, `FINAL Story section is substantive: ${section}`);
  }
  assert.equal(REVIEW_TASKS.length, 1, "exactly one integrated review Task");
  assert.ok(world.tasks.every((t) => /\*\*Purpose\*\*/.test(t.description)), "governed-shaped descriptions");
  for (const axis of ["architecture, ownership and DRY", "SOLID, KISS, YAGNI", "hardcoded values", "source-of-truth", "idempotency", "typecheck and lint", "Issue hygiene", "readiness"]) assert.ok(world.tasks[0].description.includes(axis), `integrated Task covers: ${axis}`);
});

test("repeated ensure is idempotent: no second Story, no duplicate Tasks", async () => {
  const r = await call("taiga_milestones_create", newSprint);
  const again = await ensureEngineeringReview(new TaigaClient(), r.id);
  assert.deepEqual([again.story_created, again.tasks_created], [false, 0]);
  assert.equal(reviews(r.id).length, 1);
  assert.equal(world.tasks.length, REVIEW_TASKS.length);
});

test("a later Story appended after FINAL, and a reorder past it, both leave FINAL last", async () => {
  const r = await call("taiga_milestones_create", newSprint);
  const created = await call("taiga_userstories_create", { project: 49, subject: "Normal", milestone: r.id });
  assert.equal(created.isError, undefined);
  assert.equal(lastSubject(r.id), REVIEW_SUBJECT, "create hook");
  const normal = world.stories.find((s) => s.subject === "Normal")!;
  const final = reviews(r.id)[0];
  const moved = await call("taiga_move", { kind: "story_in_sprint", id: normal.id, container_id: r.id, after_id: final.id });
  assert.equal(moved.isError, undefined, JSON.stringify(moved));
  assert.equal(lastSubject(r.id), REVIEW_SUBJECT, "move hook");
});

test("non-governed project and governance OFF keep the legacy behavior: no FINAL Story", async () => {
  await call("taiga_milestones_create", { ...newSprint, project: 50 });
  assert.equal(world.stories.length, 0);
  writeFileSync(join(dir, "governance.json"), JSON.stringify({ enabled: false }));
  await call("taiga_milestones_create", newSprint);
  assert.equal(world.stories.length, 0);
});

test("a failing review create is a structured failure with the persisted Sprint reported, never a clean success", async () => {
  world.failReviewPost = true;
  const r = await call("taiga_milestones_create", newSprint);
  assert.equal(r.isError, true);
  assert.equal(r.code, "ENGINEERING_REVIEW_FAILED");
  assert.ok(r.persisted.id, "the Sprint itself exists");
});

test("duplicate FINAL Stories are reported, never silently accepted", async () => {
  world.stories.push({ id: 1, ref: 1, version: 1, milestone: 300, sprint_order: 1, subject: REVIEW_SUBJECT }, { id: 2, ref: 2, version: 1, milestone: 300, sprint_order: 2, subject: REVIEW_SUBJECT });
  await assert.rejects(ensureEngineeringReview(new TaigaClient(), 300), /exactly one is required/);
});

test("keepCanonicalOrder without a review Story does nothing (existing Sprints are not retrofitted by side effect)", async () => {
  world.stories.push({ id: 1, ref: 1, version: 1, milestone: 300, sprint_order: 1, subject: "Normal" });
  assert.deepEqual(await keepCanonicalOrder(new TaigaClient(), 300), { present: false, moved: false });
  assert.equal(requests.filter((r) => r.method !== "GET").length, 0);
});

test("Issue -> Sprint hygiene: every lifecycle combination, audit facts, nothing fabricated for Stories without a source Issue, reminder at promotion", async () => {
  const closed = (c: boolean) => ({ status_extra_info: { is_closed: c } });
  world.issues.push(
    { id: 7, ref: 70, milestone: null, ...closed(false) },
    { id: 8, ref: 80, milestone: 300, ...closed(true), modified_date: "2026-11-05T00:00:00Z", finished_date: "2026-11-05T00:00:00Z" },
    { id: 9, ref: 90, milestone: 300, ...closed(false) },
    { id: 10, ref: 100, milestone: 300, ...closed(false) },
    { id: 11, ref: 110, milestone: 300, ...closed(true) },
  );
  const story = (id: number, extra: Row) => ({ id, ref: id, version: 1, milestone: 300, sprint_order: id, subject: `s${id}`, ...extra });
  world.stories.push(
    story(1, {}),
    story(2, { generated_from_issue: 7, ...closed(false) }),
    story(3, { generated_from_issue: 8, ...closed(false) }),
    story(4, { generated_from_issue: 9, ...closed(false) }),
    story(5, { generated_from_issue: 10, ...closed(true), finish_date: "2026-11-06T00:00:00Z" }),
    story(6, { generated_from_issue: 11, ...closed(true) }),
  );
  const f = await sprintIssueFindings(new TaigaClient(), 300);
  assert.equal(f.ok, false);
  assert.deepEqual(f.findings.map((x) => [x.issue, x.finding]), [[7, "issue_not_in_sprint"], [8, "issue_closed_story_open"], [10, "story_closed_issue_open"]], "open/open and closed/closed raise nothing");
  assert.deepEqual(f.audit.map((x) => x.issue), [7, 8, 9, 10, 11], "the Story without a source Issue is not audited");
  const a8 = f.audit.find((x) => x.issue === 8)!;
  assert.deepEqual([a8.issue_ref, a8.issue_milestone, a8.issue_closed, a8.story_closed, a8.issue_modified, a8.issue_finished, a8.story_modified], [80, 300, true, false, "2026-11-05T00:00:00Z", "2026-11-05T00:00:00Z", null], "timestamps are nullable facts");
  assert.equal(f.audit.find((x) => x.issue === 10)!.story_finished, "2026-11-06T00:00:00Z");
  const promoted = await call("taiga_issues_promote_to_userstory", { id: 7, project_id: 49 });
  assert.equal(promoted.sprint_hygiene.finding, "issue_without_sprint");
  const inSprint = await call("taiga_issues_promote_to_userstory", { id: 9, project_id: 49 });
  assert.equal(inSprint.sprint_hygiene, undefined);
});

test("an existing Sprint review with old Tasks is never deleted or rewritten by a later ensure", async () => {
  const r = await call("taiga_milestones_create", newSprint);
  const old = { id: world.next++, user_story: r.engineering_review.story_id, subject: "Review architecture, ownership and DRY", description: "old" };
  world.tasks.push(old);
  await ensureEngineeringReview(new TaigaClient(), r.id);
  assert.ok(world.tasks.includes(old) && old.description === "old", "old Task untouched");
  assert.equal(requests.filter((q) => q.method === "DELETE").length, 0);
});
