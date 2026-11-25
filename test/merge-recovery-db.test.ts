import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "../dist/policy/migrate.js";
import { createPool } from "../dist/policy/repository.js";
import { createPolicyRuntime, type ManagedPolicy, type MergeObligation } from "../dist/policy/runtime.js";
import { createHash } from "node:crypto";
import { approve, propose } from "../dist/policy/service.js";
import { legacySeed } from "../dist/policy/legacy-seed.js";
import { recoverMergeObligations } from "../dist/policy/merge-recovery.js";
import { loadSigner, publicKeyB64, verifyMergeAuthorization, type MergeEnvelope } from "../dist/workflow/merge-auth.js";
import { connect, createTestDatabase } from "./support/pg.ts";

// F3.4: the authorization owed by a Done is stored before the Done, and a crash after the Done is recovered once, from the stored context.
let db: Awaited<ReturnType<typeof createTestDatabase>>;
let pool: ReturnType<typeof createPool>;
let runtime: ReturnType<typeof createPolicyRuntime>;
let managed: ManagedPolicy;
const signer = loadSigner({ TAIGA_MCP_MERGE_AUTH_PRIVATE_KEY_B64: generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "der" }).toString("base64") });

before(async () => {
  process.env.TAIGA_MCP_CONTINUATION_FILE = join(mkdtempSync(join(tmpdir(), "mr-")), "c.jsonl"); // approval looks at pending continuations: keep the test hermetic
  db = await createTestDatabase();
  const c = await connect(db.url);
  await migrate(c, fileURLToPath(new URL("../db/migrations", import.meta.url)));
  await c.end();
  pool = createPool(db.url);
  runtime = createPolicyRuntime(pool, "http://taiga.invalid");
  const [instance, binding] = [randomUUID(), randomUUID()];
  await pool.query("INSERT INTO taiga_instance (id, instance_key, base_url) VALUES ($1,'lab','http://taiga.invalid')", [instance]);
  await pool.query("INSERT INTO project_binding (id, instance_id, taiga_project_id, slug, name, lifecycle) VALUES ($1,$2,49,'lab','Lab','managed')", [binding, instance]);
  const v = await propose(pool, binding, "gpt", legacySeed());
  await approve(pool, binding, "po", { policyId: v.policyId, expectedRevision: null, hash: v.hash, reason: "seed" });
  managed = (await runtime.forProject(49))!;
});
after(async () => { delete process.env.TAIGA_MCP_CONTINUATION_FILE; await pool.end(); await db.drop(); });

const SHA = "a".repeat(40);
const APPROVAL = (taigaId: number) => `Validation Approval for ${taigaId}`;
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const open = async (taigaId: number): Promise<MergeObligation> => ({ ...obligation(taigaId), journalId: await runtime.begin(managed, "workflow_transition", `task:${taigaId}`) });
const obligation = (taigaId: number) => ({
  authorizationId: randomUUID(), entity: "task", taigaId, doneStatus: 5, taigaProject: 49,
  context: { repository: "taiga-mcp", source_branch: `feature/task-${taigaId}-x`, target_branch: "feature/story-3-y", source_sha: SHA, target_sha: SHA },
  workItem: { kind: "task" as const, ref: taigaId }, targetWorkItem: "Story #3",
  actor: "gpt" as const, recipient: "claude" as const, approvalHash: hash(APPROVAL(taigaId)),
}) as MergeObligation;
// Taiga as the recovery sees it: the card's status and its history (an approval comment may or may not be there).
const taiga = (status: number, taigaId: number, approved: boolean) => ({ get: async (path: string) => path.startsWith("/history") ? (approved ? [{ id: "c9", comment: APPROVAL(taigaId) }] : [{ id: "c1", comment: "something else" }]) : { status } }) as never;
const stateOf = async (id: string) => (await pool.query("SELECT state, envelope FROM merge_obligation WHERE authorization_id = $1", [id])).rows[0];

