import type pg from "pg";
import { uuidv7 } from "../identity.js";
import { bindProject, plan, type Seen } from "./mirror.js";
import { PolicyError } from "./service.js";

// Project creation reaches Taiga BEFORE a project id exists, so its intent lives in provisioning_intent: intent -> created -> bound.
// The request key makes a retry safe: a bound request answers with the same project, and one whose outcome is unknown is never re-run.
export interface Provisioned { id: number; replay: boolean }

export async function provisionProject(
  pool: pg.Pool, baseUrl: string, a: { principal: string; requestKey: string; requestHash: string },
  create: () => Promise<{ id: number; slug: string; name: string; seen: Seen }>,
): Promise<Provisioned> {
  await pool.query("INSERT INTO taiga_instance (id, instance_key, base_url) VALUES ($1, $2, $3) ON CONFLICT (base_url) DO NOTHING", [uuidv7(), new URL(baseUrl).host, baseUrl]);
  const instance = (await pool.query<{ id: string }>("SELECT id FROM taiga_instance WHERE base_url = $1", [baseUrl])).rows[0].id;
  const intent = uuidv7();
  const fresh = await pool.query(
    "INSERT INTO provisioning_intent (id, instance_id, principal, operation, request_key, request_hash, phase) VALUES ($1,$2,$3,'project_create',$4,$5,'intent') ON CONFLICT (instance_id, request_key) DO NOTHING",
    [intent, instance, a.principal, a.requestKey, a.requestHash]);
  if (!fresh.rowCount) {
    const prior = (await pool.query<{ request_hash: string; phase: string; external_project_id: string | null }>("SELECT request_hash, phase, external_project_id FROM provisioning_intent WHERE instance_id = $1 AND request_key = $2", [instance, a.requestKey])).rows[0];
    if (prior.request_hash !== a.requestHash) throw new PolicyError(409, "request_key_reused", "this request key was used for a different project request");
    if (prior.phase === "bound") return { id: Number(prior.external_project_id), replay: true };
    throw new PolicyError(409, "outcome_unknown", `an earlier attempt with this request key stopped at "${prior.phase}"; check Taiga for the project before retrying with a new key`);
  }
  const set = (phase: string, project: number | null, evidence: object) =>
    pool.query("UPDATE provisioning_intent SET phase = $2, external_project_id = coalesce($3, external_project_id), evidence = $4, updated_at = now() WHERE id = $1", [intent, phase, project, JSON.stringify(evidence)]);
  let made;
  try { made = await create(); } catch (e) { await set("failed", null, { error: (e as Error).message }); throw e; }
  await set("created", made.id, {});
  try {
    await bindProject(pool, instance, undefined, { taigaProjectId: made.id, slug: made.slug, name: made.name, ...plan(undefined, made.seen) }, made.seen);
  } catch (e) { await set("failed", made.id, { error: (e as Error).message, note: "the project exists in Taiga; the next mirror run binds it" }); throw e; }
  await set("bound", made.id, {});
  return { id: made.id, replay: false };
}
