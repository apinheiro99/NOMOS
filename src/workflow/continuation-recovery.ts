import type { TaigaClient } from "../client.js";
import { continuationOf, recordContinuation } from "./continuation.js";
import { vocabulary } from "./policy.js";
import { STATUS_BASE } from "./result.js";
import { analyse, type HistoryItem, type Parsed } from "./state.js";
import { loadTemplates } from "./templates.js";

// The continuation ledger is derived orchestration state: if an append failed after the Taiga mutation persisted (or the file was lost), the
// obligation is rebuilt from the AUTHORITATIVE workflow facts (current status + the governed artifacts in history). Identities are built with
// the same continuationOf() and the same source (the persisted artifact comment id) as normal emission, so a recovered and an originally
// recorded obligation fold to ONE; an id already in the ledger (including a handled one) is never touched. A continuation proven handled by its Continuation Handled marker on the card is never rebuilt. Scope: the CURRENT state of cards
// in open Sprints only (a closed Sprint's history is not re-opened); Bridge state is never read; nothing is auto-handled.
type Row = { id: number; ref?: number; status?: number; user_story?: number | null };
const last = (all: Parsed[], kind: string) => [...all].reverse().find((p) => p.kind === kind);
const party = (a: string | undefined): "gpt" | "claude" => (a === "GPT" || a === "gpt" ? "gpt" : "claude");

export async function reconcileContinuations(client: TaigaClient, project: number): Promise<{ recovered: number }> {
  const milestones = (await client.getAll("/milestones", { project, closed: false })) as { id: number }[];
  const taskVocab = vocabulary("task", await client.get(`/${STATUS_BASE.task}`, { project }));
  const storyVocab = vocabulary("userstory", await client.get(`/${STATUS_BASE.userstory}`, { project }));
  if (!taskVocab.strict || !storyVocab.strict) return { recovered: 0 };
  const set = loadTemplates();
  let recovered = 0;
  let handled = new Set<string>(); // continuations proven handled by Taiga evidence on the card being analysed
  const add = (type: string, to: "gpt" | "claude", from: "gpt" | "claude", entity: "task" | "userstory", ref: number, source: string, extra: { request_id?: string; status?: string } = {}) => {
    const c = continuationOf(type, to, from, entity, ref, project, source, extra);
    if (!handled.has(c.id) && !recordContinuation(c).duplicate) recovered++;
  };
  const analysed = async (kind: "task" | "userstory", id: number) => analyse((await client.get(`/history/${kind}/${id}`)) as HistoryItem[], set);

  for (const { id: milestone } of milestones) {
    const stories = (await client.getAll("/userstories", { milestone })) as Row[];
    const tasks = (await client.getAll("/tasks", { milestone })) as Row[];
    const storyName = new Map(stories.map((s) => [s.id, storyVocab.nameById.get(s.status ?? -1)]));
    for (const s of stories) {
      const name = storyVocab.nameById.get(s.status ?? -1);
      if (name !== "gpt validation" && name !== "done") continue;
      const { all, storyHandoff, handledContinuations } = await analysed("userstory", s.id);
      handled = handledContinuations;
      if (name === "gpt validation" && storyHandoff?.kind === "story_readiness_promotion") add("STORY_READY_FOR_VALIDATION", "gpt", party(storyHandoff.author), "userstory", s.ref!, storyHandoff.id);
      const approval = last(all, "story_validation_approval");
      if (name === "done" && approval) add("STORY_DONE", "claude", "gpt", "userstory", s.ref!, approval.id, { status: "Done" });
    }
    for (const t of tasks) {
      const name = taskVocab.nameById.get(t.status ?? -1);
      if (!name || !["in progress", "gpt validation", "request", "done"].includes(name)) continue;
      const parent = t.user_story == null ? undefined : storyName.get(t.user_story);
      if (name === "done" && (parent === undefined || parent === "done" || parent === "cancelled")) continue; // a finished Story's Tasks are history
      const an = await analysed("task", t.id);
      handled = an.handledContinuations;
      if (name === "in progress" && an.blueprint) add(an.blueprint.mode === "correction" ? "TASK_RETURNED_TO_IN_PROGRESS" : "TASK_RELEASED", "claude", "gpt", "task", t.ref!, an.blueprint.id, { status: "In Progress" });
      if (name === "gpt validation" && an.handoff) add("TASK_MOVED_TO_GPT_VALIDATION", "gpt", "claude", "task", t.ref!, an.handoff.id, { status: "GPT Validation" });
      if (name === "done" && an.approval) add("TASK_DONE", "claude", "gpt", "task", t.ref!, an.approval.id, { status: "Done" });
      // The CURRENT STATUS decides: only a Task visibly in Request has a Request obligation, and the latest request/response in the history is
      // merely the evidence the pointer cites. Old request comments on a Task in any other status create nothing.
      if (name === "request") {
        const q = an.requests.at(-1);
        const resolved = q && [...an.all].reverse().find((p) => p.kind === "workflow_response" && p.requestId === q.requestId && p.resolved);
        if (q && resolved && (q.from === "gpt" || q.from === "claude")) add("WORKFLOW_REQUEST_RESOLVED", q.from, q.from === "gpt" ? "claude" : "gpt", "task", t.ref!, resolved.id, { request_id: q.requestId });
        else if (q?.requestId && (q.to === "gpt" || q.to === "claude")) add("WORKFLOW_REQUEST_OPENED", q.to, q.from === "gpt" ? "gpt" : "claude", "task", t.ref!, q.id, { request_id: q.requestId });
      }
    }
  }
  return { recovered };
}
