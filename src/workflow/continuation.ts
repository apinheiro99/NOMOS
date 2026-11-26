import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { emitNotice, type Notice, type NotifyOutcome, type Party } from "./notify.js";

// Durable workflow continuation: "a persisted workflow boundary created work for this actor". Taiga MCP owns it; the Bridge only points at it
// (emitNotice stays best-effort transport, its "sent" is NOT a delivery receipt). A continuation is not authority: the consumer re-reads
// Taiga (taiga_task_workflow_state) before acting. Delivery ack and handled ack are separate; only handled closes the obligation.
// Store: append-only JSONL shared by every MCP process on the machine (O_APPEND lines), folded by id so a duplicate emit is one obligation.

export interface Continuation {
  id: string; type: string; to: Party; from: Party; entity: "task" | "userstory" | "milestone"; ref: number; project?: number;
  source: string; request_id?: string; status?: string; created_at: string;
}
export type ContinuationState = "pending" | "delivered" | "handled";
export interface FoldedContinuation extends Continuation { state: ContinuationState; delivered_at?: string; handled_at?: string }

export const continuationFile = () => process.env.TAIGA_MCP_CONTINUATION_FILE || join(dirname(fileURLToPath(import.meta.url)), "..", "..", "continuations.jsonl");

type Line = ({ op: "emit" } & Continuation) | { op: "delivered" | "handled"; id: string; by: string; at: string };

function lines(file: string): Line[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").flatMap((l) => { try { return l.trim() ? [JSON.parse(l) as Line] : []; } catch { return []; } }); // a torn tail line is skipped
}

export function foldContinuations(file = continuationFile()): Map<string, FoldedContinuation> {
  const out = new Map<string, FoldedContinuation>();
  for (const l of lines(file)) {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- rest-omit: drop op from the folded record
    if (l.op === "emit") { if (!out.has(l.id)) { const { op: _op, ...c } = l; out.set(l.id, { ...c, state: "pending" }); } continue; }
    const c = out.get(l.id);
    if (!c) continue;
    if (l.op === "delivered" && c.state === "pending") { c.state = "delivered"; c.delivered_at = l.at; }
    if (l.op === "handled" && c.state !== "handled") { c.state = "handled"; c.handled_at = l.at; }
  }
  return out;
}

const entityOf = (n: Notice) => (n.sprintId !== undefined ? { entity: "milestone" as const, ref: n.sprintId } : n.storyRef !== undefined ? { entity: "userstory" as const, ref: n.storyRef } : { entity: "task" as const, ref: n.taskRef! });

// Deterministic identity from authoritative facts: the type, the entity and the persisted artifact (or authorization) that created the work.
export function continuationOf(type: string, to: Party, from: Party, entity: Continuation["entity"], ref: number, project: number | undefined, source: string, extra: { request_id?: string; status?: string } = {}): Continuation {
  return { id: `${type}:p${project ?? "-"}:${entity}${ref}:${source}`, type, to, from, entity, ref, ...(project !== undefined ? { project } : {}), source, ...extra, created_at: new Date().toISOString() };
}

// A crash can leave a torn last line with no newline; the next line must not be glued to it (it would be skipped as unreadable too).
function append(file: string, line: Line): void {
  const torn = existsSync(file) && /[^\n]$/.test(readFileSync(file, "utf8"));
  appendFileSync(file, `${torn ? "\n" : ""}${JSON.stringify(line)}\n`);
}

export function recordContinuation(c: Continuation, file = continuationFile()): { id: string; duplicate: boolean } {
  if (foldContinuations(file).has(c.id)) return { id: c.id, duplicate: true };
  append(file, { op: "emit", ...c });
  return { id: c.id, duplicate: false };
}

export const ackProblem = (c: Continuation, byRole: string): string | null =>
  byRole !== c.to && byRole !== "po" ? `continuation ${c.id} is addressed to ${c.to}; only the addressee (or the PO) can acknowledge it` : null;

export type AckResult = { ok: true; state: ContinuationState; already: boolean } | { ok: false; reason: string };
export function ackContinuation(id: string, ack: "delivered" | "handled", by: string, byRole: string, file = continuationFile()): AckResult {
  const c = foldContinuations(file).get(id);
  if (!c) return { ok: false, reason: `no continuation ${id}` };
  const problem = ackProblem(c, byRole);
  if (problem) return { ok: false, reason: problem };
  const rank = { pending: 0, delivered: 1, handled: 2 };
  if (rank[c.state] >= rank[ack]) return { ok: true, state: c.state, already: true };
  append(file, { op: ack, id, by, at: new Date().toISOString() });
  return { ok: true, state: ack, already: false };
}

export function pendingContinuations(actor: Party, project?: number, file = continuationFile()): FoldedContinuation[] {
  return [...foldContinuations(file).values()].filter((c) => c.to === actor && c.state !== "handled" && (project === undefined || c.project === project));
}

// Persist the obligation BEFORE any dispatch, so a failed or offline Bridge cannot erase it; the persisted workflow mutation stays authoritative
// even if recording fails (reported, never thrown). The next actor is the notice's stated recipient.
export async function announce(n: Notice | null, source: string, env: NodeJS.ProcessEnv = process.env, authorization?: unknown): Promise<{ notification: NotifyOutcome; continuation?: { id: string; recorded: boolean } }> {
  let continuation: { id: string; recorded: boolean } | undefined;
  if (n) {
    const e = entityOf(n);
    const c = continuationOf(n.type, n.to, n.from, e.entity, e.ref, n.projectId, source, { request_id: n.requestId, status: n.status });
    try { recordContinuation(c); continuation = { id: c.id, recorded: true }; } catch { continuation = { id: c.id, recorded: false }; }
  }
  return { notification: await emitNotice(n, env, authorization), ...(continuation ? { continuation } : {}) };
}
