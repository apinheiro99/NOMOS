import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
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

// Audit F2 #8-#10: a governed mutation and a policy change share ONE project lock; approval refuses unfinished work and a rejected proposal.
const QUIET = { getAll: async () => [] } as never; // Taiga with nothing in flight
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
  await approve(pool, id, "po", { policyId: v.policyId, expectedRevision: null, hash: v.hash, reason: "seed" });
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

test("approval is refused while a journal entry or a merge authorization is unfinished", async () => {
  const runtime = createPolicyRuntime(pool, "http://t");
  const p = await managed();
  const m = (await runtime.forProject(p.taiga))!;
  const { ask } = await change(p.id, 1);
  const journalId = await runtime.begin(m, "workflow_transition", "task:1");
  await assert.rejects(approve(pool, p.id, "po", ask, QUIET), (e: PolicyError) => e.code === "pending_work" && /"journal_intents":1/.test(e.message));
  await runtime.finish(journalId, "completed", {});
  await runtime.openMergeObligation(m, { authorizationId: randomUUID(), journalId: await runtime.begin(m, "workflow_transition", "task:2"), actor: "gpt", recipient: "claude", approvalHash: "h", entity: "task", taigaId: 1, doneStatus: 5, taigaProject: p.taiga, context: { repository: "r", source_branch: "b", target_branch: "t", source_sha: "a".repeat(40), target_sha: "a".repeat(40) }, workItem: { kind: "task", ref: 1 }, targetWorkItem: "Story #1" });
  await assert.rejects(approve(pool, p.id, "po", ask, QUIET), (e: PolicyError) => e.code === "pending_work" && /"merge_obligations":1/.test(e.message));
});

// Taiga as the approval sees it: the open cards per collection, getAll follows every page, so a card on a later page is part of the answer.
const cardsIn = (cards: Record<string, [number, string][]>) => ({ getAll: async (path: string) => (cards[path.slice(1)] ?? []).map(([ref, name]) => ({ ref, status_extra_info: { name } })) }) as never;

test("approval is refused with 409 for each active status of a Task, Story or Epic, and the card is named", async () => {
  const p = await managed();
  const { ask } = await change(p.id, 1);
  const cases: [string, string, string][] = [["tasks", "task", "In Progress"], ["tasks", "task", "Request"], ["tasks", "task", "GPT Validation"], ["tasks", "task", "Human Decision"], ["userstories", "userstory", "In Progress"], ["epics", "epic", "GPT Validation"]];
  for (const [path, card, status] of cases) {
    await assert.rejects(approve(pool, p.id, "po", ask, cardsIn({ [path]: [[7, "To Do"], [8, status]] })), (e: PolicyError) => e.code === "active_work" && e.status === 409 && new RegExp(`${card} #8`).test(e.message), `${card} ${status}`);
  }
});

test("approval needs Taiga when a policy is in force, and a card in a status the new policy lacks refuses it", async () => {
  const p = await managed();
  const { ask } = await change(p.id, 1);
  await assert.rejects(approve(pool, p.id, "po", ask), (e: PolicyError) => e.code === "taiga_unavailable");
  await assert.rejects(approve(pool, p.id, "po", ask, cardsIn({ tasks: [[9, "Limbo"]] })), (e: PolicyError) => e.code === "cards_in_unknown_state" && /task #9/.test(e.message));
  assert.equal((await approve(pool, p.id, "po", ask, cardsIn({ tasks: [[9, "To Do"]], userstories: [[1, "Ready"]], epics: [[2, "New"]] }))).revision, 2);
});

test("an approval racing a governed mutation never lands in the middle of it", async () => {
  const runtime = createPolicyRuntime(pool, "http://t");
  const p = await managed();
  const { ask } = await change(p.id, 1);
  const held = (await runtime.hold(p.taiga))!;
  await assert.rejects(approve(pool, p.id, "po", ask, QUIET), ProjectLockBusyError);
  await held.release();
});
