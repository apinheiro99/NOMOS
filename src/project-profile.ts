import { TaigaClient } from "./client.js";
import { initializeProject } from "./identity.js";

// The canonical SCOPE project profile: workflow vocabulary + colours every project must be born with (Guide 3, Guide 6, Guide 9).
// Names and colours only; ids are never carried (they are read from the target project at runtime).
// `Request` is the optional Task status: it is part of the profile because the Claude -> GPT question flow needs it.
export interface ProfileItem { name: string; color: string; is_closed?: boolean; is_archived?: boolean }

export const PROJECT_PROFILE: Record<string, ProfileItem[]> = {
  "userstory-statuses": [
    { name: "Ready", color: "#4A90D9" }, { name: "In Progress", color: "#F5A623" },
    { name: "GPT Validation", color: "#8E6CCF" }, { name: "Human Decision", color: "#D0021B" },
    { name: "Done", color: "#27AE60", is_closed: true, is_archived: true }, { name: "Cancelled", color: "#95A5A6", is_closed: true },
  ],
  "task-statuses": [
    { name: "To Do", color: "#8B9DC3" }, { name: "In Progress", color: "#F5A623" }, { name: "Request", color: "#2D9CDB" },
    { name: "GPT Validation", color: "#8E6CCF" }, { name: "Human Decision", color: "#D0021B" },
    { name: "Done", color: "#27AE60", is_closed: true }, { name: "Cancelled", color: "#95A5A6", is_closed: true },
  ],
  "issue-statuses": [
    { name: "New", color: "#94A3B8" }, { name: "In progress", color: "#2563EB" }, { name: "Ready for test", color: "#8B5CF6" },
    { name: "Closed", color: "#16A34A", is_closed: true }, { name: "Needs Info", color: "#F59E0B" },
    { name: "Rejected", color: "#6B7280", is_closed: true }, { name: "Postponed", color: "#64748B" },
  ],
  "issue-types": [{ name: "Bug", color: "#E35D66" }, { name: "Question", color: "#8064C8" }, { name: "Enhancement", color: "#199C92" }],
  priorities: [{ name: "Low", color: "#64748B" }, { name: "Normal", color: "#EAB308" }, { name: "High", color: "#DC2626" }],
  severities: [
    { name: "Minor", color: "#94A3B8" }, { name: "Normal", color: "#3B82F6" }, { name: "Important", color: "#EA580C" }, { name: "Critical", color: "#B91C1C" },
  ],
  "epic-statuses": [
    { name: "Proposed", color: "#59636F" }, { name: "Active", color: "#4A90D9" }, { name: "Blocked", color: "#E44057" },
    { name: "Completed", color: "#27AE60", is_closed: true }, { name: "Archived", color: "#70728F", is_closed: true },
  ],
};

interface Existing { id: number; name: string; color?: string; order?: number; is_closed?: boolean; is_archived?: boolean }
export type ProfileOp = { op: "create" | "update" | "rename" | "delete"; id?: number; name: string; from?: string; move_to?: string; changes?: Record<string, unknown> };
// A value the profile does not have, still used by cards: it cannot be removed or renamed without changing what those cards mean.
export interface ProfileBlocker { resource: string; value: string; id: number; cards: Record<string, number>; how_to_fix: string }
// The status each new card is born in, owned by the profile at the project object (names only; ids are resolved from the project at runtime).
const DEFAULT_STATUS = [
  { field: "default_us_status", resource: "userstory-statuses", name: "Ready" },
  { field: "default_task_status", resource: "task-statuses", name: "To Do" },
  { field: "default_issue_status", resource: "issue-statuses", name: "New" },
  { field: "default_epic_status", resource: "epic-statuses", name: "Proposed" },
];
export interface DefaultOp { field: string; want: string; current: string | null; to_id?: number }
export interface ProfileReport { project: number; dry_run: boolean; ok: boolean; empty_project: boolean; blockers: ProfileBlocker[]; resources: { resource: string; ops: ProfileOp[]; failed: string[] }[]; defaults: DefaultOp[]; applied: number; failed: number }

// Which card list and filter field reference each resource (used to count the cards that block a removal).
const USAGE: Record<string, { path: string; field: string; label: string }[]> = {
  "userstory-statuses": [{ path: "/userstories", field: "status", label: "stories" }],
  "task-statuses": [{ path: "/tasks", field: "status", label: "tasks" }],
  "issue-statuses": [{ path: "/issues", field: "status", label: "issues" }],
  "issue-types": [{ path: "/issues", field: "type", label: "issues" }],
  priorities: [{ path: "/issues", field: "priority", label: "issues" }],
  severities: [{ path: "/issues", field: "severity", label: "issues" }],
  "epic-statuses": [{ path: "/epics", field: "status", label: "epics" }],
};

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
const same = (a: unknown, b: unknown) => (a ?? false) === (b ?? false);

