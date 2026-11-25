import type { TaigaClient } from "../client.js";
import { announce } from "../workflow/continuation.js";
import { signMergeAuthorization, type MergeEnvelope, type Signer } from "../workflow/merge-auth.js";
import { noticeForTransition } from "../workflow/notify.js";
import { expectedOf, findComment, provenTransition, type Entry } from "./proof.js";
import type { PendingObligation, PolicyRuntime } from "./runtime.js";

const BASE = { task: "tasks", userstory: "userstories" } as const;

// The same delivery as the transition: the pointer to the other party (with the envelope on its stdin when the notifier is set up for it). The ledger id comes from the approval comment, so a repeat is the same pointer.
async function deliver(runtime: PolicyRuntime, o: PendingObligation, ref: number | undefined, envelope: MergeEnvelope, approvalCommentId: string): Promise<void> {
  await announce(noticeForTransition(o.actor, "gpt validation", "done", ref, "Done", undefined, o.entity, o.taigaProject, o.recipient), approvalCommentId, process.env, envelope);
  await runtime.completeEffect(o.journalId);
}

// After a crash between the persisted Done and the signature, each stored obligation is settled from evidence in Taiga, never from the status alone:
//   the exact approval comment it was opened for, by the registered actor, is followed in the card's history by that actor's move to Done (see provenTransition)  -> sign once, with the stored id and coordinates;
//   neither the comment nor the Done                                                                              -> the Done never happened: abandoned;
//   anything in between (the approval is there but the card moved on, or Done without our approval)               -> `review`: the outcome cannot be proven, so it is
//   kept and reported, never signed and never silently dropped. A signed obligation whose journal entry is still `pending_effect` (the crash came between the signature and the
//   delivery) is delivered again with the SAME stored envelope and then completed. Running it twice changes nothing; a Taiga read that fails stops the pass and settles nothing.
export async function recoverMergeObligations(runtime: PolicyRuntime, client: TaigaClient, signer: Signer, minutes = 0): Promise<{ signed: number; abandoned: number; review: number; delivered: number }> {
  const result = { signed: 0, abandoned: 0, review: 0, delivered: 0 };
  // `minutes`: only obligations older than that are settled (0 at startup; the periodic pass leaves a request still running alone).
  for (const o of await runtime.pendingMergeObligations()) {
    if (Date.now() - o.createdAt.getTime() < minutes * 60_000) continue;
    const card = (await client.get(`/${BASE[o.entity]}/${o.taigaId}`)) as { status?: number; ref?: number };
    if (o.envelope) { await deliver(runtime, o, card.ref, o.envelope, o.approvalCommentId ?? ""); result.delivered += 1; continue; }
    const history = (await client.get(`/history/${o.entity}/${o.taigaId}`)) as Entry[];
    const approval = findComment(history, o.approvalHash);
    const done = card.status === o.doneStatus;
    const expected = done ? await expectedOf(client, o.entity, o.taigaProject, o.actor, o.doneStatus) : undefined;
    const proven = expected ? provenTransition(history, o.approvalHash, expected, o.createdAt) : undefined;
    if (proven) {
      const envelope = signMergeAuthorization(signer, o.context, o.taigaProject, o.workItem, o.targetWorkItem, o.authorizationId);
      await runtime.settleMergeObligation(o.authorizationId, { signed: envelope, approvalCommentId: String(proven.id) });
      result.signed += 1;
      await deliver(runtime, o, card.ref, envelope, String(proven.id));
    } else if (!approval && !done) {
      await runtime.settleMergeObligation(o.authorizationId, { abandoned: true });
      result.abandoned += 1;
    } else {
      await runtime.settleMergeObligation(o.authorizationId, { review: true });
      result.review += 1;
    }
  }
  return result;
}
