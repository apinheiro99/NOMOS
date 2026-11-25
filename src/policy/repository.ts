import pg from "pg";

// A project's policy is changed by one process at a time. The lock is a PostgreSQL session advisory lock on the project id.
export class ProjectLockBusyError extends Error {
  constructor(public readonly projectId: string) {
    super(`project ${projectId} is being changed by another request`);
    this.name = "ProjectLockBusyError";
  }
}

const limit = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  if (!/^[1-9]\d*$/.test(raw)) throw new Error(`${name} must be a positive integer`);
  return Number(raw);
};

// Bounded pool and timeouts: a slow or unreachable database fails the request, it never hangs it. The three operational limits are set by
// TAIGA_MCP_DB_POOL_MAX, TAIGA_MCP_DB_CONNECT_TIMEOUT_MS and TAIGA_MCP_DB_STATEMENT_TIMEOUT_MS; the defaults are the previous constants.
export function createPool(connectionString: string, max = limit("TAIGA_MCP_DB_POOL_MAX", 10)): pg.Pool {
  const pool = new pg.Pool({ connectionString, max, connectionTimeoutMillis: limit("TAIGA_MCP_DB_CONNECT_TIMEOUT_MS", 5_000), idleTimeoutMillis: 30_000, statement_timeout: limit("TAIGA_MCP_DB_STATEMENT_TIMEOUT_MS", 10_000) });
  // An idle connection that the server closed is dropped by the pool; without a listener Node would treat the event as a crash.
  pool.on("error", (e) => process.stderr.write(`policy pool: idle connection lost: ${e.message}\n`));
  return pool;
}

// Runs `fn` while holding the project lock. A policy change takes it exclusively; a governed mutation takes it shared, so mutations of one project run
// together but never alongside a policy change. A busy lock is an error (no waiting, no retry). The lock is released in `finally`;
// when the release cannot be confirmed the connection is destroyed, which makes PostgreSQL drop the session lock itself.
export async function withProjectLock<T>(pool: pg.Pool, projectId: string, fn: (client: pg.PoolClient) => Promise<T>, shared = false): Promise<T> {
  const suffix = shared ? "_shared" : "";
  const client = await pool.connect();
  let discard = false;
  // A connection that dies while we hold it also reports an event; it must not crash the process, and it must not go back to the pool.
  const lost = () => { discard = true; };
  client.on("error", lost);
  try {
    const got = await client.query<{ ok: boolean }>(`SELECT pg_try_advisory_lock${suffix}(hashtextextended($1, 0)) AS ok`, [projectId]);
    if (!got.rows[0].ok) throw new ProjectLockBusyError(projectId);
    try {
      return await fn(client);
    } finally {
      try {
        const freed = await client.query<{ ok: boolean }>(`SELECT pg_advisory_unlock${suffix}(hashtextextended($1, 0)) AS ok`, [projectId]);
        discard = !freed.rows[0].ok;
      } catch {
        discard = true;
      }
    }
  } catch (e) {
    if (!(e instanceof ProjectLockBusyError)) discard = true;
    throw e;
  } finally {
    client.removeListener("error", lost);
    client.release(discard);
  }
}

export async function withTransaction<T>(client: pg.PoolClient, fn: () => Promise<T>): Promise<T> {
  await client.query("BEGIN");
  try {
    const result = await fn();
    await client.query("COMMIT");
    return result;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  }
}
