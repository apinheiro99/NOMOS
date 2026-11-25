import { createHash } from "node:crypto";
import type { TaigaClient } from "../client.js";
import type { PolicyRuntime } from "./runtime.js";

const BASE = { task: "tasks", userstory: "userstories" } as const;
const STALE_MINUTES = 5;

// A journal entry left at `intent` (the process died, or the outcome of the comment write was unknown) is settled from Taiga, never guessed:
//   the exact comment it was about to write is in the history and the card is in the target status -> completed;
//   the comment is there but the card did not move                                                   -> applied (the artifact is persisted, the status is not);
//   the comment is not there                                                                         -> failed (the write did not happen).
// Only entries older than STALE_MINUTES are touched, so a request still running is never settled under its own feet. A Taiga read that fails stops the pass.
export async function reconcileJournal(runtime: PolicyRuntime, client: TaigaClient): Promise<{ completed: number; applied: number; failed: number }> {
  const result = { completed: 0, applied: 0, failed: 0 };
  for (const j of await runtime.staleIntents(STALE_MINUTES)) {
    const [entity, id] = j.target.split(":") as ["task" | "userstory", string];
    const history = (await client.get(`/history/${entity}/${id}`)) as { id?: string; comment?: string; delete_comment_date?: string | null }[];
    const found = history.find((h) => typeof h.comment === "string" && !h.delete_comment_date && createHash("sha256").update(h.comment).digest("hex") === j.ref);
    if (!found) { await runtime.finish(j.id, "failed", { problem: "the comment is not in the history: the write did not happen" }); result.failed += 1; continue; }
    const card = (await client.get(`/${BASE[entity]}/${id}`)) as { status?: number };
    const moved = card.status === j.status;
    await runtime.finish(j.id, moved ? "completed" : "applied", { comment_id: found.id, ...(moved ? {} : { problem: "the artifact is persisted but the status did not change" }) });
    result[moved ? "completed" : "applied"] += 1;
  }
  return result;
}
