import { createHash } from "node:crypto";
import type pg from "pg";
import type { ActorRole } from "../workflow/actor.js";
import type { EntityKind } from "../workflow/policy.js";
import { uuidv7 } from "../identity.js";
import { evaluate } from "./evaluator.js";
import { withProjectLock, withTransaction } from "./repository.js";
import type { Decision, Facts, Policy } from "./types.js";
import { validatePolicy } from "./validator.js";
import { pendingContinuations } from "../workflow/continuation.js";
import type { Violation } from "./validator.js";

// The use cases of the policy engine, shared by the MCP and the admin API. Every change takes the project lock first.
export class PolicyError extends Error {
  constructor(public readonly status: 403 | 404 | 405 | 409 | 413 | 422 | 503, public readonly code: string, message: string, public readonly problems: Violation[] = []) {
    super(message);
    this.name = "PolicyError";
  }
}

export interface ActivePolicy { policyId: string; revision: number; hash: string; policy: Policy }
interface VersionRow { id: string; revision: string; parent_id: string | null; payload: Policy; content_hash: string }

// Keys sorted at every level and undefined values left out (as JSON does), so the same policy has the same hash before and after storage.
const canonical = (v: unknown): string => {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
};
export const policyHash = (policy: Policy) => createHash("sha256").update(canonical(policy)).digest("hex");

const requirePo = (role: ActorRole, what: string) => {
  if (role !== "po") throw new PolicyError(403, "forbidden", `only the PO can ${what}`);
};
const requireValid = (policy: Policy) => {
  const problems = validatePolicy(policy);
  if (problems.length) throw new PolicyError(422, "invalid_policy", `the policy breaks ${problems.length} rule(s)`, problems);
};

type Db = pg.Pool | pg.PoolClient;

export async function activePolicy(db: Db, projectId: string): Promise<ActivePolicy | null> {
  const { rows } = await db.query<VersionRow>(
    `SELECT v.id, v.revision, v.parent_id, v.payload, v.content_hash
       FROM project_binding b
       JOIN policy_activation a ON a.project_id = b.id AND a.id = b.active_activation_id
       JOIN policy_version v ON v.project_id = a.project_id AND v.id = a.policy_id
      WHERE b.id = $1`,
    [projectId],
  );
  return rows[0] ? { policyId: rows[0].id, revision: Number(rows[0].revision), hash: rows[0].content_hash, policy: rows[0].payload } : null;
}

async function audit(c: pg.PoolClient, projectId: string, principal: ActorRole | "system", operation: string, decision: string, details: object) {
  await c.query(
    `INSERT INTO policy_audit (id, instance_id, project_id, principal, operation, resource_kind, decision, correlation_id, details)
     SELECT $1, instance_id, id, $2, $3, 'policy', $4, $5, $6 FROM project_binding WHERE id = $7`,
    [uuidv7(), principal, operation, decision, uuidv7(), JSON.stringify(details), projectId],
  );
}

async function insertVersion(c: pg.PoolClient, projectId: string, policy: Policy, parentId: string | null, proposedBy: ActorRole | "system") {
  const id = uuidv7();
  const hash = policyHash(policy);
  const { rows } = await c.query<{ revision: string }>(
    `INSERT INTO policy_version (id, project_id, revision, parent_id, catalog_version, schema_version, payload, content_hash, proposed_by)
     VALUES ($1, $2, (SELECT coalesce(max(revision), 0) + 1 FROM policy_version WHERE project_id = $2), $3, '1', $4, $5, $6, $7)
     RETURNING revision`,
    [id, projectId, parentId, policy.schemaVersion, JSON.stringify(policy), hash, proposedBy],
  );
  return { policyId: id, revision: Number(rows[0].revision), hash };
}

// Saves an immutable candidate. It never changes the active policy; the PO approves it later.
export const propose = (pool: pg.Pool, projectId: string, by: ActorRole, policy: Policy) =>
  withProjectLock(pool, projectId, (c) => withTransaction(c, async () => {
    requireValid(policy);
    const base = await activePolicy(c, projectId);
    const created = await insertVersion(c, projectId, policy, base?.policyId ?? null, by);
    await audit(c, projectId, by, "propose", "allow", { revision: created.revision, hash: created.hash });
    return created;
  }));

// A rollback is a new proposal that copies an old version; the PO still has to approve it.
export const rollback = (pool: pg.Pool, projectId: string, by: ActorRole, toRevision: number) =>
  withProjectLock(pool, projectId, (c) => withTransaction(c, async () => {
    const { rows } = await c.query<VersionRow>("SELECT payload FROM policy_version WHERE project_id = $1 AND revision = $2", [projectId, toRevision]);
    if (!rows[0]) throw new PolicyError(404, "not_found", `revision ${toRevision} does not exist`);
    const base = await activePolicy(c, projectId);
    const created = await insertVersion(c, projectId, rows[0].payload, base?.policyId ?? null, by);
    await audit(c, projectId, by, "rollback", "allow", { copiedFrom: toRevision, revision: created.revision });
    return created;
  }));

// A policy change must not land on top of work that was decided under the old policy and is not finished: a journal entry still at `intent`
// (its outcome unknown), a merge authorization still owed, or a continuation still pending. The evidence is listed; nothing is guessed or cleared.
async function requireNoPendingWork(c: pg.PoolClient, projectId: string): Promise<void> {
  const { rows } = await c.query<{ taiga_project_id: string; journal: string; merges: string }>(
    `SELECT b.taiga_project_id,
            (SELECT count(*) FROM mutation_journal WHERE project_id = b.id AND phase = 'intent') AS journal,
            (SELECT count(*) FROM merge_obligation WHERE project_id = b.id AND state = 'pending') AS merges
       FROM project_binding b WHERE b.id = $1`, [projectId]);
  const row = rows[0];
  const continuations = (["gpt", "claude"] as const).flatMap((party) => pendingContinuations(party, Number(row.taiga_project_id))).length;
  const pending = { journal_intents: Number(row.journal), merge_obligations: Number(row.merges), continuations };
  if (Object.values(pending).some((n) => n > 0)) throw new PolicyError(409, "pending_work", `the project has unfinished work from the current policy: ${JSON.stringify(pending)}`);
}

