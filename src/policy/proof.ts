import { createHash } from "node:crypto";
import type { TaigaClient } from "../client.js";
import { accountOf } from "../workflow/assignment.js";
import type { ActorRole } from "../workflow/actor.js";
import { norm } from "../workflow/policy.js";
import { STATUS_BASE } from "../workflow/result.js";
import type { EntityKind } from "../workflow/policy.js";

// THE proof that a governed transition really happened, read from the card's history. Both recoveries (the mutation journal and the merge
// obligations) settle with it, so what counts as evidence is decided in ONE place. Insufficient evidence is `undefined`, never a guess.
export type Entry = { id?: string; comment?: string; created_at?: string; delete_comment_date?: string | null; edit_comment_date?: string | null; user?: { pk?: number }; values_diff?: { status?: unknown } };
export const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const byTime = (a: Entry, b: Entry) => Date.parse(a.created_at ?? "") - Date.parse(b.created_at ?? "");

// The comment whose text hashes to `ref`: still there (not deleted, not edited since it was written).
export const findComment = (history: Entry[], ref: string, since?: Date): Entry | undefined =>
  history.find((h) => typeof h.comment === "string" && !h.delete_comment_date && !h.edit_comment_date && sha256(h.comment) === ref && (!since || (h.created_at !== undefined && Date.parse(h.created_at) >= since.getTime())));

// The Taiga user and the status name that identify the transition being proven.
export type Expected = { actorPk: number; toStatus: string };

// The transition is proven when: the comment is in the history, written by the actor (a known Taiga user, never an absent one) and not older than `since`;
// the FIRST status change after it is by the same user, moves the card to the expected status, and is the card's last status change (nobody moved it
// before or after). A card that merely sits in the status, e.g. a manual move after an old comment, proves nothing.
export function provenTransition(history: Entry[], ref: string, expected: Expected, since?: Date): Entry | undefined {
  const entries = history.every((h) => h.created_at) ? [...history].sort(byTime) : history;
  const comment = findComment(entries, ref, since);
  if (!comment || comment.user?.pk !== expected.actorPk) return undefined;
  if (since && (!comment.created_at || Date.parse(comment.created_at) < since.getTime())) return undefined;
  const changes = entries.filter((h) => h.values_diff?.status !== undefined);
  const change = changes.find((h) => entries.indexOf(h) > entries.indexOf(comment));
  const to = Array.isArray(change?.values_diff?.status) ? String(change.values_diff.status[1]) : "";
  return change && change === changes.at(-1) && change.user?.pk === expected.actorPk && norm(to) === norm(expected.toStatus) ? comment : undefined;
}

// What the proof is compared with, read from Taiga: the actor's account in the project and the target status name.
export async function expectedOf(client: TaigaClient, entity: EntityKind, project: number, actor: ActorRole, status: number): Promise<Expected | undefined> {
  const account = await accountOf(client, project, actor);
  const target = (await client.get(`/${STATUS_BASE[entity]}/${status}`)) as { name?: string };
  return account.id === undefined || !target.name ? undefined : { actorPk: account.id, toStatus: target.name };
}
