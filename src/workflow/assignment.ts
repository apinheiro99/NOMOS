import type { TaigaClient } from "../client.js";
import type { ActorRole } from "./actor.js";
import { activeManaged } from "../policy/context.js";
import { ownerOf } from "../policy/evaluator.js";
import type { Policy } from "../policy/types.js";
import { ownerRole, vocabulary, type EntityKind } from "./policy.js";
import { mutate } from "./mutation.js";
import { BASE, STATUS_BASE } from "./result.js";

// Taiga "Assigned" is a visual PROJECTION of the authoritative workflow owner (status + Request), never an input: nothing here or anywhere
// else reads assigned_to to authorize, order or reconstruct state. ONE owner of that projection, used by every governed status write.
// The Taiga user of a role is its configured account (TAIGA_MCP_EXPECTED_ACCOUNT_<ROLE>, the same value the account binding verifies),
// resolved against the project's active members at write time: no user id is stored or hardcoded. No expected account configured = projection off.
const ROLES: ActorRole[] = ["gpt", "claude", "po"];
const accountVar = (role: ActorRole) => `TAIGA_MCP_EXPECTED_ACCOUNT_${role.toUpperCase()}`;

// Who owns a card in `status`. A managed project asks its own active policy (the owner of that status; a field slot has no fixed account, so no projection); a project
// outside the engine keeps the legacy rule: Task and Epic follow ownerRole, and a User Story is orchestrated by GPT/PO even while In Progress (Claude only executes its
// Tasks). In a policy the same fact is: a Story in Ready, In Progress or GPT Validation belongs to the owner of GPT Validation. Entering Request is always addressed to
// gpt by the legacy transition; Done/Cancelled: no projection.
const ORCHESTRATED = ["ready", "in progress", "gpt validation"];
export function assigneeRole(entity: EntityKind, status: string, policy: Policy | undefined = activeManaged()?.policy): ActorRole | null {
  if (policy) {
    const slot = ownerOf(policy, entity, entity === "userstory" && ORCHESTRATED.includes(status) ? "gpt validation" : status);
    return typeof slot === "string" ? slot : null;
  }
  if (entity === "userstory" && ORCHESTRATED.includes(status)) return "gpt";
  return ownerRole(status);
}

const projectionOn = (env: NodeJS.ProcessEnv) => ROLES.some((r) => env[accountVar(r)]);

// THE account resolver: the Taiga user of `role` among the project's active members (by its configured account name). Used by the Assigned projection and by every
// proof of who wrote in Taiga, so one rule decides who an actor is.
export async function accountOf(client: TaigaClient, project: number, role: ActorRole, env: NodeJS.ProcessEnv = process.env): Promise<{ id?: number; problem?: string }> {
  const username = env[accountVar(role)];
  if (!username) return { problem: `${accountVar(role)} is not configured for the ${role} actor` };
  const members = ((await client.getAll("/users", { project })) as { id: number; username?: string; is_active?: boolean }[]).filter((u) => u.username === username && u.is_active !== false);
  if (members.length !== 1) return { problem: `${members.length ? "ambiguous" : "no active"} project member "${username}" for the ${role} actor (${members.length} found)` };
  return { id: members[0].id };
}

export async function resolveAssignee(client: TaigaClient, project: number, entity: EntityKind, status: string, env: NodeJS.ProcessEnv = process.env): Promise<{ id?: number; problem?: string }> {
  if (!projectionOn(env)) return {};
  const role = assigneeRole(entity, status);
  if (!role) return {};
  const account = await accountOf(client, project, role, env);
  return account.problem ? { problem: `Assigned projection is on but ${account.problem} (owner of "${status}")` } : account;
}

// Check of an already REREAD card (the boundary supplies it): the persisted assignee must be the projected one.
export function assigneeProblem(after: { assigned_to?: number | null }, expected: number | undefined): string | null {
  if (expected === undefined) return null;
  return after.assigned_to === expected ? null : `the persisted assignee (${String(after.assigned_to)}) is not the projected owner`;
}

type Row = { id: number; version?: number; status?: number; assigned_to?: number | null };
const nameOf = async (client: TaigaClient, kind: EntityKind, project: number, status: number | undefined) =>
  status === undefined ? undefined : vocabulary(kind, await client.get(`/${STATUS_BASE[kind]}`, { project })).nameById.get(status);

