import { createHash } from "node:crypto";
import type pg from "pg";
import type { TaigaClient } from "../client.js";
import { IDENTITY, uuidAttributeId, uuidv7, type IdentityKind } from "../identity.js";
import { norm, vocabulary, type EntityKind } from "../workflow/policy.js";
import { legacySeed } from "./legacy-seed.js";
import { withProjectLock, withTransaction } from "./repository.js";
import { bootstrapPolicy } from "./service.js";

// The mirror reads Taiga and keeps one binding per (instance, project id) in the policy database. It NEVER writes a card, never uses the
// slug as an identity, and never replaces an active policy: it only decides which lifecycle a project is in.
export type MirrorAction = "create_managed" | "create_legacy" | "mark_drift" | "recover" | "mark_inaccessible" | "refresh" | "none";
export interface MirrorItem { taigaProjectId: number; slug: string; name: string; action: MirrorAction; lifecycle: string }
interface Existing { id: string; lifecycle: string; slug: string; name: string; fingerprint: string | null; uuidReady: boolean; hasPolicy: boolean }
interface Seen { id: number; slug: string; name: string; eligible: boolean; fingerprint: string; uuidReady: boolean }

const STATUS_PATH: Record<EntityKind, string> = { task: "/task-statuses", userstory: "/userstory-statuses", epic: "/epic-statuses" };
const UUID_KINDS = Object.keys(IDENTITY) as IdentityKind[];

// What a project should become, from what it is now and whether Taiga shows it as eligible (strict Task workflow, no ambiguous names).
export function plan(existing: Existing | undefined, seen: Seen | undefined): { action: MirrorAction; lifecycle: string } {
  if (!seen) {
    if (!existing || ["legacy", "archived", "inaccessible"].includes(existing.lifecycle)) return { action: "none", lifecycle: existing?.lifecycle ?? "none" };
    return { action: "mark_inaccessible", lifecycle: "inaccessible" };
  }
  if (!existing) return seen.eligible ? { action: "create_managed", lifecycle: "managed" } : { action: "create_legacy", lifecycle: "legacy" };
  switch (existing.lifecycle) {
    case "legacy": case "archived": return { action: existing.slug === seen.slug && existing.name === seen.name && existing.fingerprint === seen.fingerprint ? "none" : "refresh", lifecycle: existing.lifecycle };
    case "managed": return seen.eligible ? { action: existing.slug === seen.slug && existing.name === seen.name && existing.fingerprint === seen.fingerprint && existing.uuidReady === seen.uuidReady ? "none" : "refresh", lifecycle: "managed" } : { action: "mark_drift", lifecycle: "drift" };
    case "drift": return seen.eligible && existing.hasPolicy ? { action: "recover", lifecycle: "managed" } : { action: "none", lifecycle: "drift" };
    default: // pending, inaccessible with a policy, or a binding that never got its first policy
      if (existing.hasPolicy) return seen.eligible ? { action: "recover", lifecycle: "managed" } : { action: "mark_drift", lifecycle: "drift" };
      return seen.eligible ? { action: "create_managed", lifecycle: "managed" } : { action: "create_legacy", lifecycle: "legacy" };
  }
}

async function inspect(client: TaigaClient, row: { id: number; slug: string; name: string }): Promise<Seen> {
  const names: Record<string, string[]> = {};
  let eligible = false;
  for (const entity of Object.keys(STATUS_PATH) as EntityKind[]) {
    const statuses = await client.get(STATUS_PATH[entity], { project: row.id });
    names[entity] = ((Array.isArray(statuses) ? statuses : []) as { name?: string }[]).map((s) => norm(String(s.name ?? ""))).sort();
    if (entity === "task") { const v = vocabulary("task", statuses); eligible = v.strict && v.broken.length === 0; }
  }
  // Duplicate or missing UUID definitions make the project "not UUID-ready"; they never stop the mirror.
  const ready = await Promise.all(UUID_KINDS.map((k) => uuidAttributeId(client, k, row.id, false).then((id) => id !== undefined, () => false)));
  return { id: row.id, slug: row.slug, name: row.name, eligible, fingerprint: createHash("sha256").update(JSON.stringify(names)).digest("hex"), uuidReady: ready.every(Boolean) };
}

