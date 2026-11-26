import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { migrate } from "../dist/policy/migrate.js";
import { createPool } from "../dist/policy/repository.js";
import { activePolicy, approve, policyHash, propose, reject, rollback, simulate, PolicyError } from "../dist/policy/service.js";
import { legacySeed } from "../dist/policy/legacy-seed.js";
import type { Policy } from "../dist/policy/types.js";
import { connect, createTestDatabase } from "./support/pg.ts";
import { fakeTaiga } from "./support/taiga-fake.ts";

// F2.3: the policy use cases on real PostgreSQL.
const QUIET = fakeTaiga("http://t"); // Taiga with nothing in flight
let db: Awaited<ReturnType<typeof createTestDatabase>>;
let pool: ReturnType<typeof createPool>;
before(async () => {
  db = await createTestDatabase();
  const c = await connect(db.url);
  await migrate(c, fileURLToPath(new URL("../db/migrations", import.meta.url)));
  await c.end();
  pool = createPool(db.url, 5);
  await pool.query("INSERT INTO taiga_instance (id, instance_key, base_url) VALUES ($1,'lab','http://t')", [INSTANCE]);
});
after(async () => {
  await pool.end();
  await db.drop();
});

const INSTANCE = randomUUID();
let taigaId = 100;
async function project() {
  const id = randomUUID();
  await pool.query("INSERT INTO project_binding (id, instance_id, taiga_project_id, slug, name, lifecycle) VALUES ($1,$2,$3,'s','n','managed')", [id, INSTANCE, ++taigaId]);
  return id;
}
// The legacy seed, with Claude also allowed to start a Task: a small, valid change.
const changed = (): Policy => {
  const p = structuredClone(legacySeed());
  p.entities.task.transitions.find((t) => t.from === "to do" && t.to === "in progress")!.allow.push("claude");
  return p;
};
const expectError = (p: Promise<unknown>, status: number, code: string) =>
  assert.rejects(p, (e: PolicyError) => e instanceof PolicyError && e.status === status && e.code === code, `${status} ${code}`);
const initial = async (pid: string) => {
  const v = await propose(pool, pid, "gpt", legacySeed());
  await approve(pool, pid, "po", { policyId: v.policyId, expectedRevision: null, hash: v.hash, reason: "seed" }, QUIET);
  return v;
};

test("a project has no active policy until the PO approves one, and the decision then follows it", async () => {
  const pid = await project();
  assert.equal(await activePolicy(pool, pid), null);
  await expectError(simulate(pool, pid, { entity: "task", role: "gpt", from: "to do", to: "in progress" }), 404, "not_found");
  const v = await initial(pid);
  const active = await activePolicy(pool, pid);
  assert.deepEqual([active?.revision, active?.hash], [1, v.hash]);
  const d = await simulate(pool, pid, { entity: "task", role: "gpt", from: "to do", to: "in progress" });
  assert.deepEqual([d.kind, d.revision], ["typed", 1]);
});

test("propose then approve: the next decision uses the new revision, with no restart", async () => {
  const pid = await project();
  await initial(pid);
  assert.equal((await simulate(pool, pid, { entity: "task", role: "claude", from: "to do", to: "in progress" })).kind, "denied");
  const v = await propose(pool, pid, "gpt", changed());
  assert.equal((await activePolicy(pool, pid))?.revision, 1, "a proposal alone changes nothing");
  await approve(pool, pid, "po", { policyId: v.policyId, expectedRevision: 1, hash: v.hash, reason: "let Claude start" }, QUIET);
  const d = await simulate(pool, pid, { entity: "task", role: "claude", from: "to do", to: "in progress" });
  assert.deepEqual([d.kind, d.revision], ["typed", 2]);
});

test("a proposal made on an older revision is stale (409)", async () => {
  const pid = await project();
  await initial(pid);
  const a = await propose(pool, pid, "gpt", changed());
  const b = await propose(pool, pid, "gpt", changed());
  await approve(pool, pid, "po", { policyId: a.policyId, expectedRevision: 1, hash: a.hash, reason: "first" }, QUIET);
  await expectError(approve(pool, pid, "po", { policyId: b.policyId, expectedRevision: 1, hash: b.hash, reason: "second" }, QUIET), 409, "stale");
  await expectError(approve(pool, pid, "po", { policyId: b.policyId, expectedRevision: 2, hash: b.hash, reason: "second" }, QUIET), 409, "stale");
});

