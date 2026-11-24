import { TaigaClient } from "../client.js";
import { arrangeSprint } from "./engineering-review.js";

// Post-close queue order: a just-closed (Done or Cancelled) Story sinks to the very end of its Sprint's closed history, and the canonical partition
// (unfinished -> FINAL -> Done history, owned by engineering-review.ts arrangeSprint) is reasserted. sprint_order only, through the Taiga
// client (never the governed tools).
export type QueueReorder = { moved: false; reason: "no_sprint" | "already_in_place" } | { moved: true };

export async function moveClosedStoryToTail(client: TaigaClient, storyId: number): Promise<QueueReorder> {
  const { milestone } = (await client.get(`/userstories/${storyId}`)) as { milestone?: number | null };
  if (milestone == null) return { moved: false, reason: "no_sprint" };
  return (await arrangeSprint(client, milestone, storyId)).moved ? { moved: true } : { moved: false, reason: "already_in_place" };
}
