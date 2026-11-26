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
import { reconcileJournal } from "../dist/policy/journal-recovery.js";
import { loadSigner, signMergeAuthorization, publicKeyB64, verifyMergeAuthorization, type MergeEnvelope } from "../dist/workflow/merge-auth.js";
import { connect, createTestDatabase } from "./support/pg.ts";
import { fakeTaiga } from "./support/taiga-fake.ts";

// F3.4: the authorization owed by a Done is stored before the Done, and a crash after the Done is recovered once, from the stored context.
let db: Awaited<ReturnType<typeof createTestDatabase>>;
let pool: ReturnType<typeof createPool>;
let runtime: ReturnType<typeof createPolicyRuntime>;
let managed: ManagedPolicy;
const signer = loadSigner({ TAIGA_MCP_MERGE_AUTH_PRIVATE_KEY_B64: generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "der" }).toString("base64") });

before(async () => {
  process.env.TAIGA_MCP_EXPECTED_ACCOUNT_GPT = "gpt-account"; // the actor of the obligations below is gpt: its Taiga user (id 1) is who must have written the evidence
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
  await approve(pool, binding, "po", { policyId: v.policyId, expectedRevision: null, hash: v.hash, reason: "seed" }, fakeTaiga("http://taiga.invalid"));
  managed = (await runtime.forProject(49))!;
});
after(async () => { delete process.env.TAIGA_MCP_EXPECTED_ACCOUNT_GPT; delete process.env.TAIGA_MCP_CONTINUATION_FILE; await pool.end(); await db.drop(); });

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
const at = (s: number) => new Date(Date.now() + 60_000 + s * 1000).toISOString(); // after the obligation was opened
const approvalEntry = (taigaId: number, extra = {}) => ({ id: "c9", comment: APPROVAL(taigaId), created_at: at(1), user: { pk: 1 }, ...extra });
const doneEntry = (pk: number | undefined, s: number, to = "Done") => ({ id: "h2", created_at: at(s), user: { pk }, values_diff: { status: ["GPT Validation", to] } });
// Taiga as the recovery reads it: the card, its history, the project's members (gpt-account is user 1) and the name of status 5.
const world = (card: (path: string) => unknown, history: (path: string) => object[]) => ({
  get: async (path: string) => path.startsWith("/history") ? history(path) : path.includes("-statuses/") ? { name: "Done" } : card(path),
  getAll: async () => [{ id: 1, username: "gpt-account", is_active: true }, { id: 2, username: "someone-else", is_active: true }],
}) as never;
const taiga = (status: number, taigaId: number, approved: boolean) => world(() => ({ status }), () => approved ? [approvalEntry(taigaId), doneEntry(1, 2)] : [{ id: "c1", comment: "something else" }]);
const withHistory = (_taigaId: number, history: object[]) => world(() => ({ status: 5 }), () => history);
const stateOf = async (id: string) => (await pool.query("SELECT state, envelope FROM merge_obligation WHERE authorization_id = $1", [id])).rows[0];

test("a crash after the Done: recovery proves the approval and the Done, signs once with the stored id, and a second run changes nothing", async () => {
  const o = await open(101);
  await runtime.openMergeObligation(managed, o); // stored before the Done; then the process dies before signing
  assert.deepEqual(await recoverMergeObligations(runtime, taiga(5, 101, true), signer), { signed: 1, abandoned: 0, review: 0, delivered: 0 });
  const row = await stateOf(o.authorizationId);
  const envelope = row.envelope as MergeEnvelope;
  assert.equal(row.state, "signed");
  assert.equal(envelope.claims.authorization_id, o.authorizationId);
  assert.deepEqual([envelope.claims.source_branch, envelope.claims.work_item, envelope.claims.target_work_item], [o.context.source_branch, "Task #101", "Story #3"]);
  assert.equal(verifyMergeAuthorization(envelope, publicKeyB64(signer)), true);
  assert.deepEqual(await recoverMergeObligations(runtime, taiga(5, 101, true), signer), { signed: 0, abandoned: 0, review: 0, delivered: 0 });
  assert.deepEqual((await stateOf(o.authorizationId)).envelope, envelope);
  const bound = (await pool.query("SELECT activation_id, journal_id, actor, recipient, approval_comment_id FROM merge_obligation WHERE authorization_id = $1", [o.authorizationId])).rows[0];
  assert.deepEqual([bound.activation_id, bound.journal_id, bound.actor, bound.recipient, bound.approval_comment_id], [managed.activationId, o.journalId, "gpt", "claude", "c9"]);
});

