import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { TaigaClient } from "../dist/client.js";
import { registerMilestoneTools } from "../dist/tools/milestones.js";
import { actorFor } from "../dist/workflow/actor.js";
import { authorizationTravels, AUTH_STDIN_ENV } from "../dist/workflow/notify.js";
import { reconcileContinuations } from "../dist/workflow/continuation-recovery.js";
import { foldContinuations } from "../dist/workflow/continuation.js";
import { verifyMergeAuthorization, canonicalReceipt, PRIVATE_KEY_ENV, GITGATE_PUBLIC_KEY_ENV } from "../dist/workflow/merge-auth.js";
import { generateKeyPairSync, createHash, createPublicKey, sign, type KeyObject } from "node:crypto";

// Issue #246 + Task 305: a Sprint closes through ONE governed door (taiga_milestones_close). A real open -> closed transition emits exactly one
// SPRINT_CLOSED pointer carrying the signed sprint-done authorization, decided by the stored state before the write and the re-read state after it.
// The generic update refuses closed:true. Mock data and a throwaway key only.
const realFetch = globalThis.fetch;
const env = { TAIGA_URL: "http://taiga.invalid", TAIGA_USERNAME: "u", TAIGA_PASSWORD: "p" };
const saved: Record<string, string | undefined> = {};
let pub: string;
let sprint: { id: number; project: number; closed: boolean }, failPatch: boolean, failReread: boolean, patched: boolean, dir: string;
let gitgate: { privateKey: KeyObject; keyId: string };
let wiki: { id: number; version: number; content: string } | null, wikiWrites: number;
let statuses: { id: number; name: string }[], stories: { id: number; ref: number; status: number }[];

