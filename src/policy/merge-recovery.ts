import { createHash } from "node:crypto";
import type { TaigaClient } from "../client.js";
import { signMergeAuthorization, type Signer } from "../workflow/merge-auth.js";
import type { PolicyRuntime } from "./runtime.js";

const BASE = { task: "tasks", userstory: "userstories" } as const;
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
type Entry = { id?: string; comment?: string; created_at?: string; delete_comment_date?: string | null; user?: { pk?: number }; values_diff?: { status?: unknown } };
const byTime = (a: Entry, b: Entry) => Date.parse(a.created_at ?? "") - Date.parse(b.created_at ?? "");

// The Done is proven to be THIS approval's by the history sequence: the approval comment is not deleted and is not older than the obligation, and the
// first status change after it is by the same author and is the card's last status change (nobody moved it before or after). A card that merely
// sits in Done, e.g. a manual Done after an old approval, does not prove it.
function provenDone(history: Entry[], approvalHash: string, since: Date): Entry | undefined {
  const entries = history.every((h) => h.created_at) ? [...history].sort(byTime) : history;
  const approval = entries.find((h) => typeof h.comment === "string" && !h.delete_comment_date && sha256(h.comment) === approvalHash);
  if (!approval || (approval.created_at && Date.parse(approval.created_at) < since.getTime())) return undefined;
  const changes = entries.filter((h) => h.values_diff?.status !== undefined);
  const change = changes.find((h) => entries.indexOf(h) > entries.indexOf(approval));
  return change && change === changes.at(-1) && change.user?.pk === approval.user?.pk ? approval : undefined;
}

// After a crash between the persisted Done and the signature, each stored obligation is settled from evidence in Taiga, never from the status alone:
//   the exact approval comment it was opened for is followed, in the card's history, by the approved Done (see provenDone)  -> sign once, with the stored id and coordinates;
//   neither the comment nor the Done                                                                              -> the Done never happened: abandoned;
//   anything in between (the approval is there but the card moved on, or Done without our approval)               -> `review`: the outcome cannot be proven, so it is
//   kept and reported, never signed and never silently dropped. Running it twice changes nothing; a Taiga read that fails stops the pass and settles nothing.
export async function recoverMergeObligations(runtime: PolicyRuntime, client: TaigaClient, signer: Signer): Promise<{ signed: number; abandoned: number; review: number }> {
  const result = { signed: 0, abandoned: 0, review: 0 };
  for (const o of await runtime.pendingMergeObligations()) {
    const card = (await client.get(`/${BASE[o.entity]}/${o.taigaId}`)) as { status?: number };
    const history = (await client.get(`/history/${o.entity}/${o.taigaId}`)) as Entry[];
    const approval = history.find((h) => typeof h.comment === "string" && !h.delete_comment_date && sha256(h.comment) === o.approvalHash);
    const done = card.status === o.doneStatus;
    const proven = done ? provenDone(history, o.approvalHash, o.createdAt) : undefined;
    if (proven) {
      await runtime.settleMergeObligation(o.authorizationId, { signed: signMergeAuthorization(signer, o.context, o.taigaProject, o.workItem, o.targetWorkItem, o.authorizationId), approvalCommentId: String(proven.id) });
      result.signed += 1;
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
