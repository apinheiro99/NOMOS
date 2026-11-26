import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "../dist/policy/migrate.js";
import { createPool, ProjectLockBusyError } from "../dist/policy/repository.js";
import { createPolicyRuntime } from "../dist/policy/runtime.js";
import { approve, propose, PolicyError, type TaigaAccess } from "../dist/policy/service.js";
import { legacySeed } from "../dist/policy/legacy-seed.js";
import type { Policy } from "../dist/policy/types.js";
import { announce, continuationOf, foldContinuations, pendingContinuations, recordContinuation, ackContinuation } from "../dist/workflow/continuation.js";
import { recordHandledEvidence } from "../dist/workflow/continuation-evidence.js";
import { renderArtifact } from "../dist/workflow/render.js";
import { latest, loadTemplates, nameFor } from "../dist/workflow/templates.js";
import { connect, createTestDatabase } from "./support/pg.ts";
import { fakeTaiga } from "./support/taiga-fake.ts";

// A-6: the continuation ledger is derived state. An approval rebuilds it from Taiga, with the policy that authorized each event, before it says "nothing pending".
let db: Awaited<ReturnType<typeof createTestDatabase>>;
let pool: ReturnType<typeof createPool>;
let runtime: ReturnType<typeof createPolicyRuntime>;
let dir = "";
let ledger = "";
let taigaId = 900;
const INSTANCE = randomUUID();
before(async () => {
  db = await createTestDatabase();
  const c = await connect(db.url);
  await migrate(c, fileURLToPath(new URL("../db/migrations", import.meta.url)));
  await c.end();
  pool = createPool(db.url, 5);
  runtime = createPolicyRuntime(pool, "http://t");
  await pool.query("INSERT INTO taiga_instance (id, instance_key, base_url) VALUES ($1,'lab','http://t')", [INSTANCE]);
});
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "cont-")); ledger = join(dir, "c.jsonl"); process.env.TAIGA_MCP_CONTINUATION_FILE = ledger; });
after(async () => { delete process.env.TAIGA_MCP_CONTINUATION_FILE; await pool.end(); await db.drop(); });

const gptOnly = () => JSON.parse(readFileSync(new URL("./fixtures/policy/gpt-only.json", import.meta.url), "utf8")) as Policy;
const DAY = 86_400_000;
const L = () => ["x"];
const APPROVAL = { type: "validation_approval", blueprint_comment_id: "b", handoff_comment_id: "h", commits_validated: L(), cumulative_diff_review: "reviewed", contracts_rechecked: L(), owners_rechecked: L(), acceptance_results: L(), tests_verified: L(), runtime_evidence_verified: L(), regression_hunt: L(), issues_created: L(), known_limits: L(), po_gates_not_run: L(), verdict: "approved" };