beforeEach(() => {
  for (const k of Object.keys(env)) { saved[k] = process.env[k]; process.env[k] = (env as Record<string, string>)[k]; }
  dir = mkdtempSync(join(tmpdir(), "ms-"));
  process.env.TAIGA_MCP_CONTINUATION_FILE = join(dir, "continuations.jsonl");
  const pair = generateKeyPairSync("ed25519");
  pub = pair.publicKey.export({ type: "spki", format: "der" }).toString("base64");
  process.env[PRIVATE_KEY_ENV] = pair.privateKey.export({ type: "pkcs8", format: "der" }).toString("base64");
  gitgate = newGitgate(); process.env[GITGATE_PUBLIC_KEY_ENV] = gitgate.pub;
  statuses = [[10, "Ready"], [11, "In Progress"], [12, "GPT Validation"], [13, "Done"], [14, "Human Decision"], [15, "Cancelled"]].map(([id, name]) => ({ id, name }));
  stories = [{ id: 1, ref: 1, status: 13 }, { id: 2, ref: 2, status: 13 }];
  sprint = { id: 179, project: 48, closed: false }; failPatch = false; failReread = false; patched = false; wiki = null; wikiWrites = 0;
  globalThis.fetch = (async (url: string, init: { method?: string; body?: string } = {}) => {
    if (String(url).endsWith("/auth")) return new Response(JSON.stringify({ auth_token: "t", refresh: "r" }), { status: 200 });
    const method = init.method ?? "GET";
    if (String(url).includes("/wiki")) {
      if (method === "GET") return wiki ? new Response(JSON.stringify(wiki), { status: 200 }) : new Response("{}", { status: 404 });
      wikiWrites++;
      const body = JSON.parse(init.body!);
      wiki = { id: 9, version: (wiki?.version ?? 0) + 1, content: body.content };
      return new Response(JSON.stringify(wiki), { status: 200 });
    }
    if (method === "PATCH") {
      if (failPatch) return new Response("{}", { status: 500 });
      patched = true;
      Object.assign(sprint, JSON.parse(init.body!));
      return new Response(JSON.stringify(sprint), { status: 200 });
    }
    if (patched && failReread) return new Response("{}", { status: 500 });
    const path = new URL(String(url)).pathname.replace("/api/v1", "");
    if (path === "/task-statuses") return new Response(JSON.stringify(["To Do", "In Progress", "GPT Validation", "Human Decision", "Done", "Cancelled", "Request"].map((name, i) => ({ id: i + 1, name }))), { status: 200 });
    if (path === "/milestones") return new Response(JSON.stringify([sprint]), { status: 200 });
    if (path === "/tasks" || path.startsWith("/history/")) return new Response("[]", { status: 200 });
    if (String(url).includes("/userstory-statuses")) return new Response(JSON.stringify(statuses), { status: 200 });
    if (String(url).includes("/userstories")) return new Response(JSON.stringify(stories), { status: 200 });
    return new Response(JSON.stringify(sprint), { status: 200 });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch; delete process.env.TAIGA_MCP_NOTIFY_COMMAND; delete process.env.TAIGA_MCP_CONTINUATION_FILE; delete process.env[PRIVATE_KEY_ENV]; delete process.env[AUTH_STDIN_ENV]; delete process.env[GITGATE_PUBLIC_KEY_ENV]; rmSync(dir, { recursive: true, force: true });
  for (const k of Object.keys(env)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

// The GitGate trust root is a key pair the Taiga MCP never holds: the tests play GitGate and sign receipts with its private half.
function newGitgate() {
  const pair = generateKeyPairSync("ed25519");
  const der = pair.publicKey.export({ type: "spki", format: "der" });
  return { privateKey: pair.privateKey, pub: der.toString("base64"), keyId: createHash("sha256").update(der).digest("hex") };
}
const CTX = { repository: "taiga-mcp", source_branch: "feature/sprint-179-x", target_branch: "main", source_sha: "1".repeat(40), target_sha: "2".repeat(40) };
// The stub notifier records argv (one line per call) and stdin (one JSON per call), like the real ctl.ts notify would receive them.
function notifier(exitCode = 0) {
  const log = join(dir, "notify.log"), inLog = join(dir, "stdin.log"), script = join(dir, "notify.ts");
  writeFileSync(script, `import { appendFileSync, readFileSync } from "node:fs"; appendFileSync(${JSON.stringify(log)}, process.argv.slice(3).join(" ") + "\\n"); appendFileSync(${JSON.stringify(inLog)}, readFileSync(0, "utf8") + "\\n"); process.exit(${exitCode});`);
  process.env.TAIGA_MCP_NOTIFY_COMMAND = JSON.stringify([process.execPath, script, "notify"]);
  const lines = (f: string) => { try { return readFileSync(f, "utf8").split("\n").filter(Boolean); } catch { return []; } };
  const sent = () => lines(log); sent.stdin = () => lines(inLog);
  return sent;
}
async function call(tool: "taiga_milestones_update" | "taiga_milestones_prepare_close" | "taiga_milestones_confirm_merge" | "taiga_milestones_close", args: Record<string, unknown>, role: "gpt" | "claude" | "po" = "gpt") {
  const reg: Record<string, { schema: z.ZodRawShape; handler: (a: unknown, e: unknown) => Promise<{ content: { text: string }[] }> }> = {};
  const server = { tool: (name: string, _d: string, schema: z.ZodRawShape, handler: never) => { reg[name] = { schema, handler }; } };
  registerMilestoneTools(server as never, new TaigaClient(), { mode: "authenticated", actor: actorFor(role) });
  const t = reg[tool];
  return JSON.parse((await t.handler(z.object(t.schema).parse({ id: 179, ...args }), {})).content[0].text);
}

const RECEIPT = (auth: { claims: { authorization_id: string } }, over: Record<string, unknown> = {}, signer = gitgate) => {
  const fields = {
    version: 1, issuer: "gitgate", key_id: signer.keyId, authorization_id: auth.claims.authorization_id, repository: CTX.repository, source_branch: CTX.source_branch, source_sha: CTX.source_sha,
    target_branch: CTX.target_branch, target_before_sha: CTX.target_sha, final_integration_sha: "3".repeat(40), outcome: "merged", local_branch_removed: true, remote_branch_removed: true, ...over,
  };
  return { ...fields, signature: sign(null, canonicalReceipt(fields as never), signer.privateKey).toString("base64") };
};
const prepare = (role: "gpt" | "claude" | "po" = "gpt", merge_context: unknown = CTX) => call("taiga_milestones_prepare_close", { merge_context }, role);
const confirm = (receipt: unknown, role: "gpt" | "claude" | "po" = "claude") => call("taiga_milestones_confirm_merge", { receipt }, role);
const close = (role: "gpt" | "claude" | "po" = "gpt") => call("taiga_milestones_close", {}, role);

const rebuild = async () => {
  rmSync(process.env.TAIGA_MCP_CONTINUATION_FILE!, { force: true });
  const out = await reconcileContinuations(new TaigaClient(), 48);
  return { out, found: [...foldContinuations().values()] };
};

test("recovery: a lost SPRINT_CLOSED is rebuilt with the authorization id until the merge is confirmed; a closed Sprint alone creates nothing", async () => {
  sprint.closed = true;
  assert.deepEqual((await rebuild()).found, [], "closed without a merge-ready record owes nothing");
  sprint.closed = false;
  const prepared = await prepare();
  const original = foldContinuations().get(prepared.continuation.id)!;
  const { out, found } = await rebuild();
  assert.equal(out.recovered, 1);
  assert.deepEqual(found.map((c) => [c.id, c.type, c.entity, c.ref, c.project, c.to, c.from, c.source]), [[original.id, "SPRINT_CLOSED", "milestone", 179, 48, "claude", "gpt", prepared.merge_authorization.claims.authorization_id]]);
  sprint.closed = true; // closed by hand: the merge is still not confirmed
  assert.equal((await rebuild()).found.length, 1);
  sprint.closed = false;
  await confirm(RECEIPT(prepared.merge_authorization, { remote_branch_removed: false }));
  assert.equal((await rebuild()).found.length, 1, "the source branch is not removed yet");
  await confirm(RECEIPT(prepared.merge_authorization));
  assert.deepEqual((await rebuild()).found, [], "the verified GitGate receipt proves it handled");
});

test("prepare leaves the Sprint OPEN, signs before any terminal write, stores the record and emits ONE merge pointer; the envelope verifies offline", async () => {
  const sent = notifier();
  const r = await prepare();
  assert.equal(sprint.closed, false, "no closed=true write"); assert.equal(patched, false);
  assert.equal(r.merge_ready, true); assert.equal(r.closed, false); assert.equal(r.notification, "sent");
  assert.deepEqual(sent(), ["--type SPRINT_CLOSED --sprint 179 --project 48 --from gpt --to claude --status Merge ready; Sprint still open"]);
  const c = r.merge_authorization.claims;
  assert.deepEqual([c.action, c.work_item, c.target_work_item, c.project, c.source_branch, c.target_branch], ["sprint-done", "Sprint #179", "Project #48", 48, "feature/sprint-179-x", "main"]);
  assert.equal(verifyMergeAuthorization(r.merge_authorization, pub), true);
  assert.equal(JSON.parse(wiki!.content).envelope.claims.authorization_id, c.authorization_id, "durable record keyed to the authorization");
  assert.equal(r.merge_authorization_handoff, "not_attempted", "stdin handoff is opt-in");
});

test("with the opt-in the envelope travels on stdin only, as {authorization}, and never on argv", async () => {
  process.env[AUTH_STDIN_ENV] = "1";
  const sent = notifier();
  const r = await prepare();
  assert.equal(r.merge_authorization_handoff, "attempted_unconfirmed");
  assert.deepEqual(JSON.parse(sent.stdin()[0]), { authorization: r.merge_authorization });
  assert.ok(!sent().join("").includes(r.merge_authorization.signature));
});

test("authorizationTravels: TASK_DONE, STORY_DONE and SPRINT_CLOSED only, and only with the opt-in", () => {
  const on = { [AUTH_STDIN_ENV]: "1" };
  for (const type of ["TASK_DONE", "STORY_DONE", "SPRINT_CLOSED"]) {
    assert.equal(authorizationTravels({ type, from: "gpt" } as never, {}, on), true, type);
    assert.equal(authorizationTravels({ type, from: "gpt" } as never, {}, {}), false, `${type} without opt-in`);
  }
  assert.equal(authorizationTravels({ type: "TASK_RELEASED", from: "gpt" } as never, {}, on), false);
  assert.equal(authorizationTravels(null, {}, on), false);
});

test("close is refused until a valid GitGate receipt exists; after it, close succeeds without a new authorization or pointer", async () => {
  const sent = notifier();
  assert.match((await close()).message, /no prepared merge authorization/, "never prepared");
  const r = await prepare();
  const afterPrepare = sent().length;
  assert.match((await close()).message, /no confirmed merge/, "prepared but unconfirmed");
  assert.equal(patched, false); assert.equal(sprint.closed, false);
  const ok = await confirm(RECEIPT(r.merge_authorization));
  assert.equal(ok.merge_confirmed, true); assert.equal(ok.idempotent, false); assert.equal(ok.terminal_ready, true); assert.equal(ok.closed, false);
  assert.equal(sprint.closed, false, "confirming does not close");
  const done = await close();
  assert.equal(sprint.closed, true); assert.equal(done.merge_confirmed.final_integration_sha, "3".repeat(40));
  assert.equal(done.merge_confirmed.authorization_id, r.merge_authorization.claims.authorization_id);
  assert.equal(sent().length, afterPrepare, "close emits nothing and issues no new authorization");
});

test("receipt binding: any wrong authorization/repository/branch/SHA fails closed and writes nothing", async () => {
  const r = await prepare();
  const writes = wikiWrites;
  for (const over of [{ authorization_id: "other" }, { repository: "x" }, { source_branch: "feature/sprint-179-y" }, { source_sha: "9".repeat(40) }, { target_branch: "develop" }, { target_before_sha: "9".repeat(40) }, { final_integration_sha: "nothex" }]) {
    assert.equal((await confirm(RECEIPT(r.merge_authorization, over))).code, "REFUSED", JSON.stringify(over));
  }
  assert.equal(wikiWrites, writes);
  assert.equal(JSON.parse(wiki!.content).receipt, undefined);
});

test("caller-asserted facts are not evidence: unsigned, plain-boolean, wrong-key and tampered receipts are refused", async () => {
  const r = await prepare();
  const good = RECEIPT(r.merge_authorization);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- rest-omit
  const { signature, ...unsigned } = good;
  const other = newGitgate();
  const cases: [string, unknown][] = [
    ["unsigned", unsigned], ["signature removed", { ...good, signature: "" }], ["plain booleans only", { local_branch_removed: true, remote_branch_removed: true }],
    ["signed by the Taiga-style wrong key", RECEIPT(r.merge_authorization, {}, other)], ["field edited after signing", { ...good, final_integration_sha: "4".repeat(40) }],
    ["cleanup flag flipped after signing", { ...good, remote_branch_removed: false }], ["extra field", { ...good, note: "x" }], ["missing cleanup field", (() => { // eslint-disable-next-line @typescript-eslint/no-unused-vars -- rest-omit
      const { remote_branch_removed, ...rest } = good; return rest; })()],
  ];
  for (const [name, receipt] of cases) assert.equal((await confirm(receipt)).code, "REFUSED", name);
  assert.equal(wikiWrites, 1, "only the prepare record was written");
});

test("a missing or invalid GitGate public key fails closed everywhere", async () => {
  const r = await prepare();
  const receipt = RECEIPT(r.merge_authorization);
  delete process.env[GITGATE_PUBLIC_KEY_ENV];
  assert.match((await confirm(receipt)).message, /cannot verify the receipt: .*is not set/);
  process.env[GITGATE_PUBLIC_KEY_ENV] = "bm90IGEga2V5";
  assert.match((await confirm(receipt)).message, /not a valid SPKI DER Base64 Ed25519 public key/);
  process.env[GITGATE_PUBLIC_KEY_ENV] = gitgate.pub;
  await confirm(receipt);
  delete process.env[GITGATE_PUBLIC_KEY_ENV];
  assert.match((await close()).message, /cannot verify the merge confirmation/);
  assert.equal(sprint.closed, false);
});

test("the Taiga key can never stand in for GitGate: a receipt signed by the Taiga MCP key is refused", async () => {
  const r = await prepare();
  const taiga = { privateKey: (await import("node:crypto")).createPrivateKey({ key: Buffer.from(process.env[PRIVATE_KEY_ENV]!, "base64"), format: "der", type: "pkcs8" }), keyId: "", pub: "" };
  taiga.keyId = createHash("sha256").update(createPublicKey(taiga.privateKey).export({ type: "spki", format: "der" })).digest("hex");
  assert.match((await confirm(RECEIPT(r.merge_authorization, {}, taiga))).message, /not the configured GitGate key/);
});

test("an exact repeated receipt is idempotent; a conflicting second receipt is refused", async () => {
  const r = await prepare();
  await confirm(RECEIPT(r.merge_authorization));
  const writes = wikiWrites;
  const again = await confirm(RECEIPT(r.merge_authorization), "gpt");
  assert.equal(again.merge_confirmed, true); assert.equal(again.idempotent, true);
  assert.equal(wikiWrites, writes, "no second write");
  assert.match((await confirm(RECEIPT(r.merge_authorization, { final_integration_sha: "4".repeat(40) }))).message, /different final_integration_sha/);
});

test("confirmation needs a prepared Sprint", async () => {
  assert.match((await confirm(RECEIPT({ claims: { authorization_id: "a" } }))).message, /no prepared merge authorization/);
});

test("merged but branch not removed stays non-terminal; cleanup is added by a newer signed receipt and never withdrawn", async () => {
  const r = await prepare();
  const partial = await confirm(RECEIPT(r.merge_authorization, { local_branch_removed: true, remote_branch_removed: false }));
  assert.equal(partial.merge_confirmed, true); assert.equal(partial.terminal_ready, false);
  assert.match((await close()).message, /source branch is not removed yet \(local true, remote false\)/);
  assert.equal(sprint.closed, false); assert.equal(patched, false);
  const up = await confirm(RECEIPT(r.merge_authorization));
  assert.equal(up.idempotent, false); assert.equal(up.terminal_ready, true);
  assert.match((await confirm(RECEIPT(r.merge_authorization, { remote_branch_removed: false }))).message, /cannot be withdrawn/);
  await close();
  assert.equal(sprint.closed, true);
});

test("the stored receipt is tamper-evident: edited, signature-stripped or flag-flipped records never close the Sprint", async () => {
  const r = await prepare();
  await confirm(RECEIPT(r.merge_authorization));
  const good = wiki!.content;
  const variants: Record<string, (rec: { receipt: Record<string, unknown> }) => void> = {
    "edited sha": (rec) => { rec.receipt.final_integration_sha = "4".repeat(40); },
    "cleanup flag edited": (rec) => { rec.receipt.remote_branch_removed = false; },
    "signature removed": (rec) => { delete rec.receipt.signature; },
    "plain booleans": (rec) => { rec.receipt = { local_branch_removed: true, remote_branch_removed: true }; },
  };
  for (const [name, edit] of Object.entries(variants)) {
    const rec = JSON.parse(good); edit(rec); wiki!.content = JSON.stringify(rec);
    assert.match((await close()).message, /does not verify|not removed/, name);
  }
  assert.equal(patched, false); assert.equal(sprint.closed, false);
  wiki!.content = good;
  await close();
  assert.equal(sprint.closed, true, "the untouched record still closes");
});

test("an edited authorization in the stored record fails closed", async () => {
  const r = await prepare();
  await confirm(RECEIPT(r.merge_authorization));
  const rec = JSON.parse(wiki!.content); rec.envelope.claims.target_branch = "develop"; wiki!.content = JSON.stringify(rec);
  assert.match((await close()).message, /authorization of Sprint 179 does not verify/);
});

test("generic update with closed:true is refused before any write; other edits still work", async () => {
  const sent = notifier();
  const r = await call("taiga_milestones_update", { closed: true });
  assert.equal(r.code, "REFUSED"); assert.match(r.message, /taiga_milestones_close/);
  assert.equal(patched, false); assert.equal(sprint.closed, false);
  assert.equal((await call("taiga_milestones_update", { name: "n" })).name, "n", "an ordinary edit still goes through");
  assert.equal(patched, true);
  assert.equal((await call("taiga_milestones_update", { closed: false })).closed, false, "closed:false stays a plain edit");
  assert.deepEqual(sent(), []);
});

test("prepare refusals happen before any write: wrong role, missing key, bad context, already closed, already prepared", async () => {
  const sent = notifier();
  assert.match((await prepare("claude")).message, /only the GPT or the PO/);
  delete process.env[PRIVATE_KEY_ENV];
  assert.match((await prepare()).message, /cannot issue a merge authorization/);
  const key = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "der" }).toString("base64");
  process.env[PRIVATE_KEY_ENV] = key;
  assert.match((await prepare("gpt", { ...CTX, source_branch: "feature/sprint-180-x" })).message, /feature\/sprint-179-/);
  sprint.closed = true;
  assert.match((await prepare()).message, /not an open Sprint/);
  assert.match((await close()).message, /already closed but its merge provenance is not proven/, "a closed Sprint without verified evidence is never accepted");
  sprint.closed = false;
  assert.equal(wikiWrites, 0); assert.equal(patched, false);
  assert.deepEqual(sent(), []);
  await prepare();
  assert.match((await prepare()).message, /already prepared/, "a second authorization is never issued");
  assert.equal(wikiWrites, 1);
  assert.ok(![JSON.stringify(await prepare())].some((t) => t.includes(key)), "the key is never echoed");
});

test("the PO prepares and gets the envelope but no Bridge pointer (not a Bridge party)", async () => {
  const sent = notifier();
  const r = await prepare("po");
  assert.equal(sprint.closed, false); assert.equal(r.notification, "skipped");
  assert.equal(verifyMergeAuthorization(r.merge_authorization, pub), true);
  assert.deepEqual(sent(), []);
});

test("a failing notifier keeps the Sprint open and the record stored; a failed close PATCH leaves it open", async () => {
  notifier(1);
  const r = await prepare();
  assert.equal(r.notification, "failed"); assert.equal(sprint.closed, false);
  assert.ok(r.merge_authorization, "the envelope stays in the result for recovery");
  await confirm(RECEIPT(r.merge_authorization));
  failPatch = true;
  await assert.rejects(close());
  assert.equal(sprint.closed, false);
  failPatch = false; failReread = true;
  const r2 = await close();
  assert.equal(r2.code, "PERSISTED_OR_UNKNOWN"); assert.equal(r2.reconcilable, true);
});

// Issue #343 / Task 345: ambiguous post-PATCH outcome is reconcilable and a retry converges without a second write.
test("PATCH ok + failed re-read is reconcilable; the retry converges to success with no second PATCH, write or notice", async () => {
  const sent = notifier();
  const p = await prepare(); await confirm(RECEIPT(p.merge_authorization));
  const notices = sent().length, writes = wikiWrites;
  failReread = true;
  const amb = await close();
  assert.equal(amb.code, "PERSISTED_OR_UNKNOWN"); assert.equal(amb.reconcilable, true); assert.equal(sprint.closed, true);
  failReread = false; patched = false;
  const again = await close();
  assert.equal(again.idempotent, true); assert.equal(again.merge_confirmed.outcome, "merged");
  assert.equal(patched, false, "no second PATCH"); assert.equal(sent().length, notices); assert.equal(wikiWrites, writes);
});

test("a normal close is not marked idempotent; already-closed with valid evidence succeeds, with tampered or missing evidence fails closed", async () => {
  notifier();
  const p = await prepare(); await confirm(RECEIPT(p.merge_authorization));
  assert.equal((await close()).idempotent, undefined);
  patched = false;
  assert.equal((await close()).idempotent, true); assert.equal(patched, false);
  const good = wiki!.content;
  const rec = JSON.parse(good); rec.receipt.local_branch_removed = false; wiki!.content = JSON.stringify(rec);
  assert.match((await close()).message, /already closed but its merge provenance is not proven/);
  wiki = null;
  assert.match((await close()).message, /no prepared merge authorization/);
  assert.equal(patched, false);
});

// Issue #300 / Task 344: a Sprint is authorized and closed only when EVERY Story is semantic Done (resolved by status NAME at runtime). Cancelled is not accepted scope.
for (const [name, id] of [["Ready", 10], ["In Progress", 11], ["GPT Validation", 12], ["Human Decision", 14], ["Cancelled", 15]] as const) {
  test(`prepare is refused with zero mutation while a Story is ${name}`, async () => {
    const sent = notifier();
    stories = [{ id: 1, ref: 1, status: 13 }, { id: 2, ref: 7, status: id }];
    const r = await prepare();
    assert.equal(r.code, "REFUSED"); assert.match(r.message, new RegExp(`#7 \\(${name}\\)`)); assert.match(r.message, /nothing was changed/);
    assert.ok(!r.message.includes("#1 ("), "Done Stories are not listed");
    assert.equal(wikiWrites, 0, "no merge-ready record"); assert.equal(patched, false); assert.deepEqual(sent(), [], "no pointer");
  });
}

test("an empty Sprint is vacuously complete; status ids may change while the names stay (the gate reads names, never ids)", async () => {
  stories = [];
  assert.equal((await prepare()).merge_ready, true);
  wiki = null;
  statuses = [[501, "Ready"], [502, "In Progress"], [503, "GPT Validation"], [504, "Done"], [505, "Human Decision"], [506, "Cancelled"]].map(([id, name]) => ({ id, name }));
  stories = [{ id: 1, ref: 1, status: 504 }];
  assert.equal((await prepare()).merge_ready, true, "renumbered Done accepted");
  wiki = null;
  stories = [{ id: 1, ref: 1, status: 13 }];
  assert.match((await prepare()).message, /#1 \(status 13\)/, "an id that is not Done in this project is never accepted");
});

test("close rechecks the same gate: a Story regressed after confirmation blocks the terminal close with zero write", async () => {
  const r = await prepare();
  await confirm(RECEIPT(r.merge_authorization));
  stories = [{ id: 1, ref: 1, status: 13 }, { id: 2, ref: 2, status: 11 }];
  const c = await close();
  assert.equal(c.code, "REFUSED"); assert.match(c.message, /#2 \(In Progress\)/); assert.match(c.message, /nothing was changed/);
  assert.equal(patched, false); assert.equal(sprint.closed, false);
  stories = [{ id: 1, ref: 1, status: 13 }, { id: 2, ref: 2, status: 13 }];
  assert.equal((await close()).merge_confirmed.outcome, "merged", "complete scope plus the confirmed merge closes");
  assert.equal(sprint.closed, true);
});

test("an ambiguous Done status fails closed instead of guessing", async () => {
  statuses = [...statuses, { id: 99, name: "done" }];
  const r = await prepare();
  assert.equal(r.code, "REFUSED"); assert.match(r.message, /nothing was changed/);
  assert.equal(wikiWrites, 0);
});

test("canonical order is acyclic: the FINAL review Story gates prepare; once it is Done the Sprint prepares, confirms and closes", async () => {
  const FINAL = 20;
  stories = [{ id: 1, ref: 1, status: 13 }, { id: FINAL, ref: 280, status: 12 }]; // FINAL still in GPT Validation
  const refused = await prepare();
  assert.equal(refused.code, "REFUSED"); assert.match(refused.message, /#280 \(GPT Validation\)/); assert.equal(wikiWrites, 0);
  stories = [{ id: 1, ref: 1, status: 13 }, { id: FINAL, ref: 280, status: 13 }]; // final Task Done -> FINAL Story Done
  const r = await prepare();
  assert.equal(r.merge_ready, true);
  assert.match((await close()).message, /no confirmed merge/, "still gated by the signed GitGate confirmation");
  assert.equal((await confirm(RECEIPT(r.merge_authorization))).terminal_ready, true);
  assert.equal((await close()).merge_confirmed.outcome, "merged");
  assert.equal(sprint.closed, true);
});
