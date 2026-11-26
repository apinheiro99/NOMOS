import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "../dist/policy/migrate.js";
import { createPool, ProjectLockBusyError, withProjectLock } from "../dist/policy/repository.js";
import { createPolicyRuntime } from "../dist/policy/runtime.js";
import { approve, propose, reject, PolicyError } from "../dist/policy/service.js";
import { legacySeed } from "../dist/policy/legacy-seed.js";
import { guard } from "../dist/policy/pep.js";
import { connect, createTestDatabase } from "./support/pg.ts";
import { fakeTaiga } from "./support/taiga-fake.ts";

// Audit F2 #8-#10: a governed mutation and a policy change share ONE project lock; approval refuses unfinished work and a rejected proposal.
const QUIET = fakeTaiga("http://t"); // Taiga with nothing in flight
let db: Awaited<ReturnType<typeof createTestDatabase>>;
let pool: ReturnType<typeof createPool>;
const INSTANCE = randomUUID();
let taigaId = 200;
before(async () => {
  process.env.TAIGA_MCP_CONTINUATION_FILE = join(mkdtempSync(join(tmpdir(), "hold-")), "c.jsonl");
  db = await createTestDatabase();
  const c = await connect(db.url);
  await migrate(c, fileURLToPath(new URL("../db/migrations", import.meta.url)));
  await c.end();
  pool = createPool(db.url, 5);
  await pool.query("INSERT INTO taiga_instance (id, instance_key, base_url) VALUES ($1,'lab','http://t')", [INSTANCE]);
});
after(async () => { delete process.env.TAIGA_MCP_CONTINUATION_FILE; await pool.end(); await db.drop(); });

async function managed() {
  const id = randomUUID();
  await pool.query("INSERT INTO project_binding (id, instance_id, taiga_project_id, slug, name, lifecycle) VALUES ($1,$2,$3,'s','n','managed')", [id, INSTANCE, ++taigaId]);
  const v = await propose(pool, id, "gpt", legacySeed());
  await approve(pool, id, "po", { policyId: v.policyId, expectedRevision: null, hash: v.hash, reason: "seed" }, QUIET);
  return { id, taiga: taigaId };
}
const change = async (id: string, revision: number) => {
  const p = structuredClone(legacySeed());
  p.entities.task.transitions.find((t) => t.from === "to do" && t.to === "in progress")!.allow.push("claude");
  const v = await propose(pool, id, "gpt", p);
  return { v, ask: { policyId: v.policyId, expectedRevision: revision, hash: v.hash, reason: "r" } };
};

test("a mutation in flight blocks a policy change, and a policy change blocks a mutation", async () => {
  const runtime = createPolicyRuntime(pool, "http://t");
  const p = await managed();
  const { ask } = await change(p.id, 1);
  const { release } = (await runtime.hold(p.taiga))!;
  await assert.rejects(approve(pool, p.id, "po", ask, QUIET), ProjectLockBusyError);
  await release();
  const during = withProjectLock(pool, p.id, async () => runtime.hold(p.taiga));
  await assert.rejects(during, ProjectLockBusyError);
  assert.equal((await approve(pool, p.id, "po", ask, QUIET)).revision, 2);
});

test("two mutations of one project never run together: the second is refused while the first holds the lock", async () => {
  const runtime = createPolicyRuntime(pool, "http://t");
  const p = await managed();
  const first = (await runtime.hold(p.taiga))!;
  await assert.rejects(runtime.hold(p.taiga), ProjectLockBusyError);
  await first.release();
  await (await runtime.hold(p.taiga))!.release();
});

test("two concurrent starts of the same project: exactly one passes the guard and persists, the other is refused", async () => {
  const runtime = createPolicyRuntime(pool, "http://t");
  const p = await managed();
  const client = { get: async () => ({ project: p.taiga }) } as never;
  const args = { entity: "task", id: 1, to: "In Progress" };
  const out = await Promise.all([guard("taiga_workflow_transition", args, client, runtime, "gpt"), guard("taiga_workflow_transition", args, client, runtime, "gpt")]);
  const passed = out.filter((g) => !("refusal" in g));
  assert.equal(passed.length, 1);
  assert.match((out.find((g) => "refusal" in g) as { refusal: string }).refusal, /another request/);
  await (passed[0] as { release: (() => Promise<void>) | null }).release?.();
});