// A managed project with `policy` in force, a second proposal ready, and a Taiga holding one Done Task (its Story still open) in an open Sprint,
// whose history carries the GPT approval that owes a TASK_DONE continuation. `writtenAt`: before the first activation = legacy event; after = managed.
async function scenario({ policy = legacySeed(), writtenAt = new Date(Date.now() + DAY).toISOString(), journaled = true } = {}) {
  const id = randomUUID();
  const taiga = ++taigaId;
  await pool.query("INSERT INTO project_binding (id, instance_id, taiga_project_id, slug, name, lifecycle) VALUES ($1,$2,$3,'s','n','managed')", [id, INSTANCE, taiga]);
  const first = await propose(pool, id, "gpt", policy);
  await approve(pool, id, "po", { policyId: first.policyId, expectedRevision: null, hash: first.hash, reason: "seed" }, fakeTaiga("http://t"));
  const next = structuredClone(policy);
  if (!next.roles.includes("claude")) next.roles.push("claude");
  next.entities.task.transitions[0].allow.push("claude");
  next.entities.task.transitions[0].allow = [...new Set(next.entities.task.transitions[0].allow)];
  next.entities.task.states["in progress"].owner = next.entities.task.states["in progress"].owner === "gpt" ? "claude" : "gpt"; // the NEW policy names another owner
  const v = await propose(pool, id, "gpt", next);
  const comment = `c-approval-${taiga}`;
  if (journaled) {
    const j = await runtime.begin((await runtime.forProject(taiga))!, "workflow_transition", "task:7");
    await runtime.finish(j, "completed", { comment_id: comment });
  }
  const text = renderArtifact({ template: latest(loadTemplates(), nameFor("validation_approval")), entity: "task", artifact: APPROVAL, author: "gpt", transition: { from: "GPT Validation", to: "Done" } });
  const history = [{ id: comment, comment: text, created_at: writtenAt }];
  const base = fakeTaiga("http://t");
  const status = async (collection: string, name: string) => ((await base.client.get(`/${collection}`)) as { id: number; name: string }[]).find((s) => s.name === name)!.id;
  const story = { id: 3, ref: 3, status: await status("userstory-statuses", "Ready") };
  const task = { id: 7, ref: 905, status: await status("task-statuses", "Done"), user_story: 3, version: 1 };
  const writes: string[] = [];
  const hooks: { history?: () => Promise<unknown>; milestones?: unknown } = {};
  const client = {
    get: async (path: string) => {
      if (path === "/tasks/by_ref" || path === "/tasks/7") return { ...task };
      if (path.startsWith("/history/")) return []; // the first page only: recovery must ask for the whole history
      return base.client.get(path);
    },
    getAll: async (path: string) => {
      if (path === "/milestones") return hooks.milestones ?? [{ id: 1 }];
      if (path === "/tasks") return [task];
      if (path === "/userstories") return [story];
      if (path === "/history/task/7") return hooks.history ? hooks.history() : history;
      return [];
    },
    patch: async (path: string, body: { comment?: string }) => { writes.push(path); if (body.comment) history.push({ id: `h-${history.length}`, comment: body.comment, created_at: new Date(Date.now() + 2 * DAY).toISOString() }); task.version++; return { ...task }; },
  };
  const access = { baseUrl: "http://t", client, runtime } as unknown as TaigaAccess;
  const ask = { policyId: v.policyId, expectedRevision: 1, hash: v.hash, reason: "r" };
  const owed = continuationOf("TASK_DONE", "claude", "gpt", "task", 905, taiga, comment, { status: "Done" });
  return { id, taiga, ask, access, hooks, history, writes, owed, comment };
}
type Scenario = Awaited<ReturnType<typeof scenario>>;
const snapshot = async (s: Scenario) => (await pool.query(
  `SELECT active_activation_id, (SELECT count(*)::int FROM policy_activation WHERE project_id = b.id) AS activations,
          (SELECT count(*)::int FROM policy_review WHERE project_id = b.id AND policy_id = $2 AND decision = 'approved') AS approved FROM project_binding b WHERE id = $1`, [s.id, s.ask.policyId])).rows[0];
async function refused(s: Scenario, code: string, status: number): Promise<PolicyError> {
  const was = await snapshot(s);
  const writes = s.writes.length;
  let error: PolicyError | undefined;
  await assert.rejects(approve(pool, s.id, "po", s.ask, s.access), (e: PolicyError) => { error = e; return e.code === code && e.status === status; });
  assert.deepEqual(await snapshot(s), was, "nothing was activated or reviewed");
  assert.equal(s.writes.length, writes, "Taiga was not changed");
  return error!;
}
const passes = async (s: Scenario) => {
  assert.equal((await approve(pool, s.id, "po", s.ask, s.access)).revision, 2);
  assert.equal((await runtime.forProject(s.taiga))!.revision, 2, "the next operation sees the new policy");
};
const blockedBy = async (s: Scenario, to: "gpt" | "claude") => {
  const e = await refused(s, "pending_work", 409);
  assert.deepEqual(e.problems.map((p) => [p.code, p.where]), [["continuation_pending", `continuation:${s.owed.id}`]]);
  assert.equal(foldContinuations().get(s.owed.id)!.to, to);
};

test("an empty ledger is not proof: the continuation Taiga owes is rebuilt and refuses the approval, once however often it runs", async () => {
  const s = await scenario();
  assert.equal(existsSync(ledger), false);
  await blockedBy(s, "claude");
  await blockedBy(s, "claude");
  assert.equal(readFileSync(ledger, "utf8").trim().split("\n").length, 1, "no duplicate");
});

