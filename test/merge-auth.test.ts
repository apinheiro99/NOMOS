import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { canonicalClaims, loadSigner, mergeContextProblems, signMergeAuthorization, verifyMergeAuthorization } from "../dist/workflow/merge-auth.js";

const pair = () => { const { privateKey, publicKey } = generateKeyPairSync("ed25519"); return { priv: privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"), pubDer: publicKey.export({ type: "spki", format: "der" }) }; };
const ctx = { repository: "taiga-mcp", source_branch: "feature/task-295-keygen", target_branch: "feature/story-290-x", source_sha: "1".repeat(40), target_sha: "2".repeat(40) };
const TARGET = "Story 0190aaaa-0000-7000-8000-000000000290 (#290)";
const item = { kind: "task", uuid: "0190aaaa-0000-7000-8000-000000000295", ref: 295 };

test("canonical bytes are deterministic and independent of key order", () => {
  const a = { b: "2", a: "1", c: 3 };
  assert.equal(canonicalClaims(a).toString(), '{"a":"1","b":"2","c":3}');
  assert.deepEqual(canonicalClaims({ c: 3, a: "1", b: "2" }), canonicalClaims(a));
});

test("signer key_id is sha256 of the public SPKI DER, matching the keygen contract; the envelope verifies only with that key", () => {
  const p = pair();
  const signer = loadSigner({ TAIGA_MCP_MERGE_AUTH_PRIVATE_KEY_B64: p.priv });
  assert.equal(signer.keyId, createHash("sha256").update(p.pubDer).digest("hex"));
  const env = signMergeAuthorization(signer, ctx, 48, item, TARGET);
  assert.equal(env.claims.work_item, `Task ${item.uuid} (#295)`);
  assert.equal(env.claims.target_work_item, TARGET);
  assert.equal(verifyMergeAuthorization(env, p.pubDer.toString("base64")), true);
  assert.equal(verifyMergeAuthorization(env, pair().pubDer.toString("base64")), false);
  assert.notEqual(env.claims.authorization_id, signMergeAuthorization(signer, ctx, 48, item, TARGET).claims.authorization_id, "each issue is unique");
});

test("loadSigner fails closed and never echoes the value", () => {
  for (const bad of [undefined, "", "%%%", Buffer.from("not der").toString("base64")]) {
    assert.throws(() => loadSigner({ TAIGA_MCP_MERGE_AUTH_PRIVATE_KEY_B64: bad }), (e) => !bad || !String(e.message).includes(bad));
  }
});

test("context validation: exact SHAs, safe branch names, work item ref in the source branch, no extra fields", () => {
  assert.deepEqual(mergeContextProblems(ctx, "task", 295), []);
  assert.match(mergeContextProblems({ ...ctx, source_sha: "ABC" }, "task", 295).join(), /source_sha/);
  assert.match(mergeContextProblems({ ...ctx, target_sha: "a".repeat(39) }, "task", 295).join(), /target_sha/);
  assert.match(mergeContextProblems({ ...ctx, source_branch: "feature/task-296-x" }, "task", 295).join(), /feature\/task-295-/);
  assert.match(mergeContextProblems({ ...ctx, source_branch: "feature/story-295-x" }, "task", 295).join(), /feature\/task-295-/);
  assert.match(mergeContextProblems({ ...ctx, target_branch: "x y" }, "task", 295).join(), /target_branch/);
  assert.match(mergeContextProblems({ ...ctx, extra: "1" }, "task", 295).join(), /extra is not a known field/);
  assert.match(mergeContextProblems(null, "task", 295).join(), /object/);
});
