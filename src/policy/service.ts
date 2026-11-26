import { createHash } from "node:crypto";
import type pg from "pg";
import type { ActorRole } from "../workflow/actor.js";
import type { EntityKind } from "../workflow/policy.js";
import { uuidv7 } from "../identity.js";
import { evaluate } from "./evaluator.js";
import type { TaigaClient } from "../client.js";
import { vocabulary } from "../workflow/policy.js";
import { STATUS_BASE } from "../workflow/result.js";
import { activeStatusNames } from "../workflow/start-rules.js";
import { withProjectLock, withTransaction } from "./repository.js";
import type { Decision, Facts, Policy } from "./types.js";
import { validatePolicy } from "./validator.js";
import { continuationFile, pendingContinuations } from "../workflow/continuation.js";
import { reconcileContinuations } from "../workflow/continuation-recovery.js";
import type { PolicyRuntime } from "./runtime.js";
import type { Violation } from "./validator.js";

// The use cases of the policy engine, shared by the MCP and the admin API. Every change takes the project lock first.
export class PolicyError extends Error {
  constructor(public readonly status: 403 | 404 | 405 | 409 | 413 | 422 | 503, public readonly code: string, message: string, public readonly problems: Violation[] = []) {
    super(message);
    this.name = "PolicyError";
  }
}

// The PO's Taiga session, the instance it belongs to and the policy runtime of that SAME instance (the admin API's MirrorDeps).
export interface TaigaAccess { client: TaigaClient; baseUrl: string; runtime: Pick<PolicyRuntime, "policyAt"> }
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

// A policy change must not land on top of work that was decided under the current policy and is not finished. Blockers, each listed with the record that holds it:
//   journal entries still `intent` (outcome unknown), `applied` (comment written, status change not proven) or `pending_effect` (an effect still owed, e.g. a merge authorization not delivered);
//   merge obligations `pending` or `review` (a `signed` one is held by its journal entry while that is `pending_effect`);
//   continuations of this project's ledger not yet `handled` (pending or delivered). The ledger is derived state, so it is first rebuilt from Taiga (open
//   Sprints) with the policy that authorized each event; an obligation that cannot be rebuilt refuses too. Nothing is guessed, cleared or acknowledged here.
const UNFINISHED_PHASES = ["intent", "applied", "pending_effect"];
const unreadableLedger = (e: unknown) => new PolicyError(503, "ledger_unavailable", `the continuation ledger could not be read or written, so pending work cannot be ruled out: ${(e as Error).message}`);
const openContinuations = (project: number) => {
  try { return (["gpt", "claude"] as const).flatMap((party) => pendingContinuations(party, project)); }
  catch (e) { throw unreadableLedger(e); }
};
async function rebuildContinuations(taiga: TaigaAccess, project: number): Promise<void> {
  openContinuations(project); // an unreadable ledger is reported as such, not as a Taiga failure
  let unresolved: number;
  try { ({ unresolved } = await reconcileContinuations(taiga.client, project, (comment, writtenAt) => taiga.runtime.policyAt(project, comment, writtenAt))); }
  catch (e) { throw (e as NodeJS.ErrnoException).path === continuationFile() ? unreadableLedger(e) : unavailable("the continuation recovery", e); }
  if (!unresolved) return;
  const detail = `${unresolved} workflow event(s) owe a continuation whose historical policy cannot be proven`;
  throw new PolicyError(409, "continuation_unresolved", `continuations could not be safely rebuilt from the historical policy: ${detail}`, [{ code: "continuation_unresolved", where: `project:${project}`, detail }]);
}
async function requireNoPendingWork(c: pg.PoolClient, projectId: string, taiga: TaigaAccess): Promise<void> {
  const binding = (await c.query<{ taiga_project_id: string }>("SELECT taiga_project_id FROM project_binding WHERE id = $1", [projectId])).rows[0];
  const project = Number(binding.taiga_project_id);
  await rebuildContinuations(taiga, project);
  const journal = (await c.query<{ id: string; operation: string; target_key: string | null; phase: string; authorization_id: string | null; merge_state: string | null }>(
    `SELECT j.id, j.operation, j.target_key, j.phase, m.authorization_id, m.state AS merge_state
       FROM mutation_journal j LEFT JOIN merge_obligation m ON m.journal_id = j.id
      WHERE j.project_id = $1 AND j.phase = ANY($2) ORDER BY j.created_at`, [projectId, UNFINISHED_PHASES])).rows;
  const merges = (await c.query<{ authorization_id: string; entity: string; taiga_id: string; state: string; journal_id: string }>(
    `SELECT authorization_id, entity, taiga_id, state, journal_id FROM merge_obligation WHERE project_id = $1 AND state IN ('pending', 'review') ORDER BY created_at`, [projectId])).rows;
  const ledger = openContinuations(project);
  const count = (phase: string) => journal.filter((j) => j.phase === phase).length;
  const pending = { journal_intents: count("intent"), journal_applied: count("applied"), journal_pending_effect: count("pending_effect"), merge_obligations: merges.length, continuations: ledger.length };
  if (!Object.values(pending).some((n) => n > 0)) return;
  const problems: Violation[] = [
    ...journal.map((j) => ({ code: `journal_${j.phase}`, where: `journal:${j.id}`, detail: `${j.operation} ${j.target_key ?? ""}`.trim() + (j.authorization_id ? ` (merge obligation ${j.authorization_id}, ${j.merge_state})` : "") })),
    ...merges.map((m) => ({ code: `merge_${m.state}`, where: `merge_obligation:${m.authorization_id}`, detail: `${m.entity} #${m.taiga_id} (journal ${m.journal_id})` })),
    ...ledger.map((k) => ({ code: `continuation_${k.state}`, where: `continuation:${k.id}`, detail: `${k.type} ${k.entity} #${k.ref} to ${k.to}${k.request_id ? ` (request ${k.request_id})` : ""}` })),
  ];
  throw new PolicyError(409, "pending_work", `the project has unfinished work from the current policy: ${JSON.stringify(pending)}`, problems);
}