// True when the project has no Epic, Story, Task or Issue yet. Only then may leftover default values be renamed or deleted
// (renaming a status that holds real cards would silently change their meaning).
async function isEmptyProject(client: TaigaClient, project: number): Promise<boolean> {
  for (const path of ["/userstories", "/tasks", "/issues", "/epics"]) {
    const rows = await client.get(path, { project });
    if (!Array.isArray(rows) || rows.length > 0) return false;
  }
  return true;
}

// Priorities are 0-based in the SCOPE project (Low=0, Normal=1, High=2); every other resource is 1-based.
const ORDER_BASE: Record<string, number> = { priorities: 0 };

function plan(resource: string, desired: ProfileItem[], existing: Existing[], empty: boolean): { ops: ProfileOp[]; leftovers: Existing[] } {
  const ops: ProfileOp[] = [];
  const sorted = [...existing].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const byName = new Map(sorted.map((e) => [norm(e.name), e]));
  const target = new Map<ProfileItem, Existing | undefined>(desired.map((d) => [d, byName.get(norm(d.name))]));
  const used = new Set([...target.values()].filter(Boolean).map((e) => e!.id));
  const leftovers = sorted.filter((e) => !used.has(e.id));
  for (const d of desired) {
    if (target.get(d)) continue;
    const spare = empty ? leftovers.shift() : undefined; // fresh project only: reuse the default value in the same position
    if (spare) { target.set(d, spare); }
  }
  desired.forEach((d, i) => {
    const e = target.get(d);
    const want: Record<string, unknown> = { color: d.color, order: i + (ORDER_BASE[resource] ?? 1), is_closed: d.is_closed ?? false, ...(d.is_archived !== undefined || e?.is_archived !== undefined ? { is_archived: d.is_archived ?? false } : {}) };
    if (!e) { ops.push({ op: "create", name: d.name, changes: { name: d.name, ...want } }); return; }
    const changes: Record<string, unknown> = {};
    if (e.name !== d.name) changes.name = d.name;
    for (const [k, v] of Object.entries(want)) {
      const cur = (e as unknown as Record<string, unknown>)[k];
      if (k === "color" ? String(cur).toLowerCase() !== String(v).toLowerCase() : !same(cur, v) && !(k === "order" && cur === v)) changes[k] = v;
    }
    if (Object.keys(changes).length) ops.push({ op: changes.name ? "rename" : "update", id: e.id, name: d.name, from: changes.name ? e.name : undefined, changes });
  });
  // Anything left over is not part of the profile. In a project with no cards it is deleted; otherwise the caller checks its cards.
  if (empty) for (const e of leftovers) ops.push({ op: "delete", id: e.id, name: e.name, move_to: desired[0].name });
  return { ops, leftovers: empty ? [] : leftovers };
}

// Default-status mismatches of the project object, read from the project's current statuses (nothing is written; existing cards are never involved).
async function planDefaults(client: TaigaClient, project: number): Promise<{ ops: DefaultOp[]; version?: number }> {
  const proj = (await client.get(`/projects/${project}`)) as Record<string, unknown>;
  const ops: DefaultOp[] = [];
  for (const d of DEFAULT_STATUS) {
    const rows = (await client.get(`/${d.resource}`, { project })) as Existing[];
    const current = rows.find((r) => r.id === proj[d.field]);
    if (current && norm(current.name) === norm(d.name)) continue;
    ops.push({ field: d.field, want: d.name, current: current?.name ?? null, to_id: rows.find((r) => norm(r.name) === norm(d.name))?.id });
  }
  return { ops, version: proj.version as number | undefined };
}

// Bring a project to the canonical profile. Dry run (default) only reports. Idempotent. The result is exactly the profile: no extras.
// A value outside the profile that still holds cards is never touched: it is returned as a blocker (which value, how many cards, how to
// fix it) and NOTHING is written until the blockers are gone. Run again afterwards.
// `remap` ({resource: {"Old name": "Profile name"}}) is the explicit way out of a blocker: the cards on the old value are moved to the
// profile value, then the old value is deleted. Nothing is moved unless the caller names it.
export type Remap = Record<string, Record<string, string>>;
interface Move { resource: string; from: Existing; toName: string }

