import type pg from "pg";
import { uuidv7 } from "../identity.js";
import { bindProject, plan, type Seen } from "./mirror.js";
import { PolicyError } from "./service.js";

// Project creation reaches Taiga BEFORE a project id exists, so its intent lives in provisioning_intent: intent -> created -> bound.
// The id is registered the moment Taiga confirms the POST, BEFORE anything else runs on the new project (profile, inspection): a failure after that point
// keeps the id, and the same request key resumes the preparation of THAT project, never a second POST. The request key is bound to the principal and to the
// fingerprint of the request; a bound request answers with the same project, and one whose outcome is unknown (no id) is never re-run.
export interface Provisioned { id: number; replay: boolean }
export interface Prepared { slug: string; name: string; seen: Seen }

export async function provisionProject(
  pool: pg.Pool, baseUrl: string, a: { principal: string; requestKey: string; requestHash: string },
  create: () => Promise<{ id: number }>,
  prepare: (id: number) => Promise<Prepared>,
): Promise<Provisioned> {
  await pool.query("INSERT INTO taiga_instance (id, instance_key, base_url) VALUES ($1, $2, $3) ON CONFLICT (base_url) DO NOTHING", [uuidv7(), new URL(baseUrl).host, baseUrl]);
  const instance = (await pool.query<{ id: string }>("SELECT id FROM taiga_instance WHERE base_url = $1", [baseUrl])).rows[0].id;
  const intent = uuidv7();
  const fresh = await pool.query(
    "INSERT INTO provisioning_intent (id, instance_id, principal, operation, request_key, request_hash, phase) VALUES ($1,$2,$3,'project_create',$4,$5,'intent') ON CONFLICT (instance_id, request_key) DO NOTHING",
    [intent, instance, a.principal, a.requestKey, a.requestHash]);
  const set = (phase: string, project: number | null, evidence: object) =>
    pool.query("UPDATE provisioning_intent SET phase = $2, external_project_id = coalesce($3, external_project_id), evidence = $4, updated_at = now() WHERE id = $1", [intent, phase, project, JSON.stringify(evidence)]);
  // Reads the project back and binds it (with its first policy). Safe to run again for the same id.
  const finish = async (id: number, row: string) => {
    try {
      const made = await prepare(id);
      await bindProject(pool, instance, undefined, { taigaProjectId: id, slug: made.slug, name: made.name, ...plan(undefined, made.seen) }, made.seen);
    } catch (e) {
      await pool.query("UPDATE provisioning_intent SET phase = 'failed', evidence = $2, updated_at = now() WHERE id = $1", [row, JSON.stringify({ error: (e as Error).message, note: "the project exists in Taiga and its id is registered; the same request key resumes it, and the next mirror run binds it" })]);
      throw e;
    }
    await pool.query("UPDATE provisioning_intent SET phase = 'bound', evidence = '{}', updated_at = now() WHERE id = $1", [row]);
  };
  if (!fresh.rowCount) {
    const prior = (await pool.query<{ id: string; principal: string; request_hash: string; phase: string; external_project_id: string | null }>("SELECT id, principal, request_hash, phase, external_project_id FROM provisioning_intent WHERE instance_id = $1 AND request_key = $2", [instance, a.requestKey])).rows[0];
    if (prior.request_hash !== a.requestHash) throw new PolicyError(409, "request_key_reused", "this request key was used for a different project request");
    if (prior.principal !== a.principal) throw new PolicyError(409, "request_key_reused", "this request key belongs to another principal");
    if (prior.phase === "bound") return { id: Number(prior.external_project_id), replay: true };
    // The project exists and its id is registered: resume it. (A rejected request, or one that never learned an id, has nothing to resume.)
    if (prior.external_project_id !== null) { await finish(Number(prior.external_project_id), prior.id); return { id: Number(prior.external_project_id), replay: true }; }
    throw new PolicyError(409, "outcome_unknown", `an earlier attempt with this request key stopped at "${prior.phase}"${prior.phase === "failed" ? " (Taiga rejected it)" : "; its outcome is unknown"}: check Taiga for the project before retrying with a new key`);
  }
  let made;
  // Only an answer from Taiga that rejects the request (4xx) proves nothing was created. A timeout, a dropped connection or a 5xx may hide a
  // project that exists: the intent stays open, and the key is never re-run (Kleppmann: a timeout is an unknown outcome).
  try { made = await create(); } catch (e) {
    const status = (e as { status?: number }).status;
    if (typeof status === "number" && status >= 400 && status < 500) await set("failed", null, { error: (e as Error).message });
    else await set("intent", null, { error: (e as Error).message, note: "outcome unknown: check Taiga for the project before any retry" });
    throw e;
  }
  await set("created", made.id, {});
  await finish(made.id, intent);
  return { id: made.id, replay: false };
}
