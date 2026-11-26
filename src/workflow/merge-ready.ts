import type { TaigaClient } from "../client.js";
import { mutate, type Writer } from "./mutation.js";
import { loadGitgateKey, loadSigner, publicKeyB64, receiptProblems, verifyMergeAuthorization, type CompletionReceipt, type MergeEnvelope } from "./merge-auth.js";

// Durable Sprint merge-ready record: the signed sprint-done envelope issued while the Sprint is still open, plus the GitGate-signed completion
// receipt once GitGate reports it. It lives in a Taiga wiki page of the Sprint's project (Taiga stays the only store; the Bridge never holds it).
export interface MergeReadyRecord { envelope: MergeEnvelope; recipient?: "gpt" | "claude" | null; receipt?: CompletionReceipt }
export interface StoredMergeReady { record: MergeReadyRecord; page: { id: number; version: number } }

export const mergeReadySlug = (milestone: number): string => `merge-ready-sprint-${milestone}`;

// null when no record exists (Taiga answers 404); any other failure propagates.
export async function readMergeReady(client: TaigaClient, project: number, milestone: number): Promise<StoredMergeReady | null> {
  let page: { id: number; version: number; content: string };
  try { page = (await client.get("/wiki/by_slug", { slug: mergeReadySlug(milestone), project })) as typeof page; } catch (e) {
    if (/ 404 /.test((e as Error).message)) return null;
    throw e;
  }
  return { record: JSON.parse(page.content) as MergeReadyRecord, page: { id: page.id, version: page.version } };
}

const sameRecord = (a: MergeReadyRecord, b: MergeReadyRecord): boolean => JSON.stringify(a) === JSON.stringify(b);

// Writes, re-reads and proves the stored record equals the intended one; a record that cannot be proven is an error, never a success.
async function writeAndProve(client: TaigaClient, project: number, milestone: number, record: MergeReadyRecord, write: (w: Writer) => Promise<unknown>): Promise<void> {
  const out = await mutate(client, {
    read: () => readMergeReady(client, project, milestone),
    write: (_before, w) => write(w),
    verify: (after) => (after && sameRecord(after.record, record) ? null : `the merge-ready record of Sprint ${milestone} was written but a re-read does not match it`),
  });
  if (out.written && out.integrity) throw new Error(out.integrity);
}

export const createMergeReady = (client: TaigaClient, project: number, milestone: number, record: MergeReadyRecord): Promise<void> =>
  writeAndProve(client, project, milestone, record, (w) => w.wikiCreate({ project, slug: mergeReadySlug(milestone), content: JSON.stringify(record) }));

export async function confirmMergeReady(client: TaigaClient, project: number, milestone: number, stored: StoredMergeReady, receipt: CompletionReceipt): Promise<void> {
  const record: MergeReadyRecord = { envelope: stored.record.envelope, recipient: stored.record.recipient, receipt };
  await writeAndProve(client, project, milestone, record, (w) => w.wikiUpdate(stored.page.id, { content: JSON.stringify(record), version: stored.page.version }));
}

// THE merge-confirmed predicate, reused by every terminal path (Sprint close, final Sprint Task Done): null when the Sprint has a prepared authorization
// that verifies with the Taiga key AND a stored completion receipt that verifies with the separate GitGate key, is bound to that authorization, and
// signs positive removal of the Sprint source branch (local and remote); otherwise the reason. Unsigned or edited records never count, and a
// missing key means nothing can be proven, so it fails closed.
export async function mergeConfirmationProblem(client: TaigaClient, project: number, milestone: number, env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  let taigaKey: string, gitgateKey: string;
  try {
    taigaKey = publicKeyB64(loadSigner(env));
    gitgateKey = loadGitgateKey(env);
  } catch (e) { return `cannot verify the merge confirmation: ${(e as Error).message}`; }
  const stored = await readMergeReady(client, project, milestone);
  if (!stored) return `Sprint ${milestone} has no prepared merge authorization`;
  const { envelope, receipt } = stored.record;
  if (!verifyMergeAuthorization(envelope, taigaKey) || envelope.claims.project !== project || envelope.claims.work_item !== `Sprint #${milestone}`) return `the stored merge authorization of Sprint ${milestone} does not verify`;
  if (!receipt) return `Sprint ${milestone} has no confirmed merge`;
  const bad = receiptProblems(receipt, envelope.claims, gitgateKey);
  if (bad.length) return `the stored GitGate receipt of Sprint ${milestone} does not verify (${bad[0]})`;
  if (!receipt.local_branch_removed || !receipt.remote_branch_removed) return `Sprint ${milestone} is merged but its source branch is not removed yet (local ${receipt.local_branch_removed}, remote ${receipt.remote_branch_removed})`;
  return null;
}

