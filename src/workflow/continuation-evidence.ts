import { mutate } from "./mutation.js";
import type { TaigaClient } from "../client.js";
import type { ActorRole } from "./actor.js";
import type { Continuation } from "./continuation.js";
import { renderGovernedArtifact } from "./refs.js";
import { analyse, type HistoryItem } from "./state.js";
import { latest, loadTemplates, nameFor } from "./templates.js";

// A handled acknowledgement must survive the loss of the disposable ledger, so it is also written to Taiga: one internal "Continuation Handled"
// comment on the card the continuation is about, naming the exact continuation id and the acknowledging actor. It changes no status and grants
// no authority; recovery reads it (through analyse) and never rebuilds a continuation proven handled. Idempotent: written at most once per id.
const KIND = { task: ["tasks", "task"], userstory: ["userstories", "userstory"] } as const;

export async function recordHandledEvidence(client: TaigaClient, c: Continuation, actor: ActorRole): Promise<{ written: boolean }> {
  if (c.entity === "milestone" || c.project === undefined) return { written: false }; // a Sprint has no card history to hold evidence
  const [collection, kind] = KIND[c.entity];
  const card = (await client.get(`/${collection}/by_ref`, { ref: c.ref, project: c.project })) as { id: number };
  const set = loadTemplates();
  const project = c.project;
  const entity = c.entity; // narrowed above: a card, never a Sprint
  const out = await mutate(client, {
    read: async () => analyse((await client.get(`/history/${kind}/${card.id}`)) as HistoryItem[], set).handledContinuations,
    validators: [(handled) => (handled.has(c.id) ? "already handled" : null)],
    write: async (_handled, w) => {
      const template = latest(set, nameFor("continuation_handled"));
      const rendered = await renderGovernedArtifact(client, project, { template, entity, author: actor, transition: null, artifact: { type: template.type, continuation_id: c.id, continuation_type: c.type } });
      if (!rendered.ok) throw new Error(rendered.problems[0]);
      await w.comment(kind, card.id, rendered.text);
    },
    verify: (handled) => (handled.has(c.id) ? null : "the handled evidence is not in the card history"),
  });
  return { written: out.written };
}
