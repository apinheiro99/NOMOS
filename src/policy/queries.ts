import type pg from "pg";

// Read-only queries for the admin API. Everything is parameterized; nothing here writes.
type Db = pg.Pool | pg.PoolClient;
export interface Page { limit: number; offset: number }

export async function listProjects(db: Db, { limit, offset }: Page) {
  const { rows } = await db.query(
    `SELECT b.id, b.taiga_project_id AS "taigaProjectId", b.slug, b.name, b.lifecycle, b.uuid_ready AS "uuidReady", v.revision AS "activeRevision"
       FROM project_binding b
       LEFT JOIN policy_activation a ON a.project_id = b.id AND a.id = b.active_activation_id
       LEFT JOIN policy_version v ON v.project_id = a.project_id AND v.id = a.policy_id
      ORDER BY b.name, b.id LIMIT $1 OFFSET $2`,
    [limit, offset],
  );
  return rows.map((r) => ({ ...r, activeRevision: r.activeRevision === null ? null : Number(r.activeRevision) }));
}

export async function getProject(db: Db, id: string) {
  const { rows } = await db.query(
    `SELECT b.id, b.instance_id AS "instanceId", b.taiga_project_id AS "taigaProjectId", b.slug, b.name, b.lifecycle, b.uuid_ready AS "uuidReady",
            b.profile_fingerprint AS "profileFingerprint", b.last_seen_at AS "lastSeenAt", v.revision AS "activeRevision"
       FROM project_binding b
       LEFT JOIN policy_activation a ON a.project_id = b.id AND a.id = b.active_activation_id
       LEFT JOIN policy_version v ON v.project_id = a.project_id AND v.id = a.policy_id
      WHERE b.id = $1`,
    [id],
  );
  const r = rows[0];
  return r ? { ...r, activeRevision: r.activeRevision === null ? null : Number(r.activeRevision) } : null;
}

// state: active (what decides now), approved/rejected (reviewed, not active), pending (no review yet).
const VERSION_COLUMNS = `v.id, v.revision::int AS revision, v.content_hash AS hash, v.proposed_by AS "proposedBy", v.created_at AS "createdAt",
  CASE WHEN b.active_activation_id IS NOT NULL AND EXISTS (SELECT 1 FROM policy_activation a WHERE a.id = b.active_activation_id AND a.policy_id = v.id) THEN 'active'
       WHEN EXISTS (SELECT 1 FROM policy_review r WHERE r.policy_id = v.id AND r.decision = 'approved') THEN 'approved'
       WHEN EXISTS (SELECT 1 FROM policy_review r WHERE r.policy_id = v.id AND r.decision = 'rejected') THEN 'rejected'
       ELSE 'pending' END AS state`;

export async function listVersions(db: Db, projectId: string, { limit, offset }: Page, state?: string) {
  const { rows } = await db.query(
    `SELECT * FROM (SELECT ${VERSION_COLUMNS} FROM policy_version v JOIN project_binding b ON b.id = v.project_id WHERE v.project_id = $1) x
      WHERE ($2::text IS NULL OR state = $2) ORDER BY revision DESC LIMIT $3 OFFSET $4`,
    [projectId, state ?? null, limit, offset],
  );
  return rows;
}

export async function getVersion(db: Db, projectId: string, revision: number) {
  const { rows } = await db.query(
    `SELECT ${VERSION_COLUMNS}, v.payload AS policy FROM policy_version v JOIN project_binding b ON b.id = v.project_id WHERE v.project_id = $1 AND v.revision = $2`,
    [projectId, revision],
  );
  return rows[0] ?? null;
}

export async function listAudit(db: Db, projectId: string, { limit, offset }: Page) {
  const { rows } = await db.query(
    `SELECT id, principal, operation, resource_kind AS "resourceKind", resource_key AS "resourceKey", decision, rule_key AS "ruleKey",
            correlation_id AS "correlationId", details, occurred_at AS "occurredAt"
       FROM policy_audit WHERE project_id = $1 ORDER BY occurred_at DESC, id DESC LIMIT $2 OFFSET $3`,
    [projectId, limit, offset],
  );
  return rows;
}

export async function schemaVersion(db: Db): Promise<string | null> {
  const { rows } = await db.query<{ version: string }>("SELECT version FROM schema_migration ORDER BY version DESC LIMIT 1");
  return rows[0]?.version ?? null;
}
