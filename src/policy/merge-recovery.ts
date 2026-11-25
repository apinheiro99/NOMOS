import type { TaigaClient } from "../client.js";
import { signMergeAuthorization, type Signer } from "../workflow/merge-auth.js";
import type { PolicyRuntime } from "./runtime.js";

const BASE = { task: "tasks", userstory: "userstories" } as const;

// After a crash between the persisted Done and the signature: each stored obligation is settled from what Taiga says NOW.
// Status is exactly the approved Done: sign once, with the stored authorization id and coordinates. Anything else: the Done never happened, nothing is owed.
// Only a stored obligation is ever signed; a Done seen without one authorizes nothing. Running it twice changes nothing.
export async function recoverMergeObligations(runtime: PolicyRuntime, client: TaigaClient, signer: Signer): Promise<{ signed: number; abandoned: number }> {
  const result = { signed: 0, abandoned: 0 };
  for (const o of await runtime.pendingMergeObligations()) {
    const row = (await client.get(`/${BASE[o.entity]}/${o.taigaId}`)) as { status?: number };
    if (row.status !== o.doneStatus) {
      await runtime.settleMergeObligation(o.authorizationId, { abandoned: true });
      result.abandoned += 1;
      continue;
    }
    await runtime.settleMergeObligation(o.authorizationId, { signed: signMergeAuthorization(signer, o.context, o.taigaProject, o.workItem, o.targetWorkItem, o.authorizationId) });
    result.signed += 1;
  }
  return result;
}