// A card CREATED in an owned status (Task To Do, Story Ready) never passes through a transition, so the creation itself projects the owner.
// The owner of the initial status (the given one, else the project default) is resolved BEFORE the create, so an unresolvable owner creates
// nothing; afterwards every created row (single, bulk or promoted) gets the projected assignee and is reread. Same resolver, no second mapping.
export async function createdWithOwner<T>(client: TaigaClient, kind: "task" | "userstory", where: { project: number; status?: number }, create: () => Promise<T>, env: NodeJS.ProcessEnv = process.env): Promise<T> {
  if (!projectionOn(env)) return create();
  const defaults = (await client.get(`/projects/${where.project}`)) as { default_task_status?: number; default_us_status?: number };
  const statusId = where.status ?? (kind === "task" ? defaults.default_task_status : defaults.default_us_status);
  const owner = await resolveAssignee(client, where.project, kind, (await nameOf(client, kind, where.project, statusId)) ?? "", env);
  if (owner.problem) throw new Error(`WORKFLOW_ASSIGNEE_UNRESOLVED: ${owner.problem}. Nothing was created.`);
  const created = await create();
  if (owner.id === undefined) return created;
  const out: unknown[] = [];
  for (const row of (Array.isArray(created) ? created : [created]) as Row[]) {
    if (typeof row?.id !== "number") { out.push(row); continue; }
    // The created card is READ FRESH from Taiga (never the create response): its current version and assignee decide the write, and the reread verifies it.
    const done = await mutate(client, {
      read: () => client.get(`/${BASE[kind]}/${row.id}`) as Promise<Row>,
      write: async (card, w) => { if (card.assigned_to !== owner.id) await w.patch(kind, card.id, { assigned_to: owner.id }, card.version); },
      verify: (after) => assigneeProblem(after, owner.id),
    });
    if (!done.written) { out.push(row); continue; }
    out.push(done.integrity ? { ...done.after, assignee_integrity: done.integrity } : done.after);
  }
  return (Array.isArray(created) ? out : out[0]) as T;
}

// One explicit, bounded, idempotent repair of a Sprint's open Tasks and Stories: the target is derived ONLY from each card's current status
// through the canonical resolver (never from watchers, creator or the existing assignee), and ONLY assigned_to is written (status, order,
// history and watchers are untouched). Done/Cancelled and statuses without an owner are skipped. dry_run reports without writing.
export async function backfillSprintAssignees(client: TaigaClient, sprint: number, dryRun: boolean, env: NodeJS.ProcessEnv = process.env) {
  if (!projectionOn(env)) throw new Error("Assigned projection is off: configure TAIGA_MCP_EXPECTED_ACCOUNT_<ROLE> first");
  const { project } = (await client.get(`/milestones/${sprint}`)) as { project: number };
  const report = { sprint, dry_run: dryRun, updated: [] as unknown[], already_correct: 0, skipped: 0, failed: [] as unknown[] };
  for (const kind of ["userstory", "task"] as const) {
    const vocab = vocabulary(kind, await client.get(`/${STATUS_BASE[kind]}`, { project }));
    const owners = new Map<string, { id?: number; problem?: string }>();
    for (const card of (await client.getAll(`/${BASE[kind]}`, { milestone: sprint })) as (Row & { ref?: number })[]) {
      const name = vocab.nameById.get(card.status ?? -1) ?? "";
      if (!assigneeRole(kind, name)) { report.skipped++; continue; }
      if (!owners.has(name)) owners.set(name, await resolveAssignee(client, project, kind, name, env));
      const owner = owners.get(name)!;
      if (owner.problem || owner.id === undefined) { report.failed.push({ kind, ref: card.ref, problem: owner.problem ?? "no owner resolved" }); continue; }
      if (card.assigned_to === owner.id) { report.already_correct++; continue; }
      if (!dryRun) {
        // Fresh read of the card, its owner re-checked (idempotent on a concurrent repair), then only assigned_to is written and reread.
        const done = await mutate(client, {
          read: () => client.get(`/${BASE[kind]}/${card.id}`) as Promise<Row>,
          validators: [(fresh) => (fresh.assigned_to === owner.id ? "already correct" : null)],
          write: (fresh, w) => w.patch(kind, card.id, { assigned_to: owner.id }, fresh.version),
          verify: (after) => assigneeProblem(after, owner.id),
        });
        if (!done.written) { report.already_correct++; continue; }
        if (done.integrity) { report.failed.push({ kind, ref: card.ref, problem: done.integrity }); continue; }
      }
      report.updated.push({ kind, ref: card.ref, status: name, assigned_to: owner.id });
    }
  }
  return report;
}
