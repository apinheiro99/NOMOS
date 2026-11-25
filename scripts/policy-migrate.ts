// Applies the policy schema to the database named by DATABASE_URL. A missing variable is an error, never a default.
import pg from "pg";
import { fileURLToPath } from "node:url";
import { migrate } from "../dist/policy/migrate.js";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("policy-migrate: DATABASE_URL is not set");
  process.exit(1);
}
const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  const applied = await migrate(client, fileURLToPath(new URL("../db/migrations", import.meta.url)));
  console.log(applied.length ? `applied ${applied.join(", ")}` : "schema is up to date");
} finally {
  await client.end();
}
