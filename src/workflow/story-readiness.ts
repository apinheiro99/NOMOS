import type { TaigaClient } from "../client.js";
import type { ActorRole } from "./actor.js";
import { integrityMessage, vocabulary } from "./policy.js";
import { renderGovernedArtifact } from "./refs.js";
import { analyse, orderedComments, type Analysis, type HistoryItem } from "./state.js";
import { latest, loadTemplates, nameFor } from "./templates.js";
import { STATUS_BASE } from "./result.js";
import { continuationOf, recordContinuation } from "./continuation.js";
import { assigneeProblem, resolveAssignee } from "./assignment.js";
import { mutate } from "./mutation.js";

// ONE owner of "a child Task is terminal" and of the mechanical Story readiness promotion. Terminal = semantic Done or Cancelled (by NAME of the
// project vocabulary, never a status id and never is_closed). Cancelled is readiness only, never accepted scope: GPT still judges the Story.
const TERMINAL = new Set(["done", "cancelled"]);

export async function childTaskStates(client: TaigaClient, storyId: number, project: number) {
  const tasks = (await client.getAll("/tasks", { user_story: storyId })) as { ref?: number; id?: number; status?: number }[];
  const vocab = vocabulary("task", await client.get(`/${STATUS_BASE.task}`, { project }));
  return tasks.map((t) => ({ ref: t.ref ?? t.id, terminal: TERMINAL.has(vocab.nameById.get(t.status ?? -1) ?? ""), display: vocab.displayById.get(t.status ?? -1) ?? `status ${String(t.status)}` }));
}

// ONE owner of "a Sprint's scope is complete" (Issue #300): every Story of the Sprint is semantic Done by NAME of the project vocabulary. Unlike readiness,
// Cancelled is NOT accepted scope here. Returns null when complete (an empty Sprint is vacuously complete) or the refusal text naming each non-Done Story.
export async function sprintScopeProblem(client: TaigaClient, project: number, sprint: number): Promise<string | null> {
  const stories = (await client.getAll("/userstories", { milestone: sprint })) as { ref?: number; id?: number; status?: number }[];
  const vocab = vocabulary("userstory", await client.get(`/${STATUS_BASE.userstory}`, { project }));
  const broken = integrityMessage("userstory", vocab);
  if (broken) return broken;
  const open = stories.filter((s) => vocab.nameById.get(s.status ?? -1) !== "done");
  return open.length ? `Sprint ${sprint} scope is not complete: every Story must be Done (Cancelled is not accepted scope); not Done: ${open.map((s) => `#${s.ref ?? s.id} (${vocab.displayById.get(s.status ?? -1) ?? `status ${String(s.status)}`})`).join(", ")}` : null;
}

export type StoryPromotion =
  | { promoted: false; reason: "no_story" | "story_not_in_progress" | "children_not_terminal" }
  | { promoted: true; story: number; comment_id: string; continuation: { id: string; recorded: boolean }; integrity_failure?: string };

