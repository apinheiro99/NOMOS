import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { Client } from "pg";
import { migrate } from "../dist/policy/migrate.js";
import { connect, createTestDatabase } from "./support/pg.ts";

// F2.1: real PostgreSQL. The schema must keep rows inside their project and keep policy history append-only.
const DIR = fileURLToPath(new URL("../db/migrations", import.meta.url));
let db: Awaited<ReturnType<typeof createTestDatabase>>;
let c: Client;
const id = () => randomUUID();

before(async () => {
  db = await createTestDatabase();
  c = await connect(db.url);
});
after(async () => {
  await c.end();
  await db.drop();
});

const rejects = (sql: string, params: unknown[], code: string) =>
  assert.rejects(c.query(sql, params), (e: { code?: string }) => e.code === code, `expected SQLSTATE ${code}`);

async function project(instance: string, taigaId: number) {
  const pid = id();
  await c.query("INSERT INTO project_binding (id, instance_id, taiga_project_id, slug, name, lifecycle) VALUES ($1,$2,$3,'s','n','managed')", [pid, instance, taigaId]);
  return pid;
}
async function version(pid: string, revision: number, parent: string | null = null) {
  const vid = id();
  await c.query("INSERT INTO policy_version (id, project_id, revision, parent_id, catalog_version, schema_version, payload, content_hash, proposed_by) VALUES ($1,$2,$3,$4,'1',1,'{}','h','gpt')", [vid, pid, revision, parent]);
  return vid;
}
async function review(pid: string, vid: string, decision = "approved") {
  const rid = id();
  await c.query("INSERT INTO policy_review (id, project_id, policy_id, decision, actor, reason) VALUES ($1,$2,$3,$4,'po','ok')", [rid, pid, vid, decision]);
  return rid;
}
const activate = async (pid: string, vid: string, rid: string, previous: string | null = null) => {
  const aid = id();
  await c.query("INSERT INTO policy_activation (id, project_id, policy_id, review_id, previous_activation_id, activated_by, reason) VALUES ($1,$2,$3,$4,$5,'po','go')", [aid, pid, vid, rid, previous]);
  return aid;
};

test("migration runs on a fresh database, is idempotent, and records what it applied", async () => {
  assert.deepEqual(await migrate(c, DIR), ["0001_policy_schema.sql", "0002_instance_base_url_unique.sql"]);
  assert.deepEqual(await migrate(c, DIR), []);
  assert.equal((await c.query("SELECT count(*)::int AS n FROM schema_migration")).rows[0].n, 2);
});

test("a failed migration changes nothing and says which file failed", async () => {
  const other = await createTestDatabase();
  const o = await connect(other.url);
  try {
    await o.query("CREATE TABLE taiga_instance (id int)"); // collides with 0001
    await assert.rejects(migrate(o, DIR), /migration 0001_policy_schema\.sql failed/);
    assert.equal((await o.query("SELECT count(*)::int AS n FROM schema_migration")).rows[0].n, 0);
  } finally {
    await o.end();
    await other.drop();
  }
});

test("the first activation: approved review, then the project points at it", async () => {
  const inst = id();
  await c.query("INSERT INTO taiga_instance (id, instance_key, base_url) VALUES ($1,'lab','http://t')", [inst]);
  const pid = await project(inst, 1);
  const v1 = await version(pid, 1);
  const a1 = await activate(pid, v1, await review(pid, v1));
  await c.query("UPDATE project_binding SET active_activation_id = $1 WHERE id = $2", [a1, pid]);
  const v2 = await version(pid, 2, v1);
  await activate(pid, v2, await review(pid, v2), a1);
});

test("a review of another project's policy, or a parent from another project, is rejected", async () => {
  const inst = (await c.query("SELECT id FROM taiga_instance")).rows[0].id;
  const a = await project(inst, 10);
  const b = await project(inst, 11);
  const va = await version(a, 1);
  await rejects("INSERT INTO policy_review (id, project_id, policy_id, decision, actor, reason) VALUES ($1,$2,$3,'approved','po','x')", [id(), b, va], "23503");
  await rejects("INSERT INTO policy_version (id, project_id, revision, parent_id, catalog_version, schema_version, payload, content_hash, proposed_by) VALUES ($1,$2,1,$3,'1',1,'{}','h','gpt')", [id(), b, va], "23503");
});

