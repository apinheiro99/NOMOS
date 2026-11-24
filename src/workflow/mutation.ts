import type { TaigaClient } from "../client.js";
import { postUnsignedComment } from "../comment.js";
import { BASE } from "./result.js";
import type { EntityKind } from "./policy.js";

// THE write boundary of the governed workflow. Taiga is the only state: every governed mutation is
//   fresh Taiga read -> validators (separate, all before any write) -> the action's declarative write -> reread and verification.
// Nothing survives the call (no cache, snapshot, webhook or memory), and the verification is a REPORT: a mismatch after the write is returned as
// `integrity`, never retried and never rolled back (status stays authoritative). The boundary runs no business rule of its own: rules are the
// validators and the write callback the caller passes. Only this module (and the Sprint-order owners listed in test/write-boundary.test.ts)
// may use the low-level client writes; the architecture test fails the build for any other workflow module that does.

// The only write capability a governed action receives.
export interface Writer {
  // An artifact comment on a card (the evidence a status write cites). Posted with the card's current version.
  comment(entity: EntityKind, id: number, rendered: string): Promise<void>;
  // PATCH of a card. `version` only when the caller read it on purpose (lost-claim check); otherwise the version is read fresh.
  patch(entity: EntityKind, id: number, body: Record<string, unknown>, version?: number): Promise<unknown>;
  // A new card (the Sprint FINAL review Story and its Task).
  create(entity: EntityKind, body: Record<string, unknown>): Promise<unknown>;
  wikiCreate(body: Record<string, unknown>): Promise<unknown>;
  wikiUpdate(id: number, body: Record<string, unknown>): Promise<unknown>;
}

export function writerFor(client: TaigaClient): Writer {
  return {
    comment: async (entity, id, rendered) => { await postUnsignedComment(client, entity, id, rendered); },
    patch: async (entity, id, body, version) => {
      const v = version ?? ((await client.get(`/${BASE[entity]}/${id}`)) as { version: number }).version;
      return client.patch(`/${BASE[entity]}/${id}`, { ...body, version: v });
    },
    create: (entity, body) => client.post(`/${BASE[entity]}`, body),
    wikiCreate: (body) => client.post("/wiki", body),
    wikiUpdate: (id, body) => client.patch(`/wiki/${id}`, body),
  };
}

// `read` is the AUTHORITATIVE read of the state the mutation concerns (a real Taiga read, never a create/PATCH response or a caller snapshot). The
// boundary itself runs it twice: before the validators and again after the write, and hands the fresh `after` to `verify`. Both phases are
// therefore mandatory and cannot be skipped: `verify` is a required member, so a governed caller that omits it does not compile.
export interface Mutation<S, R> {
  read: () => Promise<S>;
  validators?: ((state: S) => string | null | Promise<string | null>)[];
  write: (before: S, w: Writer) => Promise<R>;
  // The business check of the reread state: null when it holds, otherwise the reason (reported as `integrity`, never retried or rolled back).
  verify: (after: S, result: R, before: S) => string | null | Promise<string | null>;
}
export type Outcome<S, R> = { written: false; problem: string } | { written: true; result: R; after: S; integrity?: string };

export async function mutate<S, R>(client: TaigaClient, m: Mutation<S, R>): Promise<Outcome<S, R>> {
  // Checked BEFORE anything is read or written: a caller that gets past the compiler (any cast) still cannot skip the post-write verification.
  if (typeof m.verify !== "function") throw new Error("mutate requires a verify step: the post-write reread and verification cannot be omitted");
  const before = await m.read();
  for (const validate of m.validators ?? []) {
    const problem = await validate(before);
    if (problem) return { written: false, problem };
  }
  const result = await m.write(before, writerFor(client));
  const after = await m.read();
  const integrity = await m.verify(after, result, before);
  return integrity ? { written: true, result, after, integrity } : { written: true, result, after };
}
