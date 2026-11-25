import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Client } from "pg";

// One advisory lock for the whole migration run, so two processes starting together never apply the same file twice.
const MIGRATION_LOCK = 7_262_001;

// Applies every pending db/migrations/NNNN_name.sql in order, each in its own transaction. Idempotent: applied files are skipped.
export async function migrate(client: Client, dir: string): Promise<string[]> {
  const files = readdirSync(dir).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
  await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK]);
  try {
    await client.query("CREATE TABLE IF NOT EXISTS schema_migration (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
    const done = new Set((await client.query<{ version: string }>("SELECT version FROM schema_migration")).rows.map((r) => r.version));
    const applied: string[] = [];
    for (const file of files.filter((f) => !done.has(f))) {
      await client.query("BEGIN");
      try {
        await client.query(readFileSync(join(dir, file), "utf8"));
        await client.query("INSERT INTO schema_migration (version) VALUES ($1)", [file]);
        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK");
        throw new Error(`migration ${file} failed: ${(e as Error).message}`, { cause: e });
      }
      applied.push(file);
    }
    return applied;
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK]);
  }
}
