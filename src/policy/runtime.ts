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
  context: MergeContext; workItem: WorkItemIdentity; targetWorkItem: string;
}

export interface PolicyRuntime {
  forProject(taigaProjectId: number): Promise<ManagedPolicy | null>;
  /** Holds the project's shared lock for a governed mutation. Resolves to the release function, or null for a legacy project. Throws when the project is not safe or a policy change is running. */
  hold(taigaProjectId: number): Promise<(() => Promise<void>) | null>;
  begin(m: ManagedPolicy, operation: string, target: string): Promise<string>;
  finish(journalId: string, phase: "applied" | "completed" | "failed", result: object): Promise<void>;
  /** Creates a project through the provisioning intent: idempotent by request key, bound (and its first policy stored) before it is reported. */
  provision(a: { principal: string; requestKey: string; requestHash: string }, create: Parameters<typeof provisionProject>[3]): ReturnType<typeof provisionProject>;
  openMergeObligation(m: ManagedPolicy, o: MergeObligation): Promise<void>;
  settleMergeObligation(authorizationId: string, outcome: { signed: MergeEnvelope } | { abandoned: true }): Promise<void>;
  pendingMergeObligations(): Promise<MergeObligation[]>;
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
    provision: (a, create) => provisionProject(pool, baseUrl, a, create),
    async hold(taigaProjectId) {
      const managed = await this.forProject(taigaProjectId);
      if (!managed) return null;
      // withProjectLock wraps a callback, so the callback parks on `gate` until the caller releases.
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let acquired!: () => void;
      let failed!: (e: unknown) => void;
      const ready = new Promise<void>((resolve, reject) => { acquired = resolve; failed = reject; });
      const done = withProjectLock(pool, managed.projectId, async () => { acquired(); await gate; }, true).catch(failed);
      await ready;
      return async () => { release(); await done; };
    },
    async begin(m, operation, target) {
      const id = uuidv7();
      await pool.query("INSERT INTO mutation_journal (id, project_id, activation_id, operation, target_key, phase) VALUES ($1,$2,$3,$4,$5,'intent')", [id, m.projectId, m.activationId, operation, target]);
      return id;
    },
    async finish(journalId, phase, result) {
      await pool.query("UPDATE mutation_journal SET phase = $2, result = $3, updated_at = now() WHERE id = $1", [journalId, phase, JSON.stringify(result)]);
    },
    async openMergeObligation(m, o) {
      await pool.query(
        `INSERT INTO merge_obligation (authorization_id, project_id, entity, taiga_id, done_status, taiga_project, context, work_item, target_work_item, state)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending')`,
        [o.authorizationId, m.projectId, o.entity, o.taigaId, o.doneStatus, o.taigaProject, JSON.stringify(o.context), JSON.stringify(o.workItem), o.targetWorkItem],
      );
    },
    async settleMergeObligation(authorizationId, outcome) {
      const signed = "signed" in outcome;
      await pool.query("UPDATE merge_obligation SET state = $2, envelope = $3, updated_at = now() WHERE authorization_id = $1 AND state = 'pending'", [authorizationId, signed ? "signed" : "abandoned", signed ? JSON.stringify(outcome.signed) : null]);
    },
    async pendingMergeObligations() {
      const { rows } = await pool.query("SELECT authorization_id, entity, taiga_id, done_status, taiga_project, context, work_item, target_work_item FROM merge_obligation WHERE state = 'pending' ORDER BY created_at");
      return rows.map((r) => ({ authorizationId: r.authorization_id, entity: r.entity, taigaId: Number(r.taiga_id), doneStatus: Number(r.done_status), taigaProject: Number(r.taiga_project), context: r.context, workItem: r.work_item, targetWorkItem: r.target_work_item }));
    },
  };
}
