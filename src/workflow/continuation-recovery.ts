import type { TaigaClient } from "../client.js";
import { continuationOf, foldContinuations, recordContinuation, type Continuation } from "./continuation.js";
import { ROLE_OF_AUTHOR } from "./actor.js";
import { recipientOf } from "../policy/evaluator.js";
import type { Policy } from "../policy/types.js";
import { mergeConfirmationProblem, readMergeReady } from "./merge-ready.js";
import { otherParty, type NoticeType, type Party } from "./notify.js";
import { vocabulary } from "./policy.js";
import { STATUS_BASE } from "./result.js";
import { analyse, type HistoryItem, type Parsed } from "./state.js";
import { loadTemplates } from "./templates.js";

// The continuation ledger is derived orchestration state: if an append failed after the Taiga mutation persisted (or the file was lost), the
// obligation is rebuilt from the AUTHORITATIVE workflow facts. Identities are built with the same continuationOf() and the same source (the persisted
// artifact comment or authorization id) as normal emission, so a recovered and an originally recorded obligation fold to ONE; an id already in the ledger
// (including a handled one) is never touched. Scope: every Story, Task and Sprint of the project, whatever the Sprint (open, closed or none):
//   cards       the boundary of the CURRENT status (Task In Progress / GPT Validation / Human Decision / Done; Story GPT Validation / Done);
//               a Done Task under a Done or Cancelled Story is history;
//   requests    in every Task, whatever its status: the latest boundary of each request id (opened, answered or resolved);
//   Sprints     a merge-ready record whose merge is not confirmed.
// Proof of handling: the Continuation Handled marker on the card; for a Sprint, which has no card, the verified GitGate receipt. Bridge state is never read.
type Row = { id: number; ref?: number; status?: number; user_story?: number | null };
type Obligation = { type: NoticeType | "STORY_READY_FOR_VALIDATION"; to: Party | undefined; from: Party | undefined; entity: Continuation["entity"]; ref: number; source: string; extra?: { request_id?: string; status?: string } };
const last = (all: Parsed[], kind: string) => [...all].reverse().find((p) => p.kind === kind);
// The artifact's real author; the PO (or anyone else) is not a Bridge party, so a pointer FROM them is never invented.
const party = (a: string | undefined): Party | undefined => { const r = a ? ROLE_OF_AUTHOR[a] : undefined; return r === "gpt" || r === "claude" ? r : undefined; };
const asParty = (r: string | undefined): Party | undefined => (r === "gpt" || r === "claude" ? r : undefined);
// The policy that authorized the operation which wrote the artifact comment; "legacy" for a proven legacy event; undefined for a managed event with no evidence.
export type PolicyAt = (artifactCommentId: string, writtenAt?: string) => Promise<Policy | "legacy" | undefined>;

