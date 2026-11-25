import type pg from "pg";
import { uuidv7 } from "../identity.js";
import { withProjectLock } from "./repository.js";
import { provisionProject } from "./provisioning.js";
import type { Policy } from "./types.js";
import type { MergeContext, MergeEnvelope, WorkItemIdentity } from "../workflow/merge-auth.js";

// What the MCP asks the policy engine at decision time. `null` means "this project is not managed: the legacy rules apply".
export interface ManagedPolicy { projectId: string; activationId: string; revision: number; policy: Policy }

export interface MergeObligation {
  authorizationId: string; entity: "task" | "userstory"; taigaId: number; doneStatus: number; taigaProject: number;
  // No context (and so no work item or target) means a branch was declared but no merge_context was given: the obligation is stored in review, never signed.
  context?: MergeContext; workItem?: WorkItemIdentity; targetWorkItem?: string;
  // Evidence and ownership: the exact approval comment (sha256 of its text), who approved, the journal entry, and the recipient chosen at that moment.
  journalId: string; actor: "gpt" | "claude" | "po"; recipient: "gpt" | "claude" | null; approvalHash: string;
}
export type PendingObligation = MergeObligation & { context: MergeContext; workItem: WorkItemIdentity; targetWorkItem: string; activationId: string; createdAt: Date; envelope?: MergeEnvelope; approvalCommentId?: string };
export type Settlement = { signed: MergeEnvelope; approvalCommentId: string } | { abandoned: true } | { review: true };

export interface PolicyRuntime {
  forProject(taigaProjectId: number): Promise<ManagedPolicy | null>;
  /** Takes the project's exclusive lock for a governed mutation and only THEN reads the policy, so the revision it decides on is the one that stays in force until release.
   *  Resolves to null for a legacy project; throws when the project is not safe or a policy change is running. */
  hold(taigaProjectId: number): Promise<{ managed: ManagedPolicy; release: () => Promise<void> } | null>;
  /** `evidence` is what a later reconciliation looks for in Taiga: the sha256 of the comment about to be written, the status the write moves the card to, and who writes it. */
  begin(m: ManagedPolicy, operation: string, target: string, evidence?: { ref: string; status: number; actor: string }): Promise<string>;
  /** Journal entries of this instance still at `intent` that carry evidence and are older than `minutes` (0 = all: at startup nothing of ours is in flight), so a request still running is never reconciled under its own feet. */
  staleIntents(minutes: number): Promise<{ id: string; project: number; target: string; ref: string; status: number; actor?: string }[]>;
  /** `completed` stays `pending_effect` while a merge authorization is still owed for the entry; `completeEffect` closes it once the envelope is stored and delivered. */
  finish(journalId: string, phase: "applied" | "completed" | "failed", result: object): Promise<void>;
  completeEffect(journalId: string): Promise<void>;
  /** Creates a project through the provisioning intent: idempotent by request key, bound (and its first policy stored) before it is reported. */
  provision(a: { principal: string; requestKey: string; requestHash: string }, create: Parameters<typeof provisionProject>[3], prepare: Parameters<typeof provisionProject>[4]): ReturnType<typeof provisionProject>;
  openMergeObligation(m: ManagedPolicy, o: MergeObligation): Promise<void>;
  settleMergeObligation(authorizationId: string, outcome: Settlement): Promise<void>;
  /** The policy that was in force when the governed operation that wrote this artifact comment was authorized (via the mutation journal). `"legacy"` is a PROVEN legacy
   *  event: the project is registered as legacy, or the comment is older than the project's first activation. `undefined` is a managed event with no evidence (the journal
   *  never learned the comment id): nothing is invented for it. */
  policyAt(taigaProjectId: number, artifactCommentId: string, writtenAt?: string): Promise<Policy | "legacy" | undefined>;
  /** The obligations of this instance whose effect is not finished: the outcome is unknown (pending), or it is signed and its journal entry is still `pending_effect` (delivery not closed). */
  pendingMergeObligations(): Promise<PendingObligation[]>;
}

// Only a project explicitly registered as `legacy` keeps the old rules. A project with no binding (not mirrored yet, or the wrong instance), pending,
// drifting or inaccessible, or managed without an active policy, is refused: a database or binding problem must never turn into the permissive path.
const LEGACY = new Set(["legacy", "archived"]);