// Dry-run by default: it reads Taiga and the database and writes nothing. `apply` records the plan.
export async function mirrorProjects(pool: pg.Pool, client: TaigaClient, baseUrl: string, { apply }: { apply: boolean }): Promise<{ applied: boolean; items: MirrorItem[] }> {
  const listed = (await client.getAll("/projects")) as { id: number; slug: string; name: string }[];
  const seen = new Map<number, Seen>();
  for (const row of listed) seen.set(row.id, await inspect(client, row));

  const instance = (await pool.query<{ id: string }>("SELECT id FROM taiga_instance WHERE base_url = $1", [baseUrl])).rows[0]?.id;
  const existing = new Map<number, Existing>();
  if (instance) {
    const { rows } = await pool.query<{ id: string; taiga_project_id: string; lifecycle: string; slug: string; name: string; profile_fingerprint: string | null; uuid_ready: boolean; has_policy: boolean }>(
      "SELECT id, taiga_project_id, lifecycle, slug, name, profile_fingerprint, uuid_ready, active_activation_id IS NOT NULL AS has_policy FROM project_binding WHERE instance_id = $1", [instance]);
    for (const r of rows) existing.set(Number(r.taiga_project_id), { id: r.id, lifecycle: r.lifecycle, slug: r.slug, name: r.name, fingerprint: r.profile_fingerprint, uuidReady: r.uuid_ready, hasPolicy: r.has_policy });
  }

  const ids = [...new Set([...seen.keys(), ...existing.keys()])].sort((a, b) => a - b);
  const items: MirrorItem[] = ids.map((id) => {
    const s = seen.get(id);
    const e = existing.get(id);
    return { taigaProjectId: id, slug: s?.slug ?? e!.slug, name: s?.name ?? e!.name, ...plan(e, s) };
  });
  if (!apply) return { applied: false, items };

  await pool.query("INSERT INTO taiga_instance (id, instance_key, base_url) VALUES ($1, $2, $3) ON CONFLICT (base_url) DO NOTHING", [uuidv7(), new URL(baseUrl).host, baseUrl]);
  const realInstance = (await pool.query<{ id: string }>("SELECT id FROM taiga_instance WHERE base_url = $1", [baseUrl])).rows[0].id;
  for (const item of items.filter((i) => i.action !== "none")) {
    const s = seen.get(item.taigaProjectId);
    const e = existing.get(item.taigaProjectId);
    const bindingId = e?.id ?? uuidv7();
    if (!e) {
      await pool.query(
        "INSERT INTO project_binding (id, instance_id, taiga_project_id, slug, name, lifecycle) VALUES ($1,$2,$3,$4,$5,'pending') ON CONFLICT (instance_id, taiga_project_id) DO NOTHING",
        [bindingId, realInstance, item.taigaProjectId, item.slug, item.name]);
    }
    const id = e?.id ?? (await pool.query<{ id: string }>("SELECT id FROM project_binding WHERE instance_id = $1 AND taiga_project_id = $2", [realInstance, item.taigaProjectId])).rows[0].id;
    await withProjectLock(pool, id, (c) => withTransaction(c, async () => {
      // The first policy exists before the project is called managed: a crash in between leaves it `pending`, which the runtime refuses.
      if (item.action === "create_managed") await bootstrapPolicy(c, id, legacySeed());
      await c.query(
        "UPDATE project_binding SET lifecycle = $2, slug = $3, name = $4, profile_fingerprint = coalesce($5, profile_fingerprint), uuid_ready = coalesce($6, uuid_ready), last_seen_at = CASE WHEN $5::text IS NULL THEN last_seen_at ELSE now() END WHERE id = $1",
        [id, item.lifecycle, item.slug, item.name, s?.fingerprint ?? null, s?.uuidReady ?? null]);
    }));
  }
  return { applied: true, items };
}