// `policyAt` finds the policy that authorized the original operation: the recipient of a status-driven obligation is then the owner THAT policy names for the
// status (as at emission), never the legacy "other party" nor a later revision; an owner that is not a Bridge party leaves no obligation. A proven legacy event keeps the
// legacy rule; a managed event with no evidence of its policy leaves NO obligation (counted as `unresolved`), because inventing a recipient could dispatch to the wrong party.
// Without `policyAt` (the engine is off on purpose) the legacy rule holds. A workflow whose statuses cannot be classified is `unresolved` too: it proves nothing.
export async function reconcileContinuations(client: TaigaClient, project: number, policyAt?: PolicyAt): Promise<{ recovered: number; unresolved: number }> {
  const taskVocab = vocabulary("task", await client.get(`/${STATUS_BASE.task}`, { project }));
  const storyVocab = vocabulary("userstory", await client.get(`/${STATUS_BASE.userstory}`, { project }));
  if ([taskVocab, storyVocab].some((v) => !v.strict || v.broken.length)) return { recovered: 0, unresolved: 1 };
  const set = loadTemplates();
  let recovered = 0;
  let unresolved = 0;
  // `policyDriven`: the status whose owner the authorizing policy names as recipient; without it the obligation's own `to` is the producer's rule.
  const add = async (o: Obligation, handled: Set<string>, policyDriven?: { artifact: Parsed; entity: "task" | "userstory"; status: string }) => {
    if (!o.from) return;
    const identity = continuationOf(o.type, o.to ?? o.from, o.from, o.entity, o.ref, project, o.source, o.extra);
    if (handled.has(identity.id) || foldContinuations().has(identity.id)) return;
    let to = o.to;
    if (policyDriven && policyAt) {
      const policy = await policyAt(policyDriven.artifact.id, policyDriven.artifact.created_at);
      if (policy === undefined) { unresolved++; return; }
      if (policy !== "legacy") to = recipientOf(policy, policyDriven.entity, policyDriven.status) ?? undefined;
    }
    if (to && !recordContinuation({ ...identity, to }).duplicate) recovered++;
  };
  const analysed = async (kind: "task" | "userstory", id: number) => analyse((await client.getAll(`/history/${kind}/${id}`)) as HistoryItem[], set);
  const stories = (await client.getAll("/userstories", { project })) as Row[];
  const tasks = (await client.getAll("/tasks", { project })) as Row[];
  const storyName = new Map(stories.map((s) => [s.id, storyVocab.nameById.get(s.status ?? -1)]));

  for (const s of stories) {
    const name = storyVocab.nameById.get(s.status ?? -1);
    if (name !== "gpt validation" && name !== "done") continue;
    const { all, storyHandoff, handledContinuations } = await analysed("userstory", s.id);
    // The readiness promotion always points at GPT (see story-readiness.ts), whoever completed the last child: no policy names this recipient.
    if (name === "gpt validation" && storyHandoff?.kind === "story_readiness_promotion") {
      await add({ type: "STORY_READY_FOR_VALIDATION", to: "gpt", from: party(storyHandoff.author) === "gpt" ? "gpt" : "claude", entity: "userstory", ref: s.ref!, source: storyHandoff.id }, handledContinuations);
    }
    const approval = last(all, "story_validation_approval");
    if (name === "done" && approval) await add({ type: "STORY_DONE", to: "claude", from: party(approval.author), entity: "userstory", ref: s.ref!, source: approval.id, extra: { status: "Done" } }, handledContinuations, { artifact: approval, entity: "userstory", status: "done" });
  }

  for (const t of tasks) {
    const name = taskVocab.nameById.get(t.status ?? -1);
    const an = await analysed("task", t.id);
    const task = (type: Obligation["type"], to: Party | undefined, artifact: Parsed, status: string, display: string) =>
      add({ type, to, from: party(artifact.author), entity: "task", ref: t.ref!, source: artifact.id, extra: { status: display } }, an.handledContinuations, { artifact, entity: "task", status });
    if (name === "in progress" && an.blueprint) {
      const returned = an.blueprint.movedFrom ? an.blueprint.movedFrom === "gpt validation" : an.blueprint.mode === "correction";
      await task(returned ? "TASK_RETURNED_TO_IN_PROGRESS" : "TASK_RELEASED", "claude", an.blueprint, "in progress", "In Progress");
    }
    if (name === "gpt validation" && an.handoff) await task("TASK_MOVED_TO_GPT_VALIDATION", "gpt", an.handoff, "gpt validation", "GPT Validation");
    const hd = an.decisionRequest;
    const asker = party(hd?.author);
    if (name === "human decision" && hd && asker) await task("TASK_MOVED_TO_HUMAN_DECISION", otherParty(asker), hd, "human decision", "Human Decision");
    const parent = t.user_story == null ? undefined : storyName.get(t.user_story);
    if (name === "done" && an.approval && parent !== "done" && parent !== "cancelled") await task("TASK_DONE", "claude", an.approval, "done", "Done");

    for (const q of an.requests) {
      const answers = an.all.filter((p) => p.kind === "workflow_response" && p.requestId === q.requestId);
      const latest = answers.find((p) => p.resolved) ?? answers.at(-1);
      const source = latest ?? q;
      const obligation: Obligation = {
        type: !latest ? "WORKFLOW_REQUEST_OPENED" : latest.resolved ? "WORKFLOW_REQUEST_RESOLVED" : "WORKFLOW_REQUEST_ANSWERED",
        to: asParty(latest ? q.from : q.to), from: party(source.author), entity: "task", ref: t.ref!, source: source.id, extra: { request_id: q.requestId },
      };
      // A request that moved the card into Request is a transition (the policy names its recipient); a stand-alone one and every answer name their own.
      await add(obligation, an.handledContinuations, !latest && q.movedFrom ? { artifact: q, entity: "task", status: "request" } : undefined);
    }
  }

  for (const { id } of (await client.getAll("/milestones", { project })) as { id: number }[]) {
    const stored = await readMergeReady(client, project, id);
    if (!stored || (await mergeConfirmationProblem(client, project, id)) === null) continue;
    await add({ type: "SPRINT_CLOSED", to: "claude", from: "gpt", entity: "milestone", ref: id, source: stored.record.envelope.claims.authorization_id, extra: { status: "Merge ready; Sprint still open" } }, new Set());
  }
  return { recovered, unresolved };
}
