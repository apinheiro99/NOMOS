import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "../dist/policy/migrate.js";
import { createPool } from "../dist/policy/repository.js";
import { bootstrapPolicy } from "../dist/policy/service.js";
import { legacySeed } from "../dist/policy/legacy-seed.js";
import { connect, createTestDatabase } from "./support/pg.ts";

// F3.4: a database that already holds merge obligations written by migration 0003 must upgrade to 0004 without losing or inventing evidence.
const DIR = fileURLToPath(new URL("../db/migrations", import.meta.url));
let db: Awaited<ReturnType<typeof createTestDatabase>>;
before(async () => { process.env.TAIGA_MCP_CONTINUATION_FILE = join(mkdtempSync(join(tmpdir(), "up-")), "c.jsonl"); db = await createTestDatabase(); }); // approval looks at pending continuations: keep it hermetic
after(async () => { delete process.env.TAIGA_MCP_CONTINUATION_FILE; await db.drop(); });

test("0003 rows survive 0004: a pending one becomes review, a signed one stays signed, and each gets a legacy journal entry", async () => {
  const old = join(mkdtempSync(join(tmpdir(), "mig-")), "m");
  mkdirSync(old);
  for (const f of ["0001_policy_schema.sql", "0002_instance_base_url_unique.sql", "0003_merge_obligation.sql"]) copyFileSync(join(DIR, f), join(old, f));
  const c = await connect(db.url);
  await migrate(c, old);
  const [instance, binding] = [randomUUID(), randomUUID()];
  await c.query("INSERT INTO taiga_instance (id, instance_key, base_url) VALUES ($1,'lab','http://taiga.invalid')", [instance]);
  await c.query("INSERT INTO project_binding (id, instance_id, taiga_project_id, slug, name, lifecycle) VALUES ($1,$2,49,'lab','Lab','managed')", [binding, instance]);
  const pool = createPool(db.url);
  await bootstrapPolicy(c as never, binding, legacySeed()); // the schema is the old one here: the system bootstrap, not the (current-schema) approval, seeds the policy
  const [pending, signed] = [randomUUID(), randomUUID()];
  const row = (aid: string, state: string, envelope: string | null) => c.query(
    "INSERT INTO merge_obligation (authorization_id, project_id, entity, taiga_id, done_status, taiga_project, context, work_item, target_work_item, state, envelope) VALUES ($1,$2,'task',7,5,49,'{}','{}','Story #3',$3,$4)", [aid, binding, state, envelope]);
  await row(pending, "pending", null);
  await row(signed, "signed", "{}");
  assert.equal((await migrate(c, DIR)).join(), "0004_merge_obligation_evidence.sql,0005_journal_pending_effect.sql,0006_merge_obligation_no_context.sql");
  const rows = (await c.query("SELECT authorization_id, state, journal_id, activation_id, actor, approval_hash FROM merge_obligation ORDER BY state")).rows;
  assert.deepEqual(rows.map((r) => [r.state, r.journal_id === r.authorization_id, r.actor, r.approval_hash]), [["review", true, "po", "legacy:unproven"], ["signed", true, "po", "legacy:unproven"]]);
  assert.equal((await c.query("SELECT count(*)::int AS n FROM mutation_journal WHERE result->>'legacy' = 'true' AND phase = 'completed'")).rows[0].n, 2);
  await pool.end();
  await c.end();
});
