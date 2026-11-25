import { createHash, createPrivateKey, createPublicKey, randomUUID, sign, verify, type KeyObject } from "node:crypto";

// Post-approval merge authorization: an Ed25519-signed envelope over deterministic claims, issued only AFTER Taiga persisted and
// re-read a Done. Provider-neutral and offline-verifiable. Key material comes only from the environment; nothing is stored or logged.

export const PRIVATE_KEY_ENV = "TAIGA_MCP_MERGE_AUTH_PRIVATE_KEY_B64";
export type MergeAction = "task-done" | "story-done" | "sprint-done";
export interface MergeContext { repository: string; source_branch: string; target_branch: string; source_sha: string; target_sha: string }
// A Sprint (milestone) has no UUID: its identity is the milestone id.
export interface WorkItemIdentity { kind: "task" | "userstory" | "sprint"; uuid?: string; ref: number }
export interface MergeClaims extends MergeContext { issuer: "taiga-mcp"; key_id: string; action: MergeAction; authorization_id: string; project: number; work_item: string; target_work_item: string }
export interface MergeEnvelope { version: 1; claims: MergeClaims; signature: string }
export interface Signer { privateKey: KeyObject; keyId: string }

const SHA = /^[0-9a-f]{40}$/;
const BRANCH = /^(?!.*\.\.)[A-Za-z0-9._/-]{1,200}$/;
const REPOSITORY = /^[A-Za-z0-9._/-]{1,200}$/;
const PREFIX = { "task-done": "task", "story-done": "story", "sprint-done": "sprint" } as const;
const ACTION: Record<WorkItemIdentity["kind"], MergeAction> = { task: "task-done", userstory: "story-done", sprint: "sprint-done" };
const WORD = { task: "Task", userstory: "Story", sprint: "Sprint" } as const;
const workItemOf = (item: WorkItemIdentity): string => (item.uuid ? `${WORD[item.kind]} ${item.uuid} (#${item.ref})` : `${WORD[item.kind]} #${item.ref}`);

const keyIdOf = (publicKey: KeyObject): string => createHash("sha256").update(publicKey.export({ type: "spki", format: "der" })).digest("hex");

// Deterministic bytes: claims are flat string/number fields, keys sorted.
export const canonicalClaims = (claims: MergeClaims): Buffer =>
  Buffer.from(JSON.stringify(Object.fromEntries(Object.entries(claims).sort(([a], [b]) => (a < b ? -1 : 1)))), "utf8");

// Fails closed on a missing, non-Base64, non-PKCS#8 or non-Ed25519 key. Never echoes key material.
export function loadSigner(env: NodeJS.ProcessEnv = process.env): Signer {
  const raw = env[PRIVATE_KEY_ENV];
  if (!raw) throw new Error(`${PRIVATE_KEY_ENV} is not set`);
  let privateKey: KeyObject;
  try { privateKey = createPrivateKey({ key: Buffer.from(raw, "base64"), format: "der", type: "pkcs8" }); } catch { throw new Error(`${PRIVATE_KEY_ENV} is not a valid PKCS#8 DER Base64 private key`); }
  if (privateKey.asymmetricKeyType !== "ed25519") throw new Error(`${PRIVATE_KEY_ENV} is not an Ed25519 key`);
  return { privateKey, keyId: keyIdOf(createPublicKey(privateKey)) };
}

// Caller-supplied claims are only the git coordinates; every identity claim is derived from Taiga. The source branch must carry the work item ref.
export function mergeContextProblems(raw: unknown, kind: WorkItemIdentity["kind"], ref: number): string[] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return ["merge_context must be an object"];
  const c = raw as Record<string, unknown>;
  const problems: string[] = [];
  const keys = ["repository", "source_branch", "target_branch", "source_sha", "target_sha"];
  for (const k of Object.keys(c)) if (!keys.includes(k)) problems.push(`merge_context.${k} is not a known field`);
  const str = (k: string) => (typeof c[k] === "string" ? (c[k] as string) : "");
  if (!REPOSITORY.test(str("repository"))) problems.push("merge_context.repository must be 1-200 chars of letters, digits, . _ / -");
  for (const k of ["source_branch", "target_branch"]) if (!BRANCH.test(str(k))) problems.push(`merge_context.${k} is not a valid branch name`);
  for (const k of ["source_sha", "target_sha"]) if (!SHA.test(str(k))) problems.push(`merge_context.${k} must be a 40-digit lowercase hex SHA`);
  const prefix = `feature/${PREFIX[ACTION[kind]]}-${ref}-`;
  if (BRANCH.test(str("source_branch")) && !str("source_branch").startsWith(prefix)) problems.push(`merge_context.source_branch must start with ${prefix} (the approved work item)`);
  return problems;
}

// `item` and `targetWorkItem` (the parent Story, the Sprint, or for a Sprint its project) are resolved from Taiga by the caller before the Done is written.
export function signMergeAuthorization(signer: Signer, ctx: MergeContext, project: number, item: WorkItemIdentity, targetWorkItem: string): MergeEnvelope {
  const claims: MergeClaims = {
    issuer: "taiga-mcp", key_id: signer.keyId, action: ACTION[item.kind], authorization_id: randomUUID(), project,
    work_item: workItemOf(item), target_work_item: targetWorkItem,
    repository: ctx.repository, source_branch: ctx.source_branch, target_branch: ctx.target_branch, source_sha: ctx.source_sha, target_sha: ctx.target_sha,
  };
  return { version: 1, claims, signature: sign(null, canonicalClaims(claims), signer.privateKey).toString("base64") };
}