// Called after a child Task Done/Cancelled is persisted and proven. Order: the readiness comment is proven in history FIRST, then the Story status
// write (with the version read before) promotes it. Nothing needs compensation: a failure before the status write leaves the Story In Progress
// (an unused mechanical comment may remain and is reused by the next attempt, never duplicated), and a Story is never in GPT Validation without
// its predecessor. A replay finds the Story no longer In Progress; a lost concurrent claim fails on the version check.
export async function promoteStoryWhenChildrenTerminal(client: TaigaClient, role: ActorRole, task: { ref?: number; user_story?: number | null; project?: number }, meta: { model?: unknown; effort?: unknown }): Promise<StoryPromotion> {
  if (task.user_story == null || task.project === undefined) return { promoted: false, reason: "no_story" };
  const story = (await client.get(`/userstories/${task.user_story}`)) as { id: number; ref?: number; status?: number; version: number };
  const vocab = vocabulary("userstory", await client.get(`/${STATUS_BASE.userstory}`, { project: task.project }));
  const target = vocab.idByName.get("gpt validation");
  if (!vocab.strict || target === undefined || vocab.nameById.get(story.status ?? -1) !== "in progress") return { promoted: false, reason: "story_not_in_progress" };
  const children = await childTaskStates(client, story.id, task.project);
  if (children.length === 0 || children.some((c) => !c.terminal)) return { promoted: false, reason: "children_not_terminal" };

  const assignee = await resolveAssignee(client, task.project, "userstory", "gpt validation");
  if (assignee.problem) throw new Error(assignee.problem);
  const templates = loadTemplates();
  const unused = unusedReadiness(analyse((await client.get(`/history/userstory/${story.id}`)) as HistoryItem[], templates));
  let commentId = unused?.id;
  // The readiness comment and the status write go through the one governed write boundary. The Story is read fresh and must still be In Progress
  // (a replay or a lost concurrent claim writes nothing); the promoted status and the projected assignee are reread afterwards and a mismatch is
  // REPORTED next to the promotion (status stays authoritative, nothing is rolled back or retried); it never turns the promotion into a failure.
  const out = await mutate(client, {
    read: () => client.get(`/userstories/${story.id}`) as Promise<{ status?: number; version: number; assigned_to?: number | null }>,
    validators: [(fresh) => (fresh.status === story.status ? null : "the Story is no longer In Progress")],
    write: async (fresh, w) => {
      const wroteComment = !commentId;
      if (!commentId) {
        const template = latest(templates, nameFor("story_readiness_promotion"));
        const rendered = await renderGovernedArtifact(client, task.project!, {
          template, entity: "userstory", author: role, meta,
          transition: { from: vocab.displayById.get(story.status!)!, to: vocab.displayById.get(target)! },
          artifact: { type: template.type, triggering_task: String(task.ref), child_tasks: children.map((c) => ({ ref: String(c.ref), status: c.display })), promotion_reason: "Every child Task is Done or Cancelled, so the Story is mechanically ready for GPT Validation. No acceptance, test or commit evidence is claimed." },
        });
        if (!rendered.ok) throw new Error(rendered.problems[0]);
        await w.comment("userstory", story.id, rendered.text, fresh.version);
        commentId = [...orderedComments((await client.get(`/history/userstory/${story.id}`)) as HistoryItem[])].reverse().find((r) => r.comment === rendered.text.trimEnd())?.id;
        if (!commentId) throw new Error("the readiness comment is not in the history; the Story was not promoted");
      }
      const body = { status: target, ...(assignee.id !== undefined ? { assigned_to: assignee.id } : {}) };
      // A comment written now moved the version by one; a promotion whose comment already existed did not.
      const next = wroteComment ? await w.patchAfterComment("userstory", story.id, body, fresh) : { updated: await w.patch("userstory", story.id, body, fresh.version) };
      if ("conflict" in next) throw new Error(next.conflict);
    },
    verify: (after) => (after.status !== target ? "the Story status read back after the promotion is not GPT Validation" : assigneeProblem(after, assignee.id)),
  });
  if (!out.written) return { promoted: false, reason: "story_not_in_progress" };
  const integrity_failure = out.integrity;
  const readinessId = commentId as string; // set by the existing comment or by the write above
  // GPT now owns the cumulative validation: persist that obligation (a failure is reported, never undoes the promotion; this type is not a Bridge notice).
  const c = continuationOf("STORY_READY_FOR_VALIDATION", "gpt", role === "gpt" ? "gpt" : "claude", "userstory", story.ref ?? story.id, task.project, readinessId);
  let recorded = true;
  try { recordContinuation(c); } catch { recorded = false; }
  return { promoted: true, story: story.id, comment_id: readinessId, continuation: { id: c.id, recorded }, ...(integrity_failure ? { integrity_failure } : {}) };
}

// A readiness comment written after the last point that starts a validation cycle (Story start, correction, manual handoff) and not yet used.
function unusedReadiness(an: Analysis) {
  const startsCycle = (p: { kind: string }) => ["story_start", "story_correction", "story_validation_handoff"].includes(p.kind);
  const boundary = an.all.map(startsCycle).lastIndexOf(true);
  return an.all.slice(boundary + 1).reverse().find((p) => p.kind === "story_readiness_promotion");
}