test("a rejected proposal can never be approved afterwards", async () => {
  const p = await managed();
  const { ask } = await change(p.id, 1);
  await reject(pool, p.id, "po", { policyId: ask.policyId, reason: "no" });
  await assert.rejects(approve(pool, p.id, "po", ask, QUIET), (e: PolicyError) => e.code === "rejected");
});

// What a refused approval must leave untouched: the active pointer, the activations, and no approved review for the proposal.
async function snapshot(id: string, policyId: string) {
  const q = async (sql: string, v: unknown[]) => (await pool.query(sql, v)).rows[0];
  return {
    active: (await q("SELECT active_activation_id FROM project_binding WHERE id = $1", [id])).active_activation_id as string,
    activations: (await q("SELECT count(*)::int AS n FROM policy_activation WHERE project_id = $1", [id])).n as number,
    approved: (await q("SELECT count(*)::int AS n FROM policy_review WHERE project_id = $1 AND policy_id = $2 AND decision = 'approved'", [id, policyId])).n as number,
  };
}
// Approval must be refused with this error and change nothing.
async function refused(id: string, ask: { policyId: string; expectedRevision: number; hash: string; reason: string }, taiga: ReturnType<typeof fakeTaiga>, code: string, status: number, label: string) {
  const before = await snapshot(id, ask.policyId);
  await assert.rejects(approve(pool, id, "po", ask, taiga), (e: PolicyError) => e.code === code && e.status === status, label);
  assert.deepEqual(await snapshot(id, ask.policyId), before, `${label}: nothing changed`);
}
const problemsOf = async (id: string, ask: Parameters<typeof refused>[1], taiga: ReturnType<typeof fakeTaiga>) => {
  try { await approve(pool, id, "po", ask, taiga); } catch (e) { return (e as PolicyError).problems; }
  throw new Error("the approval was not refused");
};

const journalOf = async (p: { id: string; taiga: number }, phase: "intent" | "applied" | "pending_effect" | "completed" | "failed") => {
  const runtime = createPolicyRuntime(pool, "http://t");
  const m = (await runtime.forProject(p.taiga))!;
  const id = await runtime.begin(m, "workflow_transition", `task:${p.taiga}`);
  if (phase === "applied") await runtime.finish(id, "applied", {});
  else if (phase !== "intent") await pool.query("UPDATE mutation_journal SET phase = $2 WHERE id = $1", [id, phase]);
  return { runtime, m, id };
};
// A merge obligation in the given state, through the runtime: its journal entry is finished `completed`, which the runtime keeps at `pending_effect` while the obligation is owed.
const withObligation = async (p: { id: string; taiga: number }, state: "pending" | "review" | "signed" | "abandoned") => {
  const runtime = createPolicyRuntime(pool, "http://t");
  const m = (await runtime.forProject(p.taiga))!;
  const journalId = await runtime.begin(m, "workflow_transition", `task:${p.taiga}`);
  const authorizationId = randomUUID();
  const context = { repository: "r", source_branch: "b", target_branch: "t", source_sha: "a".repeat(40), target_sha: "a".repeat(40) };
  await runtime.openMergeObligation(m, { authorizationId, journalId, actor: "gpt", recipient: "claude", approvalHash: "h", entity: "task", taigaId: 1, doneStatus: 5, taigaProject: p.taiga, ...(state === "review" ? {} : { context, workItem: { kind: "task", ref: 1 }, targetWorkItem: "Story #1" }) });
  await runtime.finish(journalId, "completed", {});
  if (state === "signed") await runtime.settleMergeObligation(authorizationId, { signed: { envelope: true } as never, approvalCommentId: "c1" });
  if (state === "abandoned") await runtime.settleMergeObligation(authorizationId, { abandoned: true });
  return { runtime, journalId, authorizationId };
};

