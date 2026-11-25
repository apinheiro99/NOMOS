import { createHash } from "node:crypto";
import type { TaigaClient } from "../client.js";
import { signMergeAuthorization, type Signer } from "../workflow/merge-auth.js";
import type { PolicyRuntime } from "./runtime.js";

const BASE = { task: "tasks", userstory: "userstories" } as const;
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

// After a crash between the persisted Done and the signature, each stored obligation is settled from evidence in Taiga, never from the status alone:
//   the exact approval comment it was opened for is in the card's history AND the card is in the approved Done  -> sign once, with the stored id and coordinates;
//   neither the comment nor the Done                                                                              -> the Done never happened: abandoned;
//   anything in between (the approval is there but the card moved on, or Done without our approval)               -> `review`: the outcome cannot be proven, so it is
//   kept and reported, never signed and never silently dropped. Running it twice changes nothing; a Taiga read that fails stops the pass and settles nothing.
export async function recoverMergeObligations(runtime: PolicyRuntime, client: TaigaClient, signer: Signer): Promise<{ signed: number; abandoned: number; review: number }> {
  const result = { signed: 0, abandoned: 0, review: 0 };
  for (const o of await runtime.pendingMergeObligations()) {
    const card = (await client.get(`/${BASE[o.entity]}/${o.taigaId}`)) as { status?: number };
    const history = (await client.get(`/history/${o.entity}/${o.taigaId}`)) as { id?: string; comment?: string }[];
    const approval = history.find((h) => typeof h.comment === "string" && sha256(h.comment) === o.approvalHash);
    const done = card.status === o.doneStatus;
    if (approval && done) {
      await runtime.settleMergeObligation(o.authorizationId, { signed: signMergeAuthorization(signer, o.context, o.taigaProject, o.workItem, o.targetWorkItem, o.authorizationId), approvalCommentId: String(approval.id) });
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