// Work in flight in Taiga that a policy change would strand: a card in an active status of ITS entity, or one in a status the new policy does not have.
// Read under the project lock, from the project's own status vocabulary (never from a name the card happens to carry, never from an is_closed filter),
// every page, so a card on a later page or outside a Sprint counts. What cannot be classified refuses the approval: absent information is not "no work".
const CARDS = [["task", "tasks"], ["userstory", "userstories"], ["epic", "epics"]] as const;
const unavailable = (what: string, e?: unknown) => new PolicyError(503, "taiga_unavailable", `Taiga could not answer for ${what}${e ? `: ${(e as Error).message}` : ""}; work in flight cannot be ruled out`);
async function listOf<T>(read: () => Promise<unknown>, what: string): Promise<T[]> {
  let body: unknown;
  try { body = await read(); } catch (e) { throw unavailable(what, e); }
  if (!Array.isArray(body)) throw unavailable(`${what} (the response was not a list)`);
  return body as T[];
}
async function requireNoActiveWork(c: pg.PoolClient, client: TaigaClient, projectId: string, payload: Policy): Promise<void> {
  const { rows } = await c.query<{ taiga_project_id: string }>("SELECT taiga_project_id FROM project_binding WHERE id = $1", [projectId]);
  const project = Number(rows[0].taiga_project_id);
  const active: string[] = [];
  const unknown: string[] = [];
  const unresolved: string[] = [];
  for (const [entity, path] of CARDS) {
    const rules = payload.entities[entity];
    const statuses = await listOf<{ id?: number; is_closed?: boolean }>(() => client.get(`/${STATUS_BASE[entity]}`, { project }), `${entity} statuses`);
    const names = vocabulary(entity, statuses).nameById;
    const closed = new Set(statuses.filter((s) => s.is_closed).map((s) => s.id));
    const cards = await listOf<{ ref: number; status?: number; status_extra_info?: { name?: string } }>(() => client.getAll(`/${path}`, { project }), `${entity} cards`);
    for (const card of cards) {
      const status = typeof card.status === "number" ? names.get(card.status) : undefined;
      if (status === undefined) unresolved.push(`${entity} #${card.ref}`);
      else if (activeStatusNames(entity).includes(status)) active.push(`${entity} #${card.ref} (${status})`);
      // Only an entity whose every status is governed has a closed vocabulary; for the others a status the policy does not list is a plain, ungoverned one.
      else if (rules.governed === "all" && !closed.has(card.status) && !Object.hasOwn(rules.states, status)) unknown.push(`${entity} #${card.ref} (${status})`);
    }
  }
  const blockers = (code: string, list: string[]): Violation[] => list.map((d) => ({ code, where: d.split(" (")[0], detail: d }));
  if (active.length) throw new PolicyError(409, "active_work", `${active.length} card(s) are in an active status: ${active.join(", ")}`, blockers("active_work", active));
  if (unresolved.length) throw new PolicyError(409, "cards_in_unknown_state", `${unresolved.length} card(s) have a status Taiga does not list for this project: ${unresolved.join(", ")}`, blockers("unresolved_status", unresolved));
  if (unknown.length) throw new PolicyError(409, "cards_in_unknown_state", `${unknown.length} open card(s) sit in a status this policy does not have: ${unknown.join(", ")}`, blockers("unknown_status", unknown));
}