test("only the PO approves or rejects (403) and the hash must be the reviewed one (409)", async () => {
  const pid = await project();
  await initial(pid);
  const v = await propose(pool, pid, "claude", changed());
  for (const role of ["gpt", "claude"] as const) {
    await expectError(approve(pool, pid, role, { policyId: v.policyId, expectedRevision: 1, hash: v.hash, reason: "x" }, QUIET), 403, "forbidden");
    await expectError(reject(pool, pid, role, { policyId: v.policyId, reason: "x" }), 403, "forbidden");
  }
  await expectError(approve(pool, pid, "po", { policyId: v.policyId, expectedRevision: 1, hash: "0".repeat(64), reason: "x" }, QUIET), 409, "hash_mismatch");
  await reject(pool, pid, "po", { policyId: v.policyId, reason: "not now" });
  assert.equal((await activePolicy(pool, pid))?.revision, 1);
});

test("an invalid policy is refused (422) with the broken rules", async () => {
  const pid = await project();
  const bad = changed();
  bad.entities.task.transitions.push({ from: "to do", to: "limbo", allow: ["gpt"], artifact: "po_decision" });
  await assert.rejects(propose(pool, pid, "gpt", bad), (e: PolicyError) => e.status === 422 && e.problems.some((p) => p.code === "unknown_state"));
});

test("a rollback is a new proposal that copies the old version and still needs approval", async () => {
  const pid = await project();
  const first = await initial(pid);
  const v = await propose(pool, pid, "gpt", changed());
  await approve(pool, pid, "po", { policyId: v.policyId, expectedRevision: 1, hash: v.hash, reason: "change" }, QUIET);
  const back = await rollback(pool, pid, "po", 1);
  assert.equal(back.hash, first.hash);
  assert.equal((await activePolicy(pool, pid))?.revision, 2, "not active until approved");
  await approve(pool, pid, "po", { policyId: back.policyId, expectedRevision: 2, hash: back.hash, reason: "undo" }, QUIET);
  assert.equal((await activePolicy(pool, pid))?.hash, first.hash);
  await expectError(rollback(pool, pid, "po", 99), 404, "not_found");
});

test("the active policy survives a restart, and a database that is down denies instead of guessing", async () => {
  const pid = await project();
  const v = await initial(pid);
  const fresh = createPool(db.url, 2);
  assert.equal((await activePolicy(fresh, pid))?.hash, v.hash);
  await fresh.end();
  const dead = createPool("postgresql://x:y@127.0.0.1:1/none", 1);
  await assert.rejects(simulate(dead, pid, { entity: "task", role: "gpt", from: "to do", to: "in progress" }));
  await dead.end();
});

test("two approvals at the same time: exactly one wins", async () => {
  const pid = await project();
  await initial(pid);
  const a = await propose(pool, pid, "gpt", changed());
  const b = await propose(pool, pid, "gpt", changed());
  const results = await Promise.allSettled([
    approve(pool, pid, "po", { policyId: a.policyId, expectedRevision: 1, hash: a.hash, reason: "a" }, QUIET),
    approve(pool, pid, "po", { policyId: b.policyId, expectedRevision: 1, hash: b.hash, reason: "b" }, QUIET),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
});

test("proposals, approvals and rejections leave an audit trail without the policy body", async () => {
  const pid = await project();
  const v = await initial(pid);
  const { rows } = await pool.query("SELECT operation, principal, details FROM policy_audit WHERE project_id = $1 ORDER BY occurred_at", [pid]);
  assert.deepEqual(rows.map((r) => `${r.operation}:${r.principal}`), ["propose:gpt", "approve:po"]);
  assert.equal(JSON.stringify(rows).includes("transitions"), false);
  assert.equal(policyHash(legacySeed()), v.hash);
});