for (const [label, lose] of [["removed", () => rmSync(ledger)], ["emptied", () => writeFileSync(ledger, "")], ["cut mid-line with no newline", () => writeFileSync(ledger, '{"op":"emit","id":"to')]] as const) {
  test(`a ledger ${label} after the continuation was recorded is rebuilt before the approval decides`, async () => {
    const s = await scenario();
    recordContinuation(s.owed);
    assert.ok(existsSync(ledger));
    lose();
    await blockedBy(s, "claude");
  });
}

test("an append that failed after the Taiga mutation persisted is recovered by the approval", async () => {
  const s = await scenario();
  process.env.TAIGA_MCP_CONTINUATION_FILE = join(dir, "missing", "c.jsonl");
  const out = await announce({ type: "TASK_DONE", to: "claude", from: "gpt", taskRef: 905, projectId: s.taiga, status: "Done" } as never, s.comment, {});
  assert.equal(out.continuation!.recorded, false);
  process.env.TAIGA_MCP_CONTINUATION_FILE = ledger;
  await blockedBy(s, "claude");
});

test("GPT-only history rebuilds for GPT, never Claude, even when the policy being approved names Claude", async () => {
  const s = await scenario({ policy: gptOnly() });
  await blockedBy(s, "gpt");
  assert.deepEqual(pendingContinuations("claude", s.taiga), []);
});

test("a proven legacy event (older than the first activation) keeps the legacy recipient and blocks", async () => {
  const s = await scenario({ writtenAt: new Date(Date.now() - DAY).toISOString(), journaled: false });
  await blockedBy(s, "claude");
});

test("an event whose historical policy cannot be proven refuses with continuation_unresolved and invents nothing", async () => {
  const s = await scenario({ journaled: false });
  const e = await refused(s, "continuation_unresolved", 409);
  assert.deepEqual(e.problems.map((p) => [p.code, p.where]), [["continuation_unresolved", `project:${s.taiga}`]]);
  assert.match(e.problems[0].detail, /^1 /);
  assert.equal(foldContinuations().size, 0);
});

test("a continuation proven handled on the card is not resurrected after the ledger is lost", async () => {
  const s = await scenario();
  await blockedBy(s, "claude");
  await recordHandledEvidence(s.access.client, s.owed, "claude");
  assert.equal(ackContinuation(s.owed.id, "handled", "Claude", "claude").ok, true);
  rmSync(ledger);
  await passes(s);
  assert.equal(foldContinuations().has(s.owed.id), false);
});

test("a delivered continuation blocks; a handled one in the ledger does not", async () => {
  const s = await scenario();
  recordContinuation(s.owed);
  ackContinuation(s.owed.id, "delivered", "Claude", "claude");
  assert.equal((await refused(s, "pending_work", 409)).problems[0].code, "continuation_delivered");
  ackContinuation(s.owed.id, "handled", "Claude", "claude");
  await passes(s);
});

test("another project's lost continuation does not block this one", async () => {
  const other = await scenario();
  const s = await scenario();
  await blockedBy(other, "claude");
  s.hooks.milestones = [];
  await passes(s);
});

test("a recovery Taiga cannot answer refuses with 503 and never falls back to the current ledger", async () => {
  const s = await scenario();
  s.hooks.history = async () => { throw new Error("ETIMEDOUT"); };
  await refused(s, "taiga_unavailable", 503);
  s.hooks.history = undefined;
  s.hooks.milestones = { not: "a list" };
  await refused(s, "taiga_unavailable", 503);
});

test("a ledger that cannot be read, or cannot take the rebuilt entry, refuses with 503 ledger_unavailable", async () => {
  const s = await scenario();
  process.env.TAIGA_MCP_CONTINUATION_FILE = dir; // a directory: unreadable
  await refused(s, "ledger_unavailable", 503);
  process.env.TAIGA_MCP_CONTINUATION_FILE = join(dir, "missing", "c.jsonl"); // reads as empty, cannot be written
  await refused(s, "ledger_unavailable", 503);
});

test("the recovery runs under the project lock: a governed mutation cannot start while it reads", async () => {
  const s = await scenario();
  let seen: unknown;
  s.hooks.history = async () => { seen = await runtime.hold(s.taiga).then(() => "held", (e: unknown) => e); return s.history; };
  await refused(s, "pending_work", 409);
  assert.ok(seen instanceof ProjectLockBusyError, String(seen));
});
