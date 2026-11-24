import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { mutate, writerFor } from "../dist/workflow/mutation.js";
import { storyHasChildTask } from "../dist/workflow/validators.js";

// Task 377 architecture rule: every governed write goes through src/workflow/mutation.ts. No other workflow module may call the low-level client
// writes or the comment writers. Administrative tools under src/tools are not governed workflow and are out of scope on purpose.
const WRITE = /\bclient\.(post|patch|put|delete|postMultipart)\(|\b(postUnsignedComment|postComment)\b/;
const ALLOWED = ["mutation.ts"];
const directWrites = (source: string) => WRITE.test(source) || /\bwriterFor\(/.test(source); // business modules use mutate(), never a raw Writer
// Every mutate() call must carry its post-write verify step (also enforced by the compiler: `verify` is a required member).
const verifyGaps = (source: string) => (source.match(/\bmutate\(/g) ?? []).length - (source.match(/\bverify:/g) ?? []).length;

test("a synthetic module with a direct client write or a comment writer is detected; one using the boundary is not", () => {
  assert.equal(directWrites('await client.patch("/tasks/1", { status: 2 });'), true);
  assert.equal(directWrites('await client.post("/wiki", {});'), true);
  assert.equal(directWrites('await client.delete("/tasks/1");'), true);
  assert.equal(directWrites('import { postUnsignedComment } from "../comment.js";'), true);
  assert.equal(directWrites('await w.patch("task", 1, { status: 2 }); await client.get("/tasks/1");'), false);
});

test("a mutate() call without verify is detected by the scan, and mutate refuses to run without it", async () => {
  assert.equal(verifyGaps("await mutate(client, { read: a, write: b });"), 1);
  assert.equal(verifyGaps("await mutate(client, { read: a, write: b, verify: c });"), 0);
  const calls: string[] = [];
  const client = { get: async () => { calls.push("GET"); return {}; }, patch: async () => { calls.push("PATCH"); return {}; } } as never;
  await assert.rejects(mutate(client, { read: async () => 1, write: async (_s, w) => { await w.patch("task", 1, {}); } } as never), /requires a verify step/);
  assert.deepEqual(calls, [], "refused before any read or write");
});

test("every mutate() call in src/workflow carries its verify step", () => {
  const dir = new URL("../src/workflow/", import.meta.url).pathname;
  const gaps = readdirSync(dir).filter((f) => f.endsWith(".ts") && f !== "mutation.ts" && verifyGaps(readFileSync(dir + f, "utf8")) > 0);
  assert.deepEqual(gaps, []);
});

test("no workflow module outside the boundary writes to Taiga directly", () => {
  const dir = new URL("../src/workflow/", import.meta.url).pathname;
  const offenders = readdirSync(dir).filter((f) => f.endsWith(".ts") && !ALLOWED.includes(f) && directWrites(readFileSync(dir + f, "utf8")));
  assert.deepEqual(offenders, [], "route these writes through mutate()/writerFor() in workflow/mutation.ts");
});

test("mutate rereads AFTER the write and hands that authoritative state to verify (F1)", async () => {
  const order: string[] = [];
  let version = 1;
  const client = { get: async () => ({ version }), patch: async () => { version = 2; order.push("WRITE"); return {}; } } as never;
  const seen: unknown[] = [];
  const out = await mutate(client, {
    read: async () => { order.push("READ"); return { version }; },
    write: async (before, w) => { await w.patch("task", 1, { status: 2 }, before.version); },
    verify: (after, _r, before) => { seen.push([before.version, after.version]); return after.version === 2 ? null : "stale"; },
  });
  assert.deepEqual(order, ["READ", "WRITE", "READ"], "fresh read, write, fresh reread");
  assert.deepEqual(seen, [[1, 2]], "verify sees the state after the write, not the one before");
  assert.deepEqual(out, { written: true, result: undefined, after: { version: 2 } });
});

test("mutate: fresh read -> validators -> write -> verification, and a failed validator writes nothing", async () => {
  const calls: string[] = [];
  const client = { get: async () => ({ version: 7 }), patch: async (path: string, body: unknown) => { calls.push(`PATCH ${path} ${JSON.stringify(body)}`); return {}; } } as never;
  const refused = await mutate(client, { read: async () => 1, validators: [() => "not allowed"], write: async (_s, w) => { await w.patch("task", 1, { status: 2 }); }, verify: () => null });
  assert.deepEqual(refused, { written: false, problem: "not allowed" });
  assert.deepEqual(calls, [], "no write after a validator refusal");
  const ok = await mutate(client, { read: async () => 1, validators: [() => null], write: async (_s, w) => w.patch("task", 1, { status: 2 }), verify: async () => "status read back differs" });
  assert.equal(ok.written, true);
  assert.equal((ok as { integrity?: string }).integrity, "status read back differs", "a verification mismatch is reported, not rolled back");
  assert.deepEqual(calls, ['PATCH /tasks/1 {"status":2,"version":7}'], "the version comes from a fresh read");
});

test("the Writer keeps a caller-supplied version (lost-claim check) and the Story-has-Task validator reads fresh Tasks", async () => {
  const sent: unknown[] = [];
  const client = { get: async () => { throw new Error("must not read when a version is supplied"); }, patch: async (_p: string, b: unknown) => { sent.push(b); return {}; } } as never;
  await writerFor(client).patch("userstory", 3, { status: 9 }, 4);
  assert.deepEqual(sent, [{ status: 9, version: 4 }]);
  assert.match((await storyHasChildTask({ getAll: async () => [] } as never, 3)())!, /at least one child Task/);
  assert.equal(await storyHasChildTask({ getAll: async () => [{ id: 1 }] } as never, 3)(), null);
});