test("an activation needs an approved review of that very version", async () => {
  const inst = (await c.query("SELECT id FROM taiga_instance")).rows[0].id;
  const pid = await project(inst, 20);
  const v1 = await version(pid, 1);
  const v2 = await version(pid, 2, v1);
  await rejects("INSERT INTO policy_activation (id, project_id, policy_id, review_id, activated_by, reason) VALUES ($1,$2,$3,$4,'po','go')", [id(), pid, v1, await review(pid, v1, "rejected")], "23514");
  await rejects("INSERT INTO policy_activation (id, project_id, policy_id, review_id, activated_by, reason) VALUES ($1,$2,$3,$4,'po','go')", [id(), pid, v2, await review(pid, v1)], "23503");
});

test("an activation must continue the current one, and a review is used once", async () => {
  const inst = (await c.query("SELECT id FROM taiga_instance")).rows[0].id;
  const pid = await project(inst, 30);
  const v1 = await version(pid, 1);
  const r1 = await review(pid, v1);
  const a1 = await activate(pid, v1, r1);
  await rejects("INSERT INTO policy_activation (id, project_id, policy_id, review_id, activated_by, reason) VALUES ($1,$2,$3,$4,'po','again')", [id(), pid, v1, r1], "23505");
  await c.query("UPDATE project_binding SET active_activation_id = $1 WHERE id = $2", [a1, pid]);
  const v2 = await version(pid, 2, v1);
  await rejects("INSERT INTO policy_activation (id, project_id, policy_id, review_id, activated_by, reason) VALUES ($1,$2,$3,$4,'po','skip')", [id(), pid, v2, await review(pid, v2)], "23514");
});

test("policy history is append-only", async () => {
  await rejects("UPDATE policy_version SET payload = '{\"x\":1}'", [], "23001");
  await rejects("DELETE FROM policy_review", [], "23001");
  await rejects("DELETE FROM policy_activation", [], "23001");
});

test("revision numbers are unique per project, and the active pointer must be that project's own activation", async () => {
  const inst = (await c.query("SELECT id FROM taiga_instance")).rows[0].id;
  const a = await project(inst, 40);
  const b = await project(inst, 41);
  const va = await version(a, 1);
  await rejects("INSERT INTO policy_version (id, project_id, revision, catalog_version, schema_version, payload, content_hash, proposed_by) VALUES ($1,$2,1,'1',1,'{}','h','gpt')", [id(), a], "23505");
  const aa = await activate(a, va, await review(a, va));
  await rejects("UPDATE project_binding SET active_activation_id = $1 WHERE id = $2", [aa, b], "23503");
});

test("a journal entry and an audit row belong to an activation of their own project", async () => {
  const inst = (await c.query("SELECT id FROM taiga_instance")).rows[0].id;
  const a = await project(inst, 50);
  const b = await project(inst, 51);
  const va = await version(a, 1);
  const aa = await activate(a, va, await review(a, va));
  await rejects("INSERT INTO mutation_journal (id, project_id, activation_id, operation, phase) VALUES ($1,$2,$3,'op','intent')", [id(), b, aa], "23503");
  await rejects("INSERT INTO policy_audit (id, instance_id, project_id, activation_id, principal, operation, decision, correlation_id) VALUES ($1,$2,$3,$4,'gpt','op','allow',$5)", [id(), inst, b, aa, id()], "23503");
  await c.query("INSERT INTO mutation_journal (id, project_id, activation_id, operation, phase) VALUES ($1,$2,$3,'op','intent')", [id(), a, aa]);
});

test("project creation intent is recorded before any project id exists, once per request key", async () => {
  const inst = (await c.query("SELECT id FROM taiga_instance")).rows[0].id;
  await c.query("INSERT INTO provisioning_intent (id, instance_id, principal, operation, request_key, request_hash, phase) VALUES ($1,$2,'gpt','create_project','k1','h','intent')", [id(), inst]);
  await rejects("INSERT INTO provisioning_intent (id, instance_id, principal, operation, request_key, request_hash, phase) VALUES ($1,$2,'gpt','create_project','k1','h','intent')", [id(), inst], "23505");
});
