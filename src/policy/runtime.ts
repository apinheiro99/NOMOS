import type pg from "pg";
import { uuidv7 } from "../identity.js";
import type { Policy } from "./types.js";

// What the MCP asks the policy engine at decision time. `null` means "this project is not managed: the legacy rules apply".
export interface ManagedPolicy { projectId: string; activationId: string; revision: number; policy: Policy }

export interface PolicyRuntime {
  forProject(taigaProjectId: number): Promise<ManagedPolicy | null>;
  begin(m: ManagedPolicy, operation: string, target: string): Promise<string>;
  finish(journalId: string, phase: "applied" | "completed" | "failed", result: object): Promise<void>;
}

// Only a project registered as `legacy` (or not registered at all) keeps the old rules. A project that is managed but has no active policy,
// or is pending, drifting or inaccessible, is refused: a database or binding problem must never turn into the permissive path.
const LEGACY = new Set(["legacy", "archived"]);

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
      if (!row || LEGACY.has(row.lifecycle)) return null;
      if (!row.activation_id || !row.payload) throw new Error(`project ${taigaProjectId} is ${row.lifecycle} and has no active policy`);
      return { projectId: row.project_id, activationId: row.activation_id, revision: Number(row.revision), policy: row.payload };
    },
    async begin(m, operation, target) {
      const id = uuidv7();
      await pool.query("INSERT INTO mutation_journal (id, project_id, activation_id, operation, target_key, phase) VALUES ($1,$2,$3,$4,$5,'intent')", [id, m.projectId, m.activationId, operation, target]);
      return id;
    },
    async finish(journalId, phase, result) {
      await pool.query("UPDATE mutation_journal SET phase = $2, result = $3, updated_at = now() WHERE id = $1", [journalId, phase, JSON.stringify(result)]);
    },
  };
}
