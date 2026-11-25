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
import { connect, createTestDatabase } from "./support/pg.ts";

// Audit F2 #8-#10: a governed mutation and a policy change share ONE project lock; approval refuses unfinished work and a rejected proposal.
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
  const release = (await runtime.hold(p.taiga))!;
  await assert.rejects(approve(pool, p.id, "po", ask), ProjectLockBusyError);
  await release();
  const during = withProjectLock(pool, p.id, async () => runtime.hold(p.taiga));
  await assert.rejects(during, ProjectLockBusyError);
  assert.equal((await approve(pool, p.id, "po", ask)).revision, 2);
});

test("mutations of one project run together (the lock is shared)", async () => {
  const runtime = createPolicyRuntime(pool, "http://t");
  const p = await managed();
  const [a, b] = await Promise.all([runtime.hold(p.taiga), runtime.hold(p.taiga)]);
  await a!(); await b!();
});

test("a rejected proposal can never be approved afterwards", async () => {
  const p = await managed();
  const { ask } = await change(p.id, 1);
  await reject(pool, p.id, "po", { policyId: ask.policyId, reason: "no" });
  await assert.rejects(approve(pool, p.id, "po", ask), (e: PolicyError) => e.code === "rejected");
});

test("approval is refused while a journal entry or a merge authorization is unfinished", async () => {
  const runtime = createPolicyRuntime(pool, "http://t");
  const p = await managed();
  const m = (await runtime.forProject(p.taiga))!;
  const { ask } = await change(p.id, 1);
  const journalId = await runtime.begin(m, "workflow_transition", "task:1");
  await assert.rejects(approve(pool, p.id, "po", ask), (e: PolicyError) => e.code === "pending_work" && /"journal_intents":1/.test(e.message));
  await runtime.finish(journalId, "completed", {});
  await runtime.openMergeObligation(m, { authorizationId: randomUUID(), journalId: await runtime.begin(m, "workflow_transition", "task:2"), actor: "gpt", recipient: "claude", approvalHash: "h", entity: "task", taigaId: 1, doneStatus: 5, taigaProject: p.taiga, context: { repository: "r", source_branch: "b", target_branch: "t", source_sha: "a".repeat(40), target_sha: "a".repeat(40) }, workItem: { kind: "task", ref: 1 }, targetWorkItem: "Story #1" });
  await assert.rejects(approve(pool, p.id, "po", ask), (e: PolicyError) => e.code === "pending_work" && /"merge_obligations":1/.test(e.message));
});