// Approves and activates in ONE transaction. The caller states the revision it saw and the exact hash it reviewed.
export const approve = (pool: pg.Pool, projectId: string, by: ActorRole, a: { policyId: string; expectedRevision: number | null; hash: string; reason: string }) =>
  withProjectLock(pool, projectId, (c) => withTransaction(c, async () => {
    requirePo(by, "approve a policy");
    const { rows } = await c.query<VersionRow>("SELECT id, revision, parent_id, payload, content_hash FROM policy_version WHERE project_id = $1 AND id = $2", [projectId, a.policyId]);
    const version = rows[0];
    if (!version) throw new PolicyError(404, "not_found", "that proposal does not exist in this project");
    if (version.content_hash !== a.hash) throw new PolicyError(409, "hash_mismatch", "the proposal is not the one that was reviewed");
    const current = await activePolicy(c, projectId);
    if ((current?.revision ?? null) !== a.expectedRevision || version.parent_id !== (current?.policyId ?? null)) {
      throw new PolicyError(409, "stale", `the active revision is ${current?.revision ?? "none"}, the proposal was made on another one`);
    }
    requireValid(version.payload);
    if ((await c.query("SELECT 1 FROM policy_review WHERE project_id = $1 AND policy_id = $2 AND decision = 'rejected'", [projectId, a.policyId])).rowCount) {
      throw new PolicyError(409, "rejected", "this proposal was rejected: make a new proposal instead");
    }
    await requireNoPendingWork(c, projectId);
    const reviewId = uuidv7();
    const activationId = uuidv7();
    await c.query("INSERT INTO policy_review (id, project_id, policy_id, decision, actor, reason) VALUES ($1,$2,$3,'approved',$4,$5)", [reviewId, projectId, a.policyId, by, a.reason]);
    await c.query("INSERT INTO policy_activation (id, project_id, policy_id, review_id, previous_activation_id, activated_by, reason) VALUES ($1,$2,$3,$4,(SELECT active_activation_id FROM project_binding WHERE id = $2),$5,$6)", [activationId, projectId, a.policyId, reviewId, by, a.reason]);
    await c.query("UPDATE project_binding SET active_activation_id = $1 WHERE id = $2", [activationId, projectId]);
    await audit(c, projectId, by, "approve", "allow", { revision: Number(version.revision), hash: a.hash });
    return { activationId, revision: Number(version.revision) };
  }));

export const reject = (pool: pg.Pool, projectId: string, by: ActorRole, a: { policyId: string; reason: string }) =>
  withProjectLock(pool, projectId, (c) => withTransaction(c, async () => {
    requirePo(by, "reject a policy");
    const found = await c.query("SELECT 1 FROM policy_version WHERE project_id = $1 AND id = $2", [projectId, a.policyId]);
    if (!found.rowCount) throw new PolicyError(404, "not_found", "that proposal does not exist in this project");
    await c.query("INSERT INTO policy_review (id, project_id, policy_id, decision, actor, reason) VALUES ($1,$2,$3,'rejected',$4,$5)", [uuidv7(), projectId, a.policyId, by, a.reason]);
    await audit(c, projectId, by, "reject", "allow", { policyId: a.policyId });
    return { policyId: a.policyId };
  }));

// What the active policy would decide, with the facts the caller states. Writes nothing.
export async function simulate(db: Db, projectId: string, q: { entity: EntityKind; role: ActorRole | null; from: string; to: string; facts?: Facts }): Promise<Decision & { revision: number }> {
  const active = await activePolicy(db, projectId);
  if (!active) throw new PolicyError(404, "not_found", "this project has no active policy");
  return { ...evaluate(active.policy, q.entity, q.role, q.from, q.to, q.facts), revision: active.revision };
}

// First policy of a project, written by the mirror (not by a person): revision 1, an approved "system" review and the activation, in the
// caller's transaction and under the project lock. It refuses a project that already has a version, so it can never replace a policy.
export async function bootstrapPolicy(c: pg.PoolClient, projectId: string, policy: Policy): Promise<{ revision: number; hash: string }> {
  requireValid(policy);
  const existing = await c.query("SELECT 1 FROM policy_version WHERE project_id = $1", [projectId]);
  if (existing.rowCount) throw new PolicyError(409, "stale", "the project already has a policy; the bootstrap never replaces one");
  const created = await insertVersion(c, projectId, policy, null, "system");
  const reviewId = uuidv7();
  const activationId = uuidv7();
  const reason = "bootstrap: the legacy rules as the first policy";
  await c.query("INSERT INTO policy_review (id, project_id, policy_id, decision, actor, reason) VALUES ($1,$2,$3,'approved','system',$4)", [reviewId, projectId, created.policyId, reason]);
  await c.query("INSERT INTO policy_activation (id, project_id, policy_id, review_id, previous_activation_id, activated_by, reason) VALUES ($1,$2,$3,$4,NULL,'system',$5)", [activationId, projectId, created.policyId, reviewId, reason]);
  await c.query("UPDATE project_binding SET active_activation_id = $1 WHERE id = $2", [activationId, projectId]);
  await audit(c, projectId, "system", "bootstrap", "allow", { revision: created.revision, hash: created.hash });
  return { revision: created.revision, hash: created.hash };
}
