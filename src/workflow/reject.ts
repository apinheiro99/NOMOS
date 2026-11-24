import type { Template } from "./templates.js";
import { text, type ToolResult } from "./result.js";

// Guided, deterministic rejection for workflow mutations. Everything about the expected artifact (type, version, template path)
// comes from the resolved Template, never from a copy; the full content is read on demand with taiga_workflow_template.
export interface RejectInfo {
  code: string; message: string;
  actor?: string | null; currentStatus?: string; attempted?: string;
  template?: Template; missing?: string[]; invalid?: string[]; violations?: string[];
  allowed?: unknown[]; nextStep?: string; blocker?: unknown;
}

const NEXT: Record<string, string> = {
  WORKFLOW_IDENTITY_REQUIRED: "Run this MCP with an authenticated actor (TAIGA_MCP_ACTOR for stdio, or a bearer token for HTTP); strict workflow mutations are not available to syntactic callers. Reads still work.",
  WORKFLOW_IDENTITY_MISMATCH: "Start this MCP with the Taiga credentials of the account configured for the actor (TAIGA_MCP_EXPECTED_ACCOUNT_<ROLE>), or fix that variable; there is no fallback to another account.",
  WORKFLOW_ASSIGNEE_UNRESOLVED: "Assigned projects the workflow owner. Add the owner's account as an active project member and check TAIGA_MCP_EXPECTED_ACCOUNT_<ROLE> for that role; nothing was written.",
  WORKFLOW_START_REFUSED: "The card cannot start now: see `blocker` (kind, ref, status) and its remediation. The board order is canonical and nothing is reordered for you; resolve the blocker or explicitly reorder in Taiga, then retry.",
  WORKFLOW_PRECONDITION_FAILED: "A validator refused the mutation on fresh Taiga state; nothing was written. Fix the stated precondition and retry.",
  WORKFLOW_TRANSITION_REJECTED: "Call taiga_task_workflow_state to see what this actor may do from the current status.",
  WORKFLOW_TEMPLATE_UNAVAILABLE: "Fix the template directory or the declared Schema version (taiga_workflow_template lists the versions that exist); history is never reinterpreted with another version.",
};

export function rejection(i: RejectInfo): ToolResult {
  const t = i.template;
  return text({
    code: i.code, message: i.message, actor: i.actor ?? null, current_status: i.currentStatus ?? null, attempted_action: i.attempted ?? null,
    required_artifact: t?.type ?? null, required_version: t?.version ?? null,
    missing_fields: [...new Set(i.missing ?? [])], invalid_fields: [...new Set(i.invalid ?? [])],
    template_path: t ? `workflow/templates/${t.file}` : null,
    allowed_actions: i.allowed ?? [],
    next_step: i.nextStep ?? NEXT[i.code] ?? (t ? `Read the template with taiga_workflow_template (name: ${t.name}), fix the listed fields and retry.` : "Call taiga_task_workflow_state to see what this actor may do."),
    violations: i.violations ?? [i.message],
    ...(i.blocker !== undefined ? { blocker: i.blocker } : {}),
    note: "Rejected before any Taiga mutation.",
  }, true);
}
