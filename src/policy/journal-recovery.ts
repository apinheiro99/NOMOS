import type { TaigaClient } from "../client.js";
import type { ActorRole } from "../workflow/actor.js";
import type { EntityKind } from "../workflow/policy.js";
import { BASE } from "../workflow/result.js";
import { expectedOf, findComment, provenTransition, type Entry } from "./proof.js";
import type { PolicyRuntime } from "./runtime.js";

// A journal entry left at `intent` (the process died, or the outcome of the comment write was unknown) is settled from Taiga, never guessed, with the same proof
// the merge recovery uses (see provenTransition), for a Task, a Story or an Epic:
//   the comment is there and the actor's own move to the target status follows it, as the card's last change -> completed (or pending_effect while a merge authorization is owed);
//   the comment is there but that move is not proven                                                         -> applied (the artifact is persisted, the status is not proven);
//   the comment is not there                                                                                -> failed (the write did not happen).
// `minutes` is how old an entry must be: 0 at startup (the process that wrote the entries is gone), a few minutes for the periodic pass, so a request still
// running is never settled under its own feet. A Taiga read that fails stops the pass.
export async function reconcileJournal(runtime: PolicyRuntime, client: TaigaClient, minutes = 5): Promise<{ completed: number; applied: number; failed: number }> {
  const result = { completed: 0, applied: 0, failed: 0 };
  for (const j of await runtime.staleIntents(minutes)) {
    const [entity, id] = j.target.split(":") as [EntityKind, string];
    const history = (await client.get(`/history/${entity}/${id}`)) as Entry[];
    const found = findComment(history, j.ref, j.startedAt);
    if (!found) { await runtime.finish(j.id, "failed", { problem: "the comment is not in the history: the write did not happen" }); result.failed += 1; continue; }
    const card = (await client.get(`/${BASE[entity]}/${id}`)) as { status?: number };
    const expected = j.actor && card.status === j.status ? await expectedOf(client, entity, j.project, j.actor as ActorRole, j.status) : undefined;
    const proven = expected !== undefined && provenTransition(history, j.ref, expected, j.startedAt) !== undefined;
    await runtime.finish(j.id, proven ? "completed" : "applied", { comment_id: found.id, ...(proven ? {} : { problem: "the artifact is persisted but the status change is not proven" }) });
    result[proven ? "completed" : "applied"] += 1;
  }
  return result;
}