test("a crash after the Done: recovery proves the approval and the Done, signs once with the stored id, and a second run changes nothing", async () => {
  const o = await open(101);
  await runtime.openMergeObligation(managed, o); // stored before the Done; then the process dies before signing
  assert.deepEqual(await recoverMergeObligations(runtime, taiga(5, 101, true), signer), { signed: 1, abandoned: 0, review: 0 });
  const row = await stateOf(o.authorizationId);
  const envelope = row.envelope as MergeEnvelope;
  assert.equal(row.state, "signed");
  assert.equal(envelope.claims.authorization_id, o.authorizationId);
  assert.deepEqual([envelope.claims.source_branch, envelope.claims.work_item, envelope.claims.target_work_item], [o.context.source_branch, "Task #101", "Story #3"]);
  assert.equal(verifyMergeAuthorization(envelope, publicKeyB64(signer)), true);
  assert.deepEqual(await recoverMergeObligations(runtime, taiga(5, 101, true), signer), { signed: 0, abandoned: 0, review: 0 });
  assert.deepEqual((await stateOf(o.authorizationId)).envelope, envelope);
  const bound = (await pool.query("SELECT activation_id, journal_id, actor, recipient, approval_comment_id FROM merge_obligation WHERE authorization_id = $1", [o.authorizationId])).rows[0];
  assert.deepEqual([bound.activation_id, bound.journal_id, bound.actor, bound.recipient, bound.approval_comment_id], [managed.activationId, o.journalId, "gpt", "claude", "c9"]);
});

test("neither the approval nor the Done in Taiga: the Done never happened and the obligation is abandoned", async () => {
  const o = await open(102);
  await runtime.openMergeObligation(managed, o);
  assert.deepEqual(await recoverMergeObligations(runtime, taiga(2, 102, false), signer), { signed: 0, abandoned: 1, review: 0 });
  assert.deepEqual([(await stateOf(o.authorizationId)).state, (await stateOf(o.authorizationId)).envelope], ["abandoned", null]);
});

test("an outcome that cannot be proven is kept for review, never signed and never dropped: Done without our approval, and our approval on a card that moved on", async () => {
  const doneBySomeoneElse = await open(105);
  const movedOn = await open(106);
  await runtime.openMergeObligation(managed, doneBySomeoneElse);
  await runtime.openMergeObligation(managed, movedOn);
  const world = { get: async (path: string) => path.includes("/105") ? (path.startsWith("/history") ? [] : { status: 5 }) : (path.startsWith("/history") ? [{ id: "c8", comment: APPROVAL(106) }] : { status: 2 }) } as never;
  assert.deepEqual(await recoverMergeObligations(runtime, world, signer), { signed: 0, abandoned: 0, review: 2 });
  assert.deepEqual([(await stateOf(doneBySomeoneElse.authorizationId)).state, (await stateOf(movedOn.authorizationId)).state], ["review", "review"]);
  assert.deepEqual(await recoverMergeObligations(runtime, taiga(5, 105, true), signer), { signed: 0, abandoned: 0, review: 0 }, "a review is not decided again by itself");
});

test("a Taiga read that fails stops the pass and settles nothing", async () => {
  const o = await open(107);
  await runtime.openMergeObligation(managed, o);
  await assert.rejects(recoverMergeObligations(runtime, { get: async () => { throw new Error("taiga down"); } } as never, signer), /taiga down/);
  assert.equal((await stateOf(o.authorizationId)).state, "pending");
  assert.deepEqual(await recoverMergeObligations(runtime, taiga(5, 107, true), signer), { signed: 1, abandoned: 0, review: 0 });
});

test("a settled obligation cannot be settled again, and a Done with no stored obligation is never signed", async () => {
  const o = await open(103);
  await runtime.openMergeObligation(managed, o);
  await runtime.settleMergeObligation(o.authorizationId, { abandoned: true });
  await runtime.settleMergeObligation(o.authorizationId, { signed: {} as MergeEnvelope, approvalCommentId: "x" });
  assert.equal((await stateOf(o.authorizationId)).state, "abandoned");
  assert.deepEqual(await recoverMergeObligations(runtime, taiga(5, 103, true), signer), { signed: 0, abandoned: 0, review: 0 });
});

test("the same authorization id cannot be opened twice", async () => {
  const o = await open(104);
  await runtime.openMergeObligation(managed, o);
  await assert.rejects(runtime.openMergeObligation(managed, o), /duplicate key/);
});
