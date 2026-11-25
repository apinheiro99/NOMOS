import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { migrate } from "../dist/policy/migrate.js";
import { createPool } from "../dist/policy/repository.js";
import { createPolicyRuntime, type ManagedPolicy, type MergeObligation } from "../dist/policy/runtime.js";
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
  db = await createTestDatabase();
  const c = await connect(db.url);
  await migrate(c, fileURLToPath(new URL("../db/migrations", import.meta.url)));
  await c.end();
  pool = createPool(db.url);
  runtime = createPolicyRuntime(pool, "http://taiga.invalid");
  const [instance, binding] = [randomUUID(), randomUUID()];
  await pool.query("INSERT INTO taiga_instance (id, instance_key, base_url) VALUES ($1,'lab','http://taiga.invalid')", [instance]);
  await pool.query("INSERT INTO project_binding (id, instance_id, taiga_project_id, slug, name, lifecycle) VALUES ($1,$2,49,'lab','Lab','managed')", [binding, instance]);
  managed = { projectId: binding, activationId: randomUUID(), revision: 1, policy: {} as never };
});
after(async () => { await pool.end(); await db.drop(); });

const SHA = "a".repeat(40);
const obligation = (taigaId: number): MergeObligation => ({
  authorizationId: randomUUID(), entity: "task", taigaId, doneStatus: 5, taigaProject: 49,
  context: { repository: "taiga-mcp", source_branch: `feature/task-${taigaId}-x`, target_branch: "feature/story-3-y", source_sha: SHA, target_sha: SHA },
  workItem: { kind: "task", ref: taigaId }, targetWorkItem: "Story #3",
});
const taiga = (status: number) => ({ get: async () => ({ status }) }) as never;
const stateOf = async (id: string) => (await pool.query("SELECT state, envelope FROM merge_obligation WHERE authorization_id = $1", [id])).rows[0];

test("a crash after the Done: recovery signs once, with the stored id and coordinates, and a second run changes nothing", async () => {
  const o = obligation(101);
  await runtime.openMergeObligation(managed, o); // stored before the Done; then the process dies before signing
  assert.deepEqual(await recoverMergeObligations(runtime, taiga(5), signer), { signed: 1, abandoned: 0 });
  const row = await stateOf(o.authorizationId);
  const envelope = row.envelope as MergeEnvelope;
  assert.equal(row.state, "signed");
  assert.equal(envelope.claims.authorization_id, o.authorizationId);
  assert.deepEqual([envelope.claims.source_branch, envelope.claims.work_item, envelope.claims.target_work_item], [o.context.source_branch, "Task #101", "Story #3"]);
  assert.equal(verifyMergeAuthorization(envelope, publicKeyB64(signer)), true);
  assert.deepEqual(await recoverMergeObligations(runtime, taiga(5), signer), { signed: 0, abandoned: 0 });
  assert.deepEqual((await stateOf(o.authorizationId)).envelope, envelope);
});

test("a crash before the Done was written: the obligation is abandoned and nothing is signed", async () => {
  const o = obligation(102);
  await runtime.openMergeObligation(managed, o);
  assert.deepEqual(await recoverMergeObligations(runtime, taiga(2), signer), { signed: 0, abandoned: 1 });
  assert.deepEqual([(await stateOf(o.authorizationId)).state, (await stateOf(o.authorizationId)).envelope], ["abandoned", null]);
});

test("a settled obligation cannot be settled again, and a Done with no stored obligation is never signed", async () => {
  const o = obligation(103);
  await runtime.openMergeObligation(managed, o);
  await runtime.settleMergeObligation(o.authorizationId, { abandoned: true });
  await runtime.settleMergeObligation(o.authorizationId, { signed: {} as MergeEnvelope });
  assert.equal((await stateOf(o.authorizationId)).state, "abandoned");
  assert.deepEqual(await recoverMergeObligations(runtime, taiga(5), signer), { signed: 0, abandoned: 0 });
});

test("the same authorization id cannot be opened twice", async () => {
  const o = obligation(104);
  await runtime.openMergeObligation(managed, o);
  await assert.rejects(runtime.openMergeObligation(managed, o), /duplicate key/);
});