export async function applyProfile(client: TaigaClient, project: number, opts: { dryRun?: boolean; remap?: Remap } = {}): Promise<ProfileReport> {
  const dryRun = opts.dryRun !== false;
  const empty = await isEmptyProject(client, project);
  const report: ProfileReport = { project, dry_run: dryRun, ok: true, empty_project: empty, blockers: [], resources: [], defaults: [], applied: 0, failed: 0 };
  const moves: Move[] = [];
  for (const [resource, desired] of Object.entries(PROJECT_PROFILE)) {
    const entry = { resource, ops: [] as ProfileOp[], failed: [] as string[] };
    report.resources.push(entry);
    try {
      const existing = (await client.get(`/${resource}`, { project })) as Existing[];
      const { ops, leftovers } = plan(resource, desired, existing, empty);
      entry.ops = ops;
      for (const e of leftovers) {
        const cards: Record<string, number> = {};
        for (const u of USAGE[resource] ?? []) {
          const rows = await client.get(u.path, { project, [u.field]: e.id });
          if (Array.isArray(rows) && rows.length) cards[u.label] = rows.length;
        }
        const toName = opts.remap?.[resource]?.[e.name];
        if (Object.keys(cards).length && toName && desired.some((d) => norm(d.name) === norm(toName))) {
          moves.push({ resource, from: e, toName: desired.find((d) => norm(d.name) === norm(toName))!.name });
          entry.ops.push({ op: "delete", id: e.id, name: e.name, move_to: desired[0].name, from: `after moving ${JSON.stringify(cards)} to "${toName}"` });
        } else if (Object.keys(cards).length) report.blockers.push({ resource, value: e.name, id: e.id, cards, how_to_fix: `Move every card that uses ${resource} "${e.name}" to a profile value (${desired.map((d) => d.name).join(", ")}), then run taiga_project_apply_profile again.` });
        else entry.ops.push({ op: "delete", id: e.id, name: e.name, move_to: desired[0].name });
      }
    } catch (e) { entry.failed.push(`read: ${e instanceof Error ? e.message : String(e)}`); report.failed++; }
  }
  try { report.defaults = (await planDefaults(client, project)).ops; } catch (e) {
    report.resources.push({ resource: "project-defaults", ops: [], failed: [`read: ${e instanceof Error ? e.message : String(e)}`] }); report.failed++;
  }
  report.ok = report.blockers.length === 0 && report.failed === 0;
  if (dryRun || !report.ok) return report; // blockers or read failures: write nothing
  const run = async (resource: string, failed: string[], op: ProfileOp) => {
    try {
      if (op.op === "create") await client.post(`/${resource}`, { project, ...op.changes });
      else if (op.op === "delete") {
        // Taiga refuses a DELETE without moveTo (the value that inherits any user); nothing uses this one, so any profile value will do.
        const to = ((await client.get(`/${resource}`, { project })) as Existing[]).find((x) => norm(x.name) === norm(op.move_to ?? ""));
        if (!to) throw new Error(`moveTo target "${op.move_to}" not found`);
        await client.delete(`/${resource}/${op.id}`, { moveTo: to.id });
      } else await client.patch(`/${resource}/${op.id}`, op.changes);
      report.applied++;
    } catch (e) { failed.push(`${op.op} ${op.name}: ${e instanceof Error ? e.message : String(e)}`); report.failed++; report.ok = false; }
  };
  // 1) creates/updates/renames, 2) explicit card moves, 3) deletes (a value is removed only after its cards left it).
  for (const { resource, ops, failed } of report.resources) for (const op of ops) if (op.op !== "delete") await run(resource, failed, op);
  for (const m of moves) {
    const entry = report.resources.find((r) => r.resource === m.resource)!;
    try {
      const target = ((await client.get(`/${m.resource}`, { project })) as Existing[]).find((x) => norm(x.name) === norm(m.toName));
      if (!target) throw new Error(`target "${m.toName}" not found`);
      for (const u of USAGE[m.resource] ?? []) {
        const rows = (await client.get(u.path, { project, [u.field]: m.from.id })) as { id: number; version?: number }[];
        for (const card of rows) { await client.patch(`${u.path}/${card.id}`, { [u.field]: target.id, version: card.version }); report.applied++; }
      }
    } catch (e) { entry.failed.push(`move cards ${m.from.name} -> ${m.toName}: ${e instanceof Error ? e.message : String(e)}`); report.failed++; report.ok = false; }
  }
  if (report.ok) for (const { resource, ops, failed } of report.resources) for (const op of ops) if (op.op === "delete") await run(resource, failed, op);
  // 4) project default statuses, last: they point at statuses that exist only once the steps above are done. Re-planned from the final ids.
  if (report.ok) {
    const entry = { resource: "project-defaults", ops: [] as ProfileOp[], failed: [] as string[] };
    report.resources.push(entry);
    try {
      const { ops, version } = await planDefaults(client, project);
      report.defaults = ops;
      if (ops.length) {
        const missing = ops.find((o) => o.to_id === undefined);
        if (missing) throw new Error(`status "${missing.want}" for ${missing.field} not found`);
        await client.patch(`/projects/${project}`, { version, ...Object.fromEntries(ops.map((o) => [o.field, o.to_id])) });
        report.applied += ops.length;
      }
    } catch (e) { entry.failed.push(`defaults: ${e instanceof Error ? e.message : String(e)}`); report.failed++; report.ok = false; }
  }
  return report;
}

// Profile + UUID readiness: what a project needs to be workable by the MCP from its first card.
export async function prepareProject(client: TaigaClient, project: number, opts: { dryRun?: boolean; remap?: Remap } = {}) {
  const profile = await applyProfile(client, project, opts);
  // UUID setup writes too: skip it while the profile is blocked so a blocked run changes nothing.
  const uuid = profile.ok || opts.dryRun !== false ? await initializeProject(client, project, { dryRun: opts.dryRun !== false ? true : !profile.ok }) : null;
  return { ok: profile.ok, profile, uuid };
}