// Pure public verification: the envelope must be signed by the given SPKI DER Base64 key and name that key's id. Any tampered claim fails.
export function verifyMergeAuthorization(envelope: MergeEnvelope, publicKeyB64: string): boolean {
  try {
    const publicKey = createPublicKey({ key: Buffer.from(publicKeyB64, "base64"), format: "der", type: "spki" });
    if (publicKey.asymmetricKeyType !== "ed25519" || envelope.version !== 1 || envelope.claims.issuer !== "taiga-mcp" || envelope.claims.key_id !== keyIdOf(publicKey)) return false;
    return verify(null, canonicalClaims(envelope.claims), publicKey, Buffer.from(envelope.signature, "base64"));
  } catch { return false; }
}

// Sprint COMPLETION RECEIPT: produced and Ed25519-signed by GitGate with its OWN key (the GitGate trust root), verified here with the configured
// public key. Taiga MCP never holds the GitGate private key and never signs on its behalf; the Taiga key only authenticates Taiga-owned authorizations.
export const GITGATE_PUBLIC_KEY_ENV = "TAIGA_MCP_GITGATE_PUBLIC_KEY_B64";
export interface CompletionReceipt {
  version: 1; issuer: "gitgate"; key_id: string; authorization_id: string; repository: string; source_branch: string; source_sha: string;
  target_branch: string; target_before_sha: string; final_integration_sha: string; outcome: "merged"; local_branch_removed: boolean; remote_branch_removed: boolean; signature: string;
}
const RECEIPT_FIELDS = ["version", "issuer", "key_id", "authorization_id", "repository", "source_branch", "source_sha", "target_branch", "target_before_sha", "final_integration_sha", "outcome", "local_branch_removed", "remote_branch_removed", "signature"];

// The bytes GitGate signs: every receipt field except `signature`, keys sorted, JSON (the same canonical style as the authorization claims).
export const canonicalReceipt = (r: Omit<CompletionReceipt, "signature">): Buffer =>
  Buffer.from(JSON.stringify(Object.fromEntries(Object.entries(r).sort(([a], [b]) => (a < b ? -1 : 1)))), "utf8");

// Fails closed on a missing, non-Base64, non-SPKI or non-Ed25519 key. Never echoes key material.
export function loadGitgateKey(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env[GITGATE_PUBLIC_KEY_ENV];
  if (!raw) throw new Error(`${GITGATE_PUBLIC_KEY_ENV} is not set`);
  try { if (createPublicKey({ key: Buffer.from(raw, "base64"), format: "der", type: "spki" }).asymmetricKeyType === "ed25519") return raw; } catch { /* reported below */ }
  throw new Error(`${GITGATE_PUBLIC_KEY_ENV} is not a valid SPKI DER Base64 Ed25519 public key`);
}

// Problems that make a receipt unusable for THIS authorization: malformed shape, wrong key or signature, or any binding mismatch. Empty = authentic and bound.
// Cleanliness (both removals true) is a separate question, answered by the terminal predicate.
export function receiptProblems(raw: unknown, claims: MergeClaims, gitgateKey: string): string[] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return ["receipt must be an object"];
  const r = raw as Record<string, unknown>;
  const problems: string[] = [];
  for (const k of Object.keys(r)) if (!RECEIPT_FIELDS.includes(k)) problems.push(`receipt.${k} is not a known field`);
  const str = (k: string) => (typeof r[k] === "string" ? (r[k] as string) : "");
  if (r.version !== 1) problems.push("receipt.version must be 1");
  if (r.issuer !== "gitgate") problems.push("receipt.issuer must be gitgate");
  if (r.outcome !== "merged") problems.push("receipt.outcome must be merged");
  for (const k of ["local_branch_removed", "remote_branch_removed"]) if (typeof r[k] !== "boolean") problems.push(`receipt.${k} must be a boolean`);
  for (const k of ["key_id", "authorization_id", "repository", "source_branch", "target_branch", "signature"]) if (!str(k)) problems.push(`receipt.${k} is required`);
  for (const k of ["source_sha", "target_before_sha", "final_integration_sha"]) if (!SHA.test(str(k))) problems.push(`receipt.${k} must be a 40-digit lowercase hex SHA`);
  if (problems.length) return problems;
  const bound: [string, string][] = [["authorization_id", claims.authorization_id], ["repository", claims.repository], ["source_branch", claims.source_branch], ["source_sha", claims.source_sha], ["target_branch", claims.target_branch], ["target_before_sha", claims.target_sha]];
  for (const [k, expected] of bound) if (r[k] !== expected) problems.push(`receipt.${k} does not match the authorization`);
  try {
    const key = createPublicKey({ key: Buffer.from(gitgateKey, "base64"), format: "der", type: "spki" });
    const { signature, ...signed } = r as unknown as CompletionReceipt;
    if (key.asymmetricKeyType !== "ed25519" || r.key_id !== keyIdOf(key)) problems.push("receipt.key_id is not the configured GitGate key");
    else if (!verify(null, canonicalReceipt(signed), key, Buffer.from(signature, "base64"))) problems.push("receipt signature does not verify with the configured GitGate key");
  } catch { problems.push("receipt signature does not verify with the configured GitGate key"); }
  return problems;
}

// The Taiga signing authority's own public key (SPKI DER Base64), used only to re-verify Taiga-owned authorizations.
export const publicKeyB64 = (signer: Signer): string => createPublicKey(signer.privateKey).export({ type: "spki", format: "der" }).toString("base64");