test("neither the approval nor the Done in Taiga: the Done never happened and the obligation is abandoned", async () => {
  const o = await open(102);
  await runtime.openMergeObligation(managed, o);
  assert.deepEqual(await recoverMergeObligations(runtime, taiga(2, 102, false), signer), { signed: 0, abandoned: 1, review: 0, delivered: 0 });
  assert.deepEqual([(await stateOf(o.authorizationId)).state, (await stateOf(o.authorizationId)).envelope], ["abandoned", null]);
});

test("an outcome that cannot be proven is kept for review, never signed and never dropped: Done without our approval, and our approval on a card that moved on", async () => {
  const doneBySomeoneElse = await open(105);
  const movedOn = await open(106);
  await runtime.openMergeObligation(managed, doneBySomeoneElse);
  await runtime.openMergeObligation(managed, movedOn);
  const both = world((path) => path.includes("/105") ? { status: 5 } : { status: 2 }, (path) => path.includes("/105") ? [] : [{ id: "c8", comment: APPROVAL(106) }]);
  assert.deepEqual(await recoverMergeObligations(runtime, both, signer), { signed: 0, abandoned: 0, review: 2, delivered: 0 });
  assert.deepEqual([(await stateOf(doneBySomeoneElse.authorizationId)).state, (await stateOf(movedOn.authorizationId)).state], ["review", "review"]);
  assert.deepEqual(await recoverMergeObligations(runtime, taiga(5, 105, true), signer), { signed: 0, abandoned: 0, review: 0, delivered: 0 }, "a review is not decided again by itself");
});

test("a Taiga read that fails stops the pass and settles nothing", async () => {
  const o = await open(107);
  await runtime.openMergeObligation(managed, o);
  await assert.rejects(recoverMergeObligations(runtime, { get: async () => { throw new Error("taiga down"); } } as never, signer), /taiga down/);
  assert.equal((await stateOf(o.authorizationId)).state, "pending");
  assert.deepEqual(await recoverMergeObligations(runtime, taiga(5, 107, true), signer), { signed: 1, abandoned: 0, review: 0, delivered: 0 });
});

test("a settled obligation cannot be settled again, and a Done with no stored obligation is never signed", async () => {
  const o = await open(103);
  await runtime.openMergeObligation(managed, o);
  await runtime.settleMergeObligation(o.authorizationId, { abandoned: true });
  await runtime.settleMergeObligation(o.authorizationId, { signed: {} as MergeEnvelope, approvalCommentId: "x" });
  assert.equal((await stateOf(o.authorizationId)).state, "abandoned");
  assert.deepEqual(await recoverMergeObligations(runtime, taiga(5, 103, true), signer), { signed: 0, abandoned: 0, review: 0, delivered: 0 });
});

test("the same authorization id cannot be opened twice", async () => {
  const o = await open(104);
  await runtime.openMergeObligation(managed, o);
  await assert.rejects(runtime.openMergeObligation(managed, o), /duplicate key/);
});

test("a Done is not proven by an old approval alone: a later manual Done, a Done by someone else, a deleted approval and a re-moved card all go to review", async () => {
  const cases: [number, object[]][] = [
    [110, [approvalEntry(110), doneEntry(1, 2), doneEntry(1, 3)]], // approved, then the card was moved again after it
    [111, [approvalEntry(111), doneEntry(2, 2)]], // the status change after the approval is by a different author
    [112, [approvalEntry(112, { delete_comment_date: at(1) }), doneEntry(1, 2)]], // the approval comment was deleted
    [113, [{ ...approvalEntry(113), created_at: new Date(Date.now() - 3_600_000).toISOString() }, doneEntry(1, 2)]], // older than the obligation
    [114, [approvalEntry(114, { user: undefined }), doneEntry(undefined, 2)]], // both authors absent: absent is not equal to anyone
    [115, [approvalEntry(115, { user: { pk: 2 } }), doneEntry(2, 2)]], // a consistent pair, but not by the actor the obligation was opened for
    [116, [approvalEntry(116), doneEntry(1, 2, "Cancelled")]], // the status change is not the move to Done
    [117, [approvalEntry(117, { edit_comment_date: at(1) }), doneEntry(1, 2)]], // the approval comment was edited
    [118, [doneEntry(1, 2)]], // a manual Done with no approval at all
  ];
  for (const [id, history] of cases) {
    const o = await open(id);
    await runtime.openMergeObligation(managed, o);
    assert.equal((await recoverMergeObligations(runtime, withHistory(id, history), signer)).signed, 0, `case ${id}`);
    assert.equal((await stateOf(o.authorizationId)).state, "review", `case ${id}`);
  }
});

