import { randomBytes } from "node:crypto";
import pg from "pg";

// A throwaway database per test file: taiga_test_<id>, dropped at the end. The server's own databases are never touched.
export async function createTestDatabase() {
  const base = process.env.DATABASE_URL;
  if (!base) throw new Error("DATABASE_URL is not set: the policy database tests need a PostgreSQL server");
  const name = `taiga_test_${randomBytes(6).toString("hex")}`;
  const admin = new pg.Client({ connectionString: base });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(base);
  url.pathname = `/${name}`;
  return {
    name,
    url: url.toString(),
    async drop() {
      if (!name.startsWith("taiga_test_")) throw new Error(`refusing to drop ${name}`);
      await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
      await admin.end();
    },
  };
}

export async function connect(url: string) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  return client;
}