// ----- A: the active statuses of EACH entity -----
const BLOCKING: [string, string, string][] = [
  ...["In Progress", "Request", "GPT Validation", "Human Decision"].map((s) => ["tasks", "task", s] as [string, string, string]),
  ...["In Progress", "GPT Validation", "Human Decision"].map((s) => ["userstories", "userstory", s] as [string, string, string]),
  ...["Active", "Blocked"].map((s) => ["epics", "epic", s] as [string, string, string]),
];
test("approval is refused with 409 active_work for every active status of a Task, Story and Epic: the card and its status are named, nothing changes", async () => {
  const p = await managed();
  const { ask } = await change(p.id, 1);
  for (const [path, card, status] of BLOCKING) {
    const taiga = fakeTaiga("http://t", { [path]: [[7, path === "tasks" ? "To Do" : path === "userstories" ? "Ready" : "Proposed"], [8, status]] });
    await refused(p.id, ask, taiga, "active_work", 409, `${card} ${status}`);
    const problems = await problemsOf(p.id, ask, taiga);
    assert.deepEqual(problems.map((x) => [x.code, x.where]), [["active_work", `${card} #8`]], `${card} ${status}`);
    assert.match(problems[0].detail, new RegExp(status.toLowerCase()));
  }
});

test("the inactive statuses of each entity never block, and an Epic Proposed is not work in flight", async () => {
  const p = await managed();
  const { ask } = await change(p.id, 1);
  const taiga = fakeTaiga("http://t", {
    tasks: [[1, "To Do"], [2, "Done"], [3, "Cancelled"]], userstories: [[1, "Ready"], [2, "Done"], [3, "Cancelled"]], epics: [[1, "Proposed"], [2, "Completed"], [3, "Archived"]],
  });
  assert.equal((await approve(pool, p.id, "po", ask, taiga)).revision, 2);
});