test("a journal entry left at intent is settled from Taiga for a Task and an Epic: completed, applied or failed; a fresh one waits, a restart takes it at once", async () => {
  const mk = async (target: string, text: string) => runtime.begin(managed, "workflow_transition", target, { ref: hash(text), status: 5, actor: "gpt" });
  const [done, half, lost, epic, fresh] = [await mk("task:201", "A"), await mk("task:202", "B"), await mk("task:203", "C"), await mk("epic:205", "E"), await mk("task:204", "D")];
  await pool.query("UPDATE mutation_journal SET updated_at = now() - interval '10 minutes' WHERE id = ANY($1)", [[done, half, lost, epic]]);
  const moved = (text: string, id: string) => [{ id, comment: text, created_at: at(1), user: { pk: 1 } }, doneEntry(1, 2)];
  const world5 = world((path) => ({ status: /\/(201|205)$/.test(path) ? 5 : 2, ref: 1 }), (path) => path.endsWith("/201") ? moved("A", "k1") : path.endsWith("/205") ? moved("E", "k5") : path.endsWith("/202") ? [{ id: "k2", comment: "B", created_at: at(1), user: { pk: 1 } }] : [{ id: "k3", comment: "unrelated" }]);
  assert.deepEqual(await reconcileJournal(runtime, world5), { completed: 2, applied: 1, failed: 1 });
  const phase = async (id: string) => (await pool.query("SELECT phase, result FROM mutation_journal WHERE id = $1", [id])).rows[0];
  assert.deepEqual([(await phase(done)).phase, (await phase(half)).phase, (await phase(lost)).phase, (await phase(epic)).phase, (await phase(fresh)).phase], ["completed", "applied", "failed", "completed", "intent"]);
  assert.equal((await phase(done)).result.comment_id, "k1");
  assert.deepEqual(await reconcileJournal(runtime, world5), { completed: 0, applied: 0, failed: 0 }, "settled entries are not settled again");
  assert.deepEqual(await reconcileJournal(runtime, world5, 0), { completed: 0, applied: 0, failed: 1 }, "at startup the fresh entry is taken too: its comment never reached Taiga");
});

test("a Done that owes its authorization stays pending_effect until the envelope is stored and delivered; a crash in between is finished with the SAME envelope", async () => {
  const phaseOf = async (id: string) => (await pool.query("SELECT phase FROM mutation_journal WHERE id = $1", [id])).rows[0].phase;
  // Crash after the write and before the signature: the journal was finished by the transition, but the obligation is still owed.
  const o = await open(301);
  await runtime.openMergeObligation(managed, o);
  await runtime.finish(o.journalId, "completed", {});
  assert.equal(await phaseOf(o.journalId), "pending_effect", "the entry is not complete while the authorization is owed");
  assert.equal((await recoverMergeObligations(runtime, taiga(5, 301, true), signer)).signed, 1);
  assert.equal(await phaseOf(o.journalId), "completed", "signed and delivered: closed");
  // Crash after the signature and before the delivery was closed: the stored envelope is delivered again, unchanged, and nothing is signed twice.
  const p = await open(302);
  await runtime.openMergeObligation(managed, p);
  await runtime.finish(p.journalId, "completed", {});
  const envelope = signMergeAuthorization(signer, p.context, 49, p.workItem, p.targetWorkItem, p.authorizationId);
  await runtime.settleMergeObligation(p.authorizationId, { signed: envelope, approvalCommentId: "c9" });
  assert.equal(await phaseOf(p.journalId), "pending_effect");
  assert.deepEqual(await recoverMergeObligations(runtime, taiga(5, 302, true), signer), { signed: 0, abandoned: 0, review: 0, delivered: 1 });
  assert.deepEqual((await stateOf(p.authorizationId)).envelope, envelope);
  assert.equal(await phaseOf(p.journalId), "completed");
  assert.equal((await recoverMergeObligations(runtime, taiga(5, 302, true), signer)).delivered, 0, "a closed delivery is not repeated");
  // An abandoned obligation means the Done never happened: its entry fails with it.
  const q = await open(303);
  await runtime.openMergeObligation(managed, q);
  await runtime.finish(q.journalId, "completed", {});
  await recoverMergeObligations(runtime, taiga(2, 303, false), signer);
  assert.equal(await phaseOf(q.journalId), "failed");
});

test("another instance's entries are never touched, and the periodic pass leaves a request still running alone", async () => {
  const young = await open(310);
  await runtime.openMergeObligation(managed, young);
  assert.deepEqual(await recoverMergeObligations(runtime, taiga(2, 310, false), signer, 5), { signed: 0, abandoned: 0, review: 0, delivered: 0 }, "younger than 5 minutes: not settled");
  const other = createPolicyRuntime(pool, "http://another.invalid");
  assert.equal((await other.pendingMergeObligations()).length, 0);
  assert.equal((await other.staleIntents(0)).length, 0);
});
