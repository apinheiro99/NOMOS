import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createPool, ProjectLockBusyError, withProjectLock, withTransaction } from "../dist/policy/repository.js";
import { createTestDatabase } from "./support/pg.ts";

// F2.2: the project lock on real PostgreSQL, with two connections.
let db: Awaited<ReturnType<typeof createTestDatabase>>;
let pool: ReturnType<typeof createPool>;
before(async () => {
  db = await createTestDatabase();
  pool = createPool(db.url, 5);
});
after(async () => {
  await pool.end();
  await db.drop();
});
const held = async (projectId: string) => (await pool.query("SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND granted AND pid <> pg_backend_pid()")).rows[0].n > 0 && projectId;

test("a second request for the same project is refused while the first holds the lock", async () => {
  const project = randomUUID();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const first = withProjectLock(pool, project, () => gate);
  await new Promise((r) => setTimeout(r, 100));
  await assert.rejects(withProjectLock(pool, project, async () => "second"), ProjectLockBusyError);
  assert.equal(await withProjectLock(pool, randomUUID(), async () => "other project"), "other project");
  release();
  await first;
  assert.equal(await withProjectLock(pool, project, async () => "after"), "after");
});

test("the lock is released when the work throws, and the error is the work's own", async () => {
  const project = randomUUID();
  await assert.rejects(withProjectLock(pool, project, async () => { throw new Error("boom"); }), /boom/);
  assert.equal(await withProjectLock(pool, project, async () => "free"), "free");
  assert.equal(await held(project), false);
});

test("killing the session that holds the lock frees it, and the broken connection is not reused", async () => {
  const project = randomUUID();
  let pid = 0;
  const holder = withProjectLock(pool, project, async (client) => {
    pid = (await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    await new Promise((r) => setTimeout(r, 400));
    await client.query("SELECT 1");
  });
  await new Promise((r) => setTimeout(r, 100));
  await pool.query("SELECT pg_terminate_backend($1)", [pid]);
  await assert.rejects(holder);
  assert.equal(await withProjectLock(pool, project, async () => "recovered"), "recovered");
});

test("a transaction commits on success and rolls back on failure", async () => {
  await pool.query("CREATE TABLE t (n int)");
  const client = await pool.connect();
  try {
    await withTransaction(client, async () => { await client.query("INSERT INTO t VALUES (1)"); });
    await assert.rejects(withTransaction(client, async () => { await client.query("INSERT INTO t VALUES (2)"); throw new Error("no"); }), /no/);
  } finally {
    client.release();
  }
  assert.deepEqual((await pool.query("SELECT n FROM t")).rows, [{ n: 1 }]);
});

test("an unreachable database fails fast instead of hanging", async () => {
  const dead = createPool("postgresql://x:y@127.0.0.1:1/none", 1);
  const started = Date.now();
  await assert.rejects(withProjectLock(dead, randomUUID(), async () => "never"));
  assert.ok(Date.now() - started < 6_000);
  await dead.end();
});
