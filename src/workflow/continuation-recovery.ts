import type { TaigaClient } from "../client.js";
import { continuationOf, recordContinuation } from "./continuation.js";
import { ROLE_OF_AUTHOR } from "./actor.js";
import { recipientOf } from "../policy/evaluator.js";
import type { Policy } from "../policy/types.js";
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
// The artifact's real author; the PO (or anyone else) is not a Bridge party, so a pointer FROM them is never invented.
const party = (a: string | undefined): "gpt" | "claude" | undefined => { const r = a ? ROLE_OF_AUTHOR[a] : undefined; return r === "gpt" || r === "claude" ? r : undefined; };
// The policy that authorized the operation which wrote the artifact comment; "legacy" for a proven legacy event; undefined for a managed event with no evidence.
export type PolicyAt = (artifactCommentId: string, writtenAt?: string) => Promise<Policy | "legacy" | undefined>;

// `policyAt` finds the policy that authorized the original operation: the recipient of a status-driven obligation is then the owner THAT policy names for the
// status (as at emission), never the legacy "other party" nor a later revision; an owner that is not a Bridge party leaves no obligation. A proven legacy event keeps the
// legacy rule; a managed event with no evidence of its policy leaves NO obligation (counted as `unresolved`), because inventing a recipient could dispatch to the wrong party.
// Without `policyAt` (the engine is off on purpose) the legacy rule holds.
export async function reconcileContinuations(client: TaigaClient, project: number, policyAt?: PolicyAt): Promise<{ recovered: number; unresolved: number }> {
  const milestones = (await client.getAll("/milestones", { project, closed: false })) as { id: number }[];
  const taskVocab = vocabulary("task", await client.get(`/${STATUS_BASE.task}`, { project }));
  const storyVocab = vocabulary("userstory", await client.get(`/${STATUS_BASE.userstory}`, { project }));
  if (!taskVocab.strict || !storyVocab.strict) return { recovered: 0, unresolved: 0 };
  const set = loadTemplates();
  let recovered = 0;
  let unresolved = 0;
  let handled = new Set<string>(); // continuations proven handled by Taiga evidence on the card being analysed
  const add = async (type: string, legacyTo: "gpt" | "claude", from: "gpt" | "claude" | undefined, entity: "task" | "userstory", ref: number, artifact: Parsed, extra: { request_id?: string; status?: string } = {}, atStatus?: string) => {
    if (!from) return;
    const policy = atStatus && policyAt ? await policyAt(artifact.id, artifact.created_at) : "legacy";
    if (policy === undefined) { unresolved++; return; }
    const to = policy !== "legacy" && atStatus ? recipientOf(policy, entity, atStatus) : legacyTo;
    if (!to) return;
    const c = continuationOf(type, to, from, entity, ref, project, artifact.id, extra);
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
      if (name === "gpt validation" && storyHandoff?.kind === "story_readiness_promotion") await add("STORY_READY_FOR_VALIDATION", "gpt", party(storyHandoff.author), "userstory", s.ref!, storyHandoff, {}, "gpt validation");
      const approval = last(all, "story_validation_approval");
      if (name === "done" && approval) await add("STORY_DONE", "claude", party(approval.author), "userstory", s.ref!, approval, { status: "Done" }, "done");
    }
    for (const t of tasks) {
      const name = taskVocab.nameById.get(t.status ?? -1);
      if (!name || !["in progress", "gpt validation", "request", "done"].includes(name)) continue;
      const parent = t.user_story == null ? undefined : storyName.get(t.user_story);
      if (name === "done" && (parent === undefined || parent === "done" || parent === "cancelled")) continue; // a finished Story's Tasks are history
      const an = await analysed("task", t.id);
      handled = an.handledContinuations;
      if (name === "in progress" && an.blueprint) await add(an.blueprint.mode === "correction" ? "TASK_RETURNED_TO_IN_PROGRESS" : "TASK_RELEASED", "claude", party(an.blueprint.author), "task", t.ref!, an.blueprint, { status: "In Progress" }, "in progress");
      if (name === "gpt validation" && an.handoff) await add("TASK_MOVED_TO_GPT_VALIDATION", "gpt", party(an.handoff.author), "task", t.ref!, an.handoff, { status: "GPT Validation" }, "gpt validation");
      if (name === "done" && an.approval) await add("TASK_DONE", "claude", party(an.approval.author), "task", t.ref!, an.approval, { status: "Done" }, "done");
      // The CURRENT STATUS decides: only a Task visibly in Request has a Request obligation, and the latest request/response in the history is
      // merely the evidence the pointer cites. Old request comments on a Task in any other status create nothing.
      if (name === "request") {
        const q = an.requests.at(-1);
        const resolved = q && [...an.all].reverse().find((p) => p.kind === "workflow_response" && p.requestId === q.requestId && p.resolved);
        if (q && resolved && (q.from === "gpt" || q.from === "claude")) await add("WORKFLOW_REQUEST_RESOLVED", q.from, party(resolved.author), "task", t.ref!, resolved, { request_id: q.requestId });
        else if (q?.requestId && (q.to === "gpt" || q.to === "claude")) await add("WORKFLOW_REQUEST_OPENED", q.to, party(q.author), "task", t.ref!, q, { request_id: q.requestId });
      }
    }
  }
  return { recovered, unresolved };
}