// Approves and activates in ONE transaction. The caller states the revision it saw and the exact hash it reviewed.
export const approve = (pool: pg.Pool, projectId: string, by: ActorRole, a: { policyId: string; expectedRevision: number | null; hash: string; reason: string }, taiga?: TaigaAccess) =>
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
    // Every administrative activation, the first included, needs Taiga's word that nothing is in flight (the mirror's bootstrap is the only path without it).
    if (!taiga) throw new PolicyError(503, "taiga_unavailable", "a policy cannot be activated without checking Taiga for work in flight");
    const bound = (await c.query<{ base_url: string }>("SELECT i.base_url FROM project_binding b JOIN taiga_instance i ON i.id = b.instance_id WHERE b.id = $1", [projectId])).rows[0];
    if (!bound || bound.base_url.replace(/\/+$/, "") !== taiga.baseUrl.replace(/\/+$/, "")) throw new PolicyError(409, "instance_mismatch", "the Taiga session is not the instance this project is bound to");
    await requireNoActiveWork(c, taiga.client, projectId, version.payload);
    await requireNoPendingWork(c, projectId, taiga);
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

// Merge obligations still owed: `review` ones could not be proven from Taiga and wait for a person; `pending` ones are settled by the startup recovery.
export async function listObligations(db: Db, projectId: string) {
  const { rows } = await db.query(
    `SELECT authorization_id, entity, taiga_id, state, actor, recipient, created_at FROM merge_obligation
      WHERE project_id = $1 AND state IN ('pending', 'review') ORDER BY created_at`, [projectId]);
  return rows;
}

// The PO closes a `review` obligation as abandoned: no merge authorization will be issued for it. Nothing is signed from here, and the reason is audited.
export const resolveObligation = (pool: pg.Pool, projectId: string, by: ActorRole, a: { authorizationId: string; reason: string }) =>
  withProjectLock(pool, projectId, (c) => withTransaction(c, async () => {
    requirePo(by, "resolve a merge obligation");
    const done = await c.query<{ journal_id: string }>("UPDATE merge_obligation SET state = 'abandoned', updated_at = now() WHERE project_id = $1 AND authorization_id = $2 AND state = 'review' RETURNING journal_id", [projectId, a.authorizationId]);
    if (!done.rowCount) throw new PolicyError(404, "not_found", "no obligation in review has that id in this project");
    // The PO closed what the entry was waiting for.
    await c.query("UPDATE mutation_journal SET phase = 'completed', updated_at = now() WHERE id = $1 AND phase = 'pending_effect'", [done.rows[0].journal_id]);
    await audit(c, projectId, by, "resolve_obligation", "allow", { authorizationId: a.authorizationId, reason: a.reason });
    return { authorizationId: a.authorizationId, state: "abandoned" };
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