// The Taiga instance is identified by its base URL (without a trailing slash), exactly as stored in taiga_instance.base_url.
export function instanceBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  if (!env.TAIGA_URL) throw new Error("Missing required environment variable: TAIGA_URL");
  return env.TAIGA_URL.replace(/\/+$/, "");
}

export function createPolicyRuntime(pool: pg.Pool, baseUrl: string): PolicyRuntime {
  return {
    async forProject(taigaProjectId) {
      const { rows } = await pool.query<{ project_id: string; lifecycle: string; activation_id: string | null; revision: string | null; payload: Policy | null }>(
        `SELECT b.id AS project_id, b.lifecycle, a.id AS activation_id, v.revision, v.payload
           FROM taiga_instance i
           JOIN project_binding b ON b.instance_id = i.id AND b.taiga_project_id = $2
           LEFT JOIN policy_activation a ON a.project_id = b.id AND a.id = b.active_activation_id
           LEFT JOIN policy_version v ON v.project_id = a.project_id AND v.id = a.policy_id
          WHERE i.base_url = $1`,
        [baseUrl, taigaProjectId],
      );
      const row = rows[0];
      if (!row) throw new Error(`project ${taigaProjectId} has no binding in this instance: run the mirror before governed writes`);
      if (LEGACY.has(row.lifecycle)) return null;
      // Drift, pending and inaccessible projects are blocked even when they still hold a policy: the mirror says Taiga no longer matches it.
      if (row.lifecycle !== "managed") throw new Error(`project ${taigaProjectId} is ${row.lifecycle}: governed writes are blocked until the mirror reconciles it`);
      if (!row.activation_id || !row.payload) throw new Error(`project ${taigaProjectId} is managed but has no active policy`);
      return { projectId: row.project_id, activationId: row.activation_id, revision: Number(row.revision), policy: row.payload };
    },
    provision: (a, create, prepare) => provisionProject(pool, baseUrl, a, create, prepare),
    async hold(taigaProjectId) {
      const first = await this.forProject(taigaProjectId); // names the project (and refuses an unsafe one); its policy is read again under the lock
      if (!first) return null;
      // withProjectLock wraps a callback, so the callback parks on `gate` until the caller releases.
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let acquired!: () => void;
      let failed!: (e: unknown) => void;
      const ready = new Promise<void>((resolve, reject) => { acquired = resolve; failed = reject; });
      const done = withProjectLock(pool, first.projectId, async () => { acquired(); await gate; }).catch(failed);
      await ready;
      try {
        const managed = await this.forProject(taigaProjectId);
        if (!managed) throw new Error(`project ${taigaProjectId} changed lifecycle while its lock was being taken`);
        return { managed, release: async () => { release(); await done; } };
      } catch (e) { release(); await done; throw e; }
    },
    async begin(m, operation, target, evidence) {
      const id = uuidv7();
      await pool.query("INSERT INTO mutation_journal (id, project_id, activation_id, operation, target_key, phase, evidence_ref, result) VALUES ($1,$2,$3,$4,$5,'intent',$6,$7)", [id, m.projectId, m.activationId, operation, target, evidence?.ref ?? null, evidence ? JSON.stringify({ status: evidence.status, actor: evidence.actor }) : null]);
      return id;
    },
    async staleIntents(minutes) {
      const { rows } = await pool.query(
        `SELECT j.id, b.taiga_project_id, j.target_key, j.evidence_ref, j.result
           FROM mutation_journal j JOIN project_binding b ON b.id = j.project_id JOIN taiga_instance i ON i.id = b.instance_id
          WHERE i.base_url = $1 AND j.phase = 'intent' AND j.evidence_ref IS NOT NULL AND j.updated_at < now() - make_interval(mins => $2) ORDER BY j.created_at`, [baseUrl, minutes]);
      return rows.map((r) => ({ id: r.id, project: Number(r.taiga_project_id), target: r.target_key, ref: r.evidence_ref, status: Number(r.result.status), actor: r.result.actor }));
    },
    async finish(journalId, phase, result) {
      await pool.query(
        `UPDATE mutation_journal SET result = $3, updated_at = now(),
                phase = CASE WHEN $2 = 'completed' AND EXISTS (SELECT 1 FROM merge_obligation WHERE journal_id = $1 AND state IN ('pending', 'review', 'signed')) THEN 'pending_effect' ELSE $2 END
          WHERE id = $1`, [journalId, phase, JSON.stringify(result)]);
    },
    async completeEffect(journalId) {
      await pool.query("UPDATE mutation_journal SET phase = 'completed', updated_at = now() WHERE id = $1 AND phase = 'pending_effect'", [journalId]);
    },
    async openMergeObligation(m, o) {
      await pool.query(
        `INSERT INTO merge_obligation (authorization_id, project_id, activation_id, journal_id, actor, recipient, approval_hash, entity, taiga_id, done_status, taiga_project, context, work_item, target_work_item, state)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [o.authorizationId, m.projectId, m.activationId, o.journalId, o.actor, o.recipient, o.approvalHash, o.entity, o.taigaId, o.doneStatus, o.taigaProject, o.context ? JSON.stringify(o.context) : null, o.workItem ? JSON.stringify(o.workItem) : null, o.targetWorkItem ?? null, o.context ? "pending" : "review"],
      );
    },
    async settleMergeObligation(authorizationId, outcome) {
      const [state, from, envelope, commentId] =
        "signed" in outcome ? ["signed", "pending", JSON.stringify(outcome.signed), outcome.approvalCommentId]
        : "abandoned" in outcome ? ["abandoned", "pending", null, null] : ["review", "pending", null, null];
      // Each outcome leaves exactly one earlier state, so a settled obligation can never be settled again. An abandoned one means the Done never happened:
      // its journal entry fails with it. A signed one leaves the journal at `pending_effect` until the delivery is closed (completeEffect).
      await pool.query(
        `WITH s AS (UPDATE merge_obligation SET state = $2, envelope = coalesce($4::jsonb, envelope), approval_comment_id = coalesce($5, approval_comment_id), updated_at = now()
                     WHERE authorization_id = $1 AND state = $3 RETURNING journal_id)
         UPDATE mutation_journal SET phase = 'failed', updated_at = now() WHERE $2 = 'abandoned' AND id IN (SELECT journal_id FROM s) AND phase = 'pending_effect'`,
        [authorizationId, state, from, envelope, commentId]);
    },
    async policyAt(taigaProjectId, artifactCommentId, writtenAt) {
      const { rows } = await pool.query<{ payload: Policy | null; lifecycle: string; first_activation: Date | null }>(
        `SELECT b.lifecycle, (SELECT min(a0.activated_at) FROM policy_activation a0 WHERE a0.project_id = b.id) AS first_activation,
                (SELECT v.payload FROM mutation_journal j JOIN policy_activation a ON a.id = j.activation_id JOIN policy_version v ON v.project_id = a.project_id AND v.id = a.policy_id
                  WHERE j.project_id = b.id AND j.result->>'comment_id' = $3 ORDER BY j.created_at DESC LIMIT 1) AS payload
           FROM taiga_instance i JOIN project_binding b ON b.instance_id = i.id AND b.taiga_project_id = $2
          WHERE i.base_url = $1`, [baseUrl, taigaProjectId, artifactCommentId]);
      const row = rows[0];
      if (!row) return undefined; // not mirrored: never treated as legacy
      if (row.payload) return row.payload;
      if (LEGACY.has(row.lifecycle)) return "legacy";
      const written = writtenAt ? Date.parse(writtenAt) : NaN;
      return row.first_activation === null || written < row.first_activation.getTime() ? "legacy" : undefined;
    },
    async pendingMergeObligations() {
      const { rows } = await pool.query(
        `SELECT m.authorization_id, m.activation_id, m.journal_id, m.actor, m.recipient, m.approval_hash, m.entity, m.taiga_id, m.done_status, m.taiga_project, m.context, m.work_item, m.target_work_item, m.created_at, m.envelope, m.approval_comment_id
           FROM merge_obligation m JOIN project_binding b ON b.id = m.project_id JOIN taiga_instance i ON i.id = b.instance_id
           JOIN mutation_journal j ON j.id = m.journal_id
          WHERE i.base_url = $1 AND (m.state = 'pending' OR (m.state = 'signed' AND j.phase = 'pending_effect')) ORDER BY m.created_at`, [baseUrl]);
      return rows.map((r) => ({ authorizationId: r.authorization_id, activationId: r.activation_id, journalId: r.journal_id, actor: r.actor, recipient: r.recipient, approvalHash: r.approval_hash, entity: r.entity, taigaId: Number(r.taiga_id), doneStatus: Number(r.done_status), taigaProject: Number(r.taiga_project), context: r.context, workItem: r.work_item, targetWorkItem: r.target_work_item, createdAt: r.created_at, ...(r.envelope ? { envelope: r.envelope, approvalCommentId: r.approval_comment_id } : {}) }));
    },
  };
}
