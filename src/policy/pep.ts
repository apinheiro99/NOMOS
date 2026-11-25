import type { TaigaClient } from "../client.js";
import { OPERATIONS } from "./operations.js";
import type { Operation } from "./catalog.js";
import type { PolicyRuntime } from "./runtime.js";

// Policy enforcement point: ONE decision before any tool handler runs. A write inside a project whose binding is not safe (drift, pending,
// inaccessible, managed without an active policy, database down) is refused here, so a denied call has no side effects at all.
// The semantic rules (typed transitions, closure, order, bulk status, comments) stay in the guards that run after this check.
const BY_ID = new Map<string, Operation>(OPERATIONS.map((o) => [o.id, o]));

// Resource id -> the Taiga collection whose row carries `project`. First match wins; order matters (custom attributes before their entity).
const RESOURCE_ENDPOINT: readonly (readonly [RegExp, string])[] = [
  [/^taiga_(epic|issue|task|userstory)_custom_attributes_/, "$1-custom-attributes"],
  [/^taiga_(issue|task|userstory)_statuses_/, "$1-statuses"],
  [/^taiga_issue_types_/, "issue-types"],
  [/^taiga_(points|priorities|severities|roles|memberships|webhooks)_/, "$1"],
  [/^taiga_wiki_links_/, "wiki-links"],
  [/^taiga_wiki_/, "wiki"],
  [/^taiga_(epics|issues|tasks|userstories|milestones)_/, "$1"],
  [/^taiga_assignees_backfill/, "milestones"],
  [/^taiga_issue_/, "issues"],
  [/^taiga_task_/, "tasks"],
  [/^taiga_userstory_/, "userstories"],
  [/^taiga_project(s_|_export)/, "projects"],
];

// These resolve their own project from richer arguments and decide through the runtime themselves (transition, request, Human Decision),
// or address a target whose kind is chosen by an argument (move, continuation ack). They are cataloged, so they are never "unknown".
const SELF_SCOPED = new Set(["taiga_move", "taiga_continuation_ack", "taiga_webhooklogs_resend"]);

export function operationOf(name: string): Operation | undefined {
  return BY_ID.get(name);
}

// Registration time: a tool the catalog does not know cannot be governed, so a server with a policy runtime refuses to start with it.
export function assertCataloged(name: string): void {
  if (!BY_ID.has(name)) throw new Error(`tool ${name} is not in the policy catalog: regenerate it (node scripts/policy-catalog.ts --write) and give it a rule`);
}

async function projectOf(op: Operation, args: Record<string, unknown>, client: TaigaClient): Promise<number | null> {
  const { scope } = op;
  if (scope.kind === "global") return null;
  const value = args[scope.param];
  if (scope.kind === "project") {
    if (value === undefined && scope.optional) return null;
    return Number(value);
  }
  const hit = RESOURCE_ENDPOINT.map(([re, path]) => [re.exec(op.id), path] as const).find(([m]) => m);
  if (!hit) throw new Error(`no scope resolver for ${op.id}`);
  const [match, template] = hit;
  const collection = template.replace("$1", match![1] ?? "");
  if (collection === "projects") return Number(value);
  const row = (await client.get(`/${collection}/${value}`)) as { project?: number };
  if (typeof row.project !== "number") throw new Error(`${op.id}: the target has no project`);
  return row.project;
}

// Returns a refusal message, or null when the call may continue to the guards and the handler.
export async function enforce(name: string, args: Record<string, unknown>, client: TaigaClient, runtime: PolicyRuntime): Promise<string | null> {
  const op = BY_ID.get(name);
  if (!op) return `tool ${name} is not in the policy catalog`;
  if (op.access === "read" || op.rule === "workflow" || SELF_SCOPED.has(op.id)) return null;
  try {
    const project = await projectOf(op, args, client);
    if (project === null || Number.isNaN(project)) return null;
    await runtime.forProject(project);
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}
