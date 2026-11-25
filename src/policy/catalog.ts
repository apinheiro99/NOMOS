import type { ArtifactType } from "../workflow/policy.js";

// The artifacts a transition may require. The type below fails the build if one is added to ArtifactType and not listed here.
export const ARTIFACT_TYPES = [
  "implementation_blueprint", "execution_handoff", "validation_approval",
  "human_decision_request", "blocker_report", "po_decision", "workflow_request", "request_resume",
  "story_start", "story_validation_handoff", "story_validation_approval", "story_correction",
] as const satisfies readonly ArtifactType[];

type Unlisted = Exclude<ArtifactType, (typeof ARTIFACT_TYPES)[number]>;
export const everyArtifactIsListed: [Unlisted] extends [never] ? true : never = true;

// Where the project of a call comes from: an argument that names it, the resource the call is about (read back from Taiga), or nowhere.
export type Scope = { kind: "project"; param: string; optional?: boolean } | { kind: "resource"; param: string } | { kind: "global" };
// baseline = today's behavior kept as is; workflow = governed lifecycle; bootstrap = creates a project; fail-closed is "not in this list".
export interface Operation { id: string; access: "read" | "write"; scope: Scope; rule: "baseline" | "workflow" | "bootstrap" }

// Writes to Taiga that are NOT a tool of their own: code that a tool (or a transition) triggers. Each names the operations that reach it.
// A test scans src for write call sites and requires this list to match them exactly.
export const INTERNAL_MUTATORS: Readonly<Record<string, readonly string[]>> = {
  "src/comment.ts": ["taiga_workflow_transition", "taiga_tasks_update", "taiga_userstories_update", "taiga_epics_update"],
  "src/governance.ts": ["taiga_workflow_transition"],
  "src/identity.ts": ["taiga_uuid_initialize_project", "taiga_uuid_backfill"],
  "src/project-profile.ts": ["taiga_projects_create", "taiga_project_apply_profile"],
  "src/workflow/assignment.ts": ["taiga_assignees_backfill", "taiga_workflow_transition"],
  "src/workflow/engineering-review.ts": ["taiga_milestones_close"],
  "src/workflow/mutation.ts": ["taiga_workflow_transition", "taiga_workflow_request_create", "taiga_workflow_request_answer", "taiga_human_decision_resolve"],
  "src/workflow/story-readiness.ts": ["taiga_workflow_transition"],
  "src/workflow/tools.ts": ["taiga_workflow_request_create", "taiga_workflow_request_answer", "taiga_human_decision_resolve"],
};

// The one write the transitions decide; every other write is decided by the operation permissions of the policy.
export const DECIDED_BY_TRANSITIONS = "taiga_workflow_transition";
