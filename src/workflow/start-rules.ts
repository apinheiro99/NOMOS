import type { TaigaClient } from "../client.js";
import { REVIEW_SUBJECT } from "./engineering-review.js";
import { vocabulary, type EntityKind } from "./policy.js";
import { STATUS_BASE } from "./result.js";

// Read-only start rules for an agent-initiated move INTO In Progress. Every decision is made on fresh Taiga reads and discarded: no cache, no
// WIP counter, no stored priority, no history. They only REFUSE (never reorder) and name what blocks and how to fix it.
//   - Order: the visible Taiga order is the execution order. Stories top-to-bottom by sprint_order, Tasks top-to-bottom by taskboard_order inside their
//     taskboard column (the only Task position; a Task being started is in To Do, so the Tasks above it are those above it in that column, and every other
//     open Task of the Sprint is already refused by the single-active-Task rule below). Nothing may start while a card above it is unfinished, and a card is never skipped: only Done/Cancelled are out of the way. A blocked
//     card (is_blocked, or Human Decision) halts everything below it (RULES Guide 1/3); the way forward is to resolve it or reorder in Taiga.
//   - Single active Task: at most one Task of a Sprint is visibly In Progress. A Task leaving To Do (a fresh start) also waits while ANY other Task of
//     the Sprint is In Progress, Request, GPT Validation or Human Decision (PO rule 2026-11-19); a card resuming from Request or returning from GPT
//     Validation is refused only by another In Progress Task.
// The FINAL Sprint Engineering Review Story is not a predecessor of the Stories listed below it; its own place is owned by the canonical order.
export interface Refusal { kind: "story_order" | "task_order" | "active_task"; ref: number; status: string; remediation: string }
export const refusalMessage = (r: Refusal, subject: string) => `${subject} cannot enter In Progress: ${r.kind === "active_task" ? "another Task of the Sprint is already active" : r.kind === "story_order" ? "a Story above it in the Sprint order is not finished" : "a Task above it in its Story is not finished"} (#${r.ref}, ${r.status}). ${r.remediation}`;

interface Row { id: number; ref?: number; status?: number; is_blocked?: boolean; subject?: string; sprint_order?: number; taskboard_order?: number; user_story?: number | null; milestone?: number | null }
const names = async (client: TaigaClient, kind: EntityKind, project: number) => vocabulary(kind, await client.get(`/${STATUS_BASE[kind]}`, { project }));
const byOrder = (rows: Row[], key: "sprint_order" | "taskboard_order") => [...rows].sort((a, b) => (a[key] ?? 0) - (b[key] ?? 0) || a.id - b.id);
const ref = (r: Row) => r.ref ?? r.id;

// The first card above `target` that is not Done/Cancelled (a blocked or Human Decision card included: it halts the rest), or undefined.
function openAbove(rows: Row[], target: Row, key: "sprint_order" | "taskboard_order", nameOf: (r: Row) => string, skip: (r: Row) => boolean = () => false) {
  // "Above" is judged against the target's own position (its order value, then its id), so it holds whether or not the list contains the target.
  const before = (r: Row) => (r.id === target.id ? false : (r[key] ?? 0) !== (target[key] ?? 0) ? (r[key] ?? 0) < (target[key] ?? 0) : r.id < target.id);
  return byOrder(rows, key).find((r) => before(r) && !skip(r) && !["done", "cancelled"].includes(nameOf(r)));
}

export async function storyStartRefusal(client: TaigaClient, project: number, story: Row): Promise<Refusal | null> {
  if (story.milestone == null) return null;
  const vocab = await names(client, "userstory", project);
  const rows = (await client.getAll("/userstories", { milestone: story.milestone })) as Row[];
  const nameOf = (r: Row) => vocab.displayById.get(r.status ?? -1) ?? "unknown";
  const blocker = openAbove(rows, story, "sprint_order", (r) => vocab.nameById.get(r.status ?? -1) ?? "", (r) => r.subject === REVIEW_SUBJECT && story.subject !== REVIEW_SUBJECT);
  return blocker ? { kind: "story_order", ref: ref(blocker), status: nameOf(blocker), remediation: `Finish or resolve Story #${ref(blocker)}, or explicitly reorder the Sprint in Taiga so this Story is first, then retry. Nothing was reordered.` } : null;
}

export const ACTIVE_STATUSES = ["in progress", "request", "gpt validation", "human decision"];
// The statuses in which a card of each entity is work in flight (the others, e.g. Ready/Proposed/Done/Completed/Archived, are not). Epic keeps the profile's Active/Blocked plus the shared card names.
export const activeStatusNames = (entity: EntityKind): string[] =>
  entity === "task" ? ACTIVE_STATUSES : entity === "userstory" ? ACTIVE_STATUSES.filter((s) => s !== "request") : ["active", "blocked", ...ACTIVE_STATUSES.filter((s) => s !== "request")];
export async function taskStartRefusal(client: TaigaClient, project: number, task: Row, fromTodo = false): Promise<Refusal | null> {
  const vocab = await names(client, "task", project);
  const nameOf = (r: Row) => vocab.displayById.get(r.status ?? -1) ?? "unknown";
  if (task.milestone != null) {
    const blocking = fromTodo ? ACTIVE_STATUSES : ["in progress"];
    const active = ((await client.getAll("/tasks", { milestone: task.milestone })) as Row[]).find((r) => r.id !== task.id && blocking.includes(vocab.nameById.get(r.status ?? -1) ?? ""));
    if (active) return { kind: "active_task", ref: ref(active), status: nameOf(active), remediation: `Only one Task per Sprint may be active (In Progress, Request, GPT Validation or Human Decision): wait until Task #${ref(active)} is Done or Cancelled, then retry.` };
  }
  if (task.user_story == null) return null;
  const story = (await client.get(`/userstories/${task.user_story}`)) as Row;
  const parent = await storyStartRefusal(client, project, story);
  if (parent) return parent;
  if (task.milestone == null) return null; // no Sprint, no taskboard column, nothing visible to order
  const sprintTasks = (await client.getAll("/tasks", { milestone: task.milestone })) as Row[];
  const above = openAbove(sprintTasks.filter((r) => r.user_story === task.user_story && r.status === task.status), task, "taskboard_order", (r) => vocab.nameById.get(r.status ?? -1) ?? "");
  return above ? { kind: "task_order", ref: ref(above), status: nameOf(above), remediation: `Finish or resolve Task #${ref(above)} first (a Task is never skipped), or explicitly reorder the Story's Tasks in Taiga so this one is first, then retry. Nothing was reordered.` } : null;
}