// ----- B: complete and trustworthy reading -----
test("a card whose status cannot be classified refuses the approval: absent information is never 'no active work'", async () => {
  const p = await managed();
  const { ask } = await change(p.id, 1);
  await refused(p.id, ask, fakeTaiga("http://t", { tasks: [[9, "(none)"]] }), "cards_in_unknown_state", 409, "a card with no status");
  await refused(p.id, ask, fakeTaiga("http://t", { tasks: [[9, "?"]] }), "cards_in_unknown_state", 409, "a status id Taiga does not list");
  await refused(p.id, ask, fakeTaiga("http://t", { tasks: [[9, "Limbo"]] }), "cards_in_unknown_state", 409, "a status the policy lacks");
  const down = new Error("ETIMEDOUT");
  await refused(p.id, ask, fakeTaiga("http://t", {}, { statuses: () => { throw down; } }), "taiga_unavailable", 503, "status metadata unavailable");
  await refused(p.id, ask, fakeTaiga("http://t", {}, { statuses: () => ({ detail: "nope" }) }), "taiga_unavailable", 503, "status metadata is not a list");
  await refused(p.id, ask, fakeTaiga("http://t", {}, { cards: () => { throw down; } }), "taiga_unavailable", 503, "cards unavailable");
  await refused(p.id, ask, fakeTaiga("http://t", {}, { cards: () => ({ results: [] }) }), "taiga_unavailable", 503, "cards response is not a list");
  assert.match((await problemsOf(p.id, ask, fakeTaiga("http://t", { tasks: [[9, "(none)"]] })))[0].detail, /task #9/);
});

test("an active card with no status_extra_info still blocks, and the reads are every card of the project (no is_closed filter, no Sprint filter)", async () => {
  const p = await managed();
  const { ask } = await change(p.id, 1);
  const calls: string[] = [];
  const seen: unknown[] = [];
  const taiga = fakeTaiga("http://t", { tasks: [[3, "In Progress"]] }, { calls });
  const original = taiga.client.getAll.bind(taiga.client);
  taiga.client.getAll = (async (path: string, params?: Record<string, unknown>) => { seen.push(params); return original(path, params); }) as never;
  await refused(p.id, ask, taiga, "active_work", 409, "In Progress without status_extra_info");
  assert.ok(seen.every((q) => JSON.stringify(q) === JSON.stringify({ project: p.taiga })), `only the project is asked for: ${JSON.stringify(seen)}`);
  assert.ok(calls.includes("GET /task-statuses") && calls.includes("GET /userstory-statuses") && calls.includes("GET /epic-statuses"));
});

// ----- E: the boundary of the approval -----
test("the first administrative activation needs Taiga too, and the Taiga session must be the instance the project is bound to", async () => {
  const id = randomUUID();
  await pool.query("INSERT INTO project_binding (id, instance_id, taiga_project_id, slug, name, lifecycle) VALUES ($1,$2,$3,'s','n','managed')", [id, INSTANCE, ++taigaId]);
  const v = await propose(pool, id, "gpt", legacySeed());
  const ask = { policyId: v.policyId, expectedRevision: null as never, hash: v.hash, reason: "first" };
  await assert.rejects(approve(pool, id, "po", ask), (e: PolicyError) => e.code === "taiga_unavailable" && e.status === 503);
  await assert.rejects(approve(pool, id, "po", ask, fakeTaiga("http://elsewhere")), (e: PolicyError) => e.code === "instance_mismatch" && e.status === 409);
  await assert.rejects(approve(pool, id, "po", ask, fakeTaiga("http://t", { epics: [[1, "Active"]] })), (e: PolicyError) => e.code === "active_work");
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM policy_activation WHERE project_id = $1", [id])).rows[0].n, 0);
  assert.equal((await approve(pool, id, "po", ask, fakeTaiga("http://t/"))).revision, 1);
});

test("approval needs Taiga when a policy is in force", async () => {
  const p = await managed();
  const { ask } = await change(p.id, 1);
  await refused(p.id, ask, undefined as never, "taiga_unavailable", 503, "no Taiga");
});

// ----- C: journal and merge obligations -----
test("every unfinished journal phase refuses the approval and names the entry; a completed or failed one does not", async () => {
  for (const phase of ["intent", "applied", "pending_effect"] as const) {
    const p = await managed();
    const { ask } = await change(p.id, 1);
    const { id } = await journalOf(p, phase);
    await refused(p.id, ask, QUIET, "pending_work", 409, phase);
    const problems = await problemsOf(p.id, ask, QUIET);
    assert.deepEqual(problems.map((x) => [x.code, x.where]), [[`journal_${phase}`, `journal:${id}`]]);
    assert.match(problems[0].detail, /workflow_transition task:/);
  }
  for (const phase of ["completed", "failed"] as const) {
    const p = await managed();
    const { ask } = await change(p.id, 1);
    await journalOf(p, phase);
    assert.equal((await approve(pool, p.id, "po", ask, QUIET)).revision, 2, phase);
  }
});

test("the counts of the pending-work message keep their names and add the other phases", async () => {
  const p = await managed();
  const { ask } = await change(p.id, 1);
  await journalOf(p, "intent");
  await assert.rejects(approve(pool, p.id, "po", ask, QUIET), (e: PolicyError) => /"journal_intents":1/.test(e.message) && /"journal_applied":0/.test(e.message) && /"journal_pending_effect":0/.test(e.message) && /"merge_obligations":0/.test(e.message) && /"continuations":0/.test(e.message));
});

test("a merge obligation pending or in review refuses; signed with its journal still pending_effect refuses; abandoned or signed and delivered does not", async () => {
  for (const state of ["pending", "review"] as const) {
    const p = await managed();
    const { ask } = await change(p.id, 1);
    const { authorizationId, journalId } = await withObligation(p, state);
    await refused(p.id, ask, QUIET, "pending_work", 409, `merge ${state}`);
    const problems = await problemsOf(p.id, ask, QUIET);
    assert.deepEqual(problems.map((x) => x.where).sort(), [`journal:${journalId}`, `merge_obligation:${authorizationId}`].sort(), state);
    assert.ok(problems.some((x) => x.code === `merge_${state}`));
  }
  {
    const p = await managed();
    const { ask } = await change(p.id, 1);
    const { journalId, authorizationId } = await withObligation(p, "signed");
    await refused(p.id, ask, QUIET, "pending_work", 409, "merge signed, delivery owed");
    const problems = await problemsOf(p.id, ask, QUIET);
    assert.deepEqual(problems.map((x) => [x.code, x.where]), [["journal_pending_effect", `journal:${journalId}`]], "the signature is not the delivery");
    assert.match(problems[0].detail, new RegExp(`merge obligation ${authorizationId}, signed`));
  }
  {
    const p = await managed();
    const { ask } = await change(p.id, 1);
    const { runtime, journalId } = await withObligation(p, "signed");
    await runtime.completeEffect(journalId);
    assert.equal((await approve(pool, p.id, "po", ask, QUIET)).revision, 2, "signed and delivered");
  }
  {
    const p = await managed();
    const { ask } = await change(p.id, 1);
    await withObligation(p, "abandoned");
    assert.equal((await approve(pool, p.id, "po", ask, QUIET)).revision, 2, "abandoned");
  }
});

// ----- D: continuations -----
test("a continuation of this project not yet handled refuses (pending and delivered); a handled one, or another project's, does not; the ledger is never touched", async () => {
  const { continuationOf, recordContinuation, ackContinuation } = await import("../dist/workflow/continuation.js");
  const file = process.env.TAIGA_MCP_CONTINUATION_FILE!;
  const p = await managed();
  const { ask } = await change(p.id, 1);
  const mine = continuationOf("TASK_DONE", "claude", "gpt", "task", 41, p.taiga, "a-1", { request_id: "req-1" });
  const handled = continuationOf("TASK_DONE", "gpt", "claude", "task", 42, p.taiga, "a-2");
  const other = continuationOf("TASK_DONE", "claude", "gpt", "task", 43, p.taiga + 1000, "a-3");
  for (const c of [mine, handled, other]) recordContinuation(c);
  ackContinuation(handled.id, "delivered", "gpt", "gpt");
  ackContinuation(handled.id, "handled", "gpt", "gpt");
  const ledger = () => readFileSync(file, "utf8");
  const before = ledger();
  await refused(p.id, ask, QUIET, "pending_work", 409, "continuation pending");
  const pending = await problemsOf(p.id, ask, QUIET);
  assert.deepEqual(pending.map((x) => [x.code, x.where]), [["continuation_pending", `continuation:${mine.id}`]]);
  assert.match(pending[0].detail, /task #41 to claude \(request req-1\)/);
  ackContinuation(mine.id, "delivered", "claude", "claude");
  await refused(p.id, ask, QUIET, "pending_work", 409, "continuation delivered");
  assert.equal((await problemsOf(p.id, ask, QUIET))[0].code, "continuation_delivered");
  const refusedLedger = ledger();
  assert.equal(refusedLedger.split("\n").length, before.split("\n").length + 1, "only the test's own acknowledge was appended: the refusals wrote nothing");
  ackContinuation(mine.id, "handled", "claude", "claude");
  assert.equal((await approve(pool, p.id, "po", ask, QUIET)).revision, 2, "handled and other-project continuations do not block");
});

test("a ledger that cannot be read does not let the approval through", async () => {
  const saved = process.env.TAIGA_MCP_CONTINUATION_FILE;
  const p = await managed();
  const { ask } = await change(p.id, 1);
  process.env.TAIGA_MCP_CONTINUATION_FILE = tmpdir(); // a directory: reading it fails
  try { await refused(p.id, ask, QUIET, "ledger_unavailable", 503, "unreadable ledger"); } finally { process.env.TAIGA_MCP_CONTINUATION_FILE = saved; }
});

// ----- the lock -----
test("an approval racing a governed mutation never lands in the middle of it, and the mutation after it sees the new revision", async () => {
  const runtime = createPolicyRuntime(pool, "http://t");
  const p = await managed();
  const { ask } = await change(p.id, 1);
  // A: a mutation holds the lock, the approval is told it is busy and persists nothing.
  const held = (await runtime.hold(p.taiga))!;
  const before = await snapshot(p.id, ask.policyId);
  await assert.rejects(approve(pool, p.id, "po", ask, QUIET), ProjectLockBusyError);
  assert.deepEqual(await snapshot(p.id, ask.policyId), before, "busy: nothing persisted");
  await held.release();
  // B: the approval holds the lock while it reads Taiga (the test decides when the read ends); another mutation is refused meanwhile.
  let reading!: () => void, resume!: () => void;
  const started = new Promise<void>((r) => { reading = r; });
  const gate = new Promise<void>((r) => { resume = r; });
  const taiga = fakeTaiga("http://t", {}, { before: async () => { reading(); await gate; } });
  const approving = approve(pool, p.id, "po", ask, taiga);
  await started;
  assert.equal((await runtime.hold(p.taiga).then((h) => h, (e) => e)) instanceof ProjectLockBusyError, true, "a mutation is refused while the approval reads Taiga");
  resume();
  assert.equal((await approving).revision, 2);
  const next = (await runtime.hold(p.taiga))!;
  assert.equal(next.managed.revision, 2, "the next operation already runs on the revision just approved");
  await next.release();
});

test("two approvals of the same project: only one persists", async () => {
  const p = await managed();
  const a = await change(p.id, 1);
  const b = await change(p.id, 1);
  const results = await Promise.allSettled([approve(pool, p.id, "po", a.ask, QUIET), approve(pool, p.id, "po", b.ask, QUIET)]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM policy_activation WHERE project_id = $1", [p.id])).rows[0].n, 2);
});

// The real TaigaClient against a real HTTP server that only gives the whole list when asked with x-disable-pagination: a card "on a later page" is seen.
test("the approval reads every page through the real TaigaClient (x-disable-pagination), so an active card on a later page blocks", async () => {
  const { createServer } = await import("node:http");
  const { TaigaClient } = await import("../dist/client.js");
  const { PROJECT_PROFILE } = await import("../dist/project-profile.js");
  const asked: string[] = [];
  const server = createServer((req, res) => {
    const path = new URL(req.url!, "http://x").pathname.replace("/api/v1", "");
    res.setHeader("content-type", "application/json");
    const lists: Record<string, unknown> = {
      "/task-statuses": PROJECT_PROFILE["task-statuses"].map((s, i) => ({ id: i + 1, name: s.name, is_closed: !!s.is_closed })),
      "/userstory-statuses": PROJECT_PROFILE["userstory-statuses"].map((s, i) => ({ id: i + 1, name: s.name, is_closed: !!s.is_closed })),
      "/epic-statuses": PROJECT_PROFILE["epic-statuses"].map((s, i) => ({ id: i + 1, name: s.name, is_closed: !!s.is_closed })),
      "/userstories": [], "/epics": [],
      // 31 cards: the first page (30) is all To Do; the In Progress one is the 31st.
      "/tasks": [...Array.from({ length: 30 }, (_, i) => ({ ref: i + 1, status: 1 })), ...(req.headers["x-disable-pagination"] ? [{ ref: 31, status: 2 }] : [])],
    };
    if (path === "/auth") { res.end(JSON.stringify({ auth_token: "t" })); return; }
    asked.push(`${path} ${req.headers["x-disable-pagination"] ?? "paged"}`);
    res.end(JSON.stringify(lists[path] ?? []));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const client = new TaigaClient({ url, username: "u", password: "p" });
    const p = await managed();
    const { ask } = await change(p.id, 1);
    await refused(p.id, ask, { client, baseUrl: "http://t" }, "active_work", 409, "an active card on a later page");
    assert.ok(asked.includes("/tasks True"), `the card list is read in full: ${asked.join(", ")}`);
  } finally { server.close(); }
});
