import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { TaigaClient } from "../dist/client.js";
import { createTaigaMcpServer } from "../dist/server.js";

// Story #213 / Issue #212, Task #214: governance contract (RED, nothing implemented yet).
//
// CONTRACT (the shape the implementation Tasks must satisfy):
// - Governance is ONE GLOBAL runtime switch for the whole MCP (Task #215 rework, PO decision): no project list and no
//   per-project override. It is ON by default at startup, even with no file; when ON every Taiga project reached through
//   this MCP follows governance, when OFF the MCP is globally free. The state lives in a file OUTSIDE the MCP:
//   $TAIGA_MCP_GOVERNANCE_FILE (default ~/.config/taiga-mcp/governance.json), { "enabled": true|false } (missing
//   file or field = ON). It is read when the server is created and written only by a human-admin local CLI
//   (`taiga-mcp-governance on|off|status`, a separate bin), never by the MCP process.
// - The MCP exposes read-only diagnostics `taiga_governance_status` and NO tool able to change or bypass the state.
// - Governed project, Epic/Story/Task create/update (generic tools): description, when given, must be exactly the nine
//   canonical top-level sections in order (**Purpose**, **Context**, **What to do**, **Deliverables**,
//   **Acceptance / Evidence**, **Do not**, **Dependencies**, **Documentation**, **Execution Notes**); is_blocked=true
//   needs a non-empty blocked_note (given now or already stored); a status change must go through the governed
//   transition tool. A violation is an isError result with code `governance_violation` and ZERO Taiga mutations
//   (only GETs to resolve the entity's project are allowed). Caller text is never rewritten.
// - Governed transition tool `taiga_workflow_transition {entity: task|userstory, id, status, comment}`: comment must be
//   non-empty and NEW (not already the latest comment); it is posted VERBATIM (no signature or actor is added),
//   re-read from history to prove it persisted, and only then is the status PATCHed. Task -> a closed status also needs
//   earlier GPT approval evidence in the task history (Guide 3 handoff): a comment whose FIRST line is
//   `GPT Validation — APPROVED` and whose FINAL line is the GPT signature `-- GPT (<model>)`, e.g. `-- GPT (GPT-6)` (the model is not frozen; legacy `-- GPT-5.6 Sol` is still accepted). This is
//   syntactic governance evidence only, NOT authenticated identity: the shared Taiga credentials cannot prove who
//   wrote a comment, and the MCP must never claim otherwise (no "verified GPT" wording in results).
// - Generic low-level tools stay fully usable while the global switch is OFF.
const GOOD = ["Purpose", "Context", "What to do", "Deliverables", "Acceptance / Evidence", "Do not", "Dependencies", "Documentation", "Execution Notes"]
  .map((h) => `**${h}**\ntext`).join("\n\n");
const realFetch = globalThis.fetch;
const env = { TAIGA_URL: "http://taiga.invalid", TAIGA_USERNAME: "u", TAIGA_PASSWORD: "p" };
const saved = {};
let requests, world, dir;

const setGovernance = (cfg) => {
  const file = join(dir, "governance.json");
  writeFileSync(file, JSON.stringify(cfg));
  process.env.TAIGA_MCP_GOVERNANCE_FILE = file;
};

beforeEach(() => {
  for (const k of Object.keys(env)) { saved[k] = process.env[k]; process.env[k] = env[k]; }
  saved.GOV = process.env.TAIGA_MCP_GOVERNANCE_FILE;
  dir = mkdtempSync(join(tmpdir(), "gov-"));
  setGovernance({ enabled: true });
  requests = [];
  world = { comments: [], dropComments: false, entity: { id: 7, project: 49, version: 3, status: 332, description: GOOD, is_blocked: false, blocked_note: "" } };
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).endsWith("/auth")) return new Response(JSON.stringify({ auth_token: "t", refresh: "r" }), { status: 200 });
    const u = new URL(String(url));
    const path = u.pathname.replace(/^.*\/api\/v1/, "");
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(init.body) : undefined;
    requests.push({ method, path, body });
    const ok = (x) => new Response(JSON.stringify(x), { status: 200 });
    if (method === "GET") {
      if (path.startsWith("/history/")) return ok(world.comments.map((c, i) => ({ id: String(i), comment: c, comment_html: `<p>${c}</p>` })));
      if (/^\/(task|epic)-statuses\/335$/.test(path)) return ok({ id: 335, is_closed: true, order: 335 });
      if (/^\/epic-statuses\/\d+$/.test(path)) return ok({ id: Number(path.split("/")[2]), is_closed: false, order: Number(path.split("/")[2]) });
      if (/^\/task-statuses\/\d+$/.test(path)) return ok({ id: Number(path.split("/")[2]), is_closed: false });
      if (/^\/(tasks|userstories|epics)\/\d+$/.test(path)) return ok({ ...world.entity, id: Number(path.split("/")[2]) });
    }
    if (method === "PATCH" && body?.comment && !world.dropComments) world.comments.push(body.comment);
    return ok({ ...world.entity, ...body });
  };
});
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const k of Object.keys(env)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  if (saved.GOV === undefined) delete process.env.TAIGA_MCP_GOVERNANCE_FILE; else process.env.TAIGA_MCP_GOVERNANCE_FILE = saved.GOV;
  rmSync(dir, { recursive: true, force: true });
});

async function connect() {
  const server = createTaigaMcpServer(new TaigaClient());
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "1" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}
const call = async (name, args) => { const c = await connect(); try { return await c.callTool({ name, arguments: args }); } finally { await c.close(); } };
const writes = () => requests.filter((r) => r.method !== "GET" && !/custom-attributes/.test(r.path));
const payload = (r) => { try { return JSON.parse(r.content[0].text); } catch { return {}; } };
const rejected = (r, why) => {
  assert.equal(r.isError, true, `${why}: expected isError, got ${JSON.stringify(r.content)}`);
  assert.equal(payload(r).code, "governance_violation", `${why}: code`);
  assert.deepEqual(writes(), [], `${why}: a rejected call must not mutate Taiga`);
};

// ---- description contract -------------------------------------------------
const BAD = {
  missing_section: GOOD.replace(/\*\*Documentation\*\*\ntext\n\n/, ""),
  renamed: GOOD.replace("**Purpose**", "**Goal**"),
  reordered: GOOD.replace("**Purpose**\ntext\n\n**Context**", "**Context**\ntext\n\n**Purpose**"),
  extra: GOOD + "\n\n**Notes**\ntext",
  plain: "just a sentence",
};
for (const [kind, create, tool] of [["epic", { project: 49, subject: "s" }, "taiga_epics"], ["story", { project: 49, subject: "s" }, "taiga_userstories"], ["task", { project: 49, subject: "s", user_story: 1 }, "taiga_tasks"]]) {
  for (const [why, description] of Object.entries(BAD)) {
    test(`governed ${kind} create rejects a ${why} description before any mutation`, async () => {
      rejected(await call(`${tool}_create`, { ...create, description }), why);
    });
    test(`governed ${kind} update rejects a ${why} description before any mutation`, async () => {
      rejected(await call(`${tool}_update`, { id: 7, version: 3, description }), why);
    });
  }
  test(`governed ${kind} create/update with a valid nine-section description passes unchanged`, async () => {
    const r1 = await call(`${tool}_create`, { ...create, description: GOOD });
    const r2 = await call(`${tool}_update`, { id: 7, version: 3, description: GOOD });
    assert.notEqual(r1.isError, true); assert.notEqual(r2.isError, true);
    assert.deepEqual(writes().map((w) => w.body.description), [GOOD, GOOD], "caller text must be sent untouched");
  });
}

// ---- blocked state ----------------------------------------------------------
test("governed update rejects is_blocked=true without a blocked_note", async () => {
  rejected(await call("taiga_tasks_update", { id: 7, version: 3, is_blocked: true }), "no note");
});
test("governed update rejects is_blocked=true with a blank blocked_note", async () => {
  requests = [];
  rejected(await call("taiga_userstories_update", { id: 7, version: 3, is_blocked: true, blocked_note: "   " }), "blank note");
});
test("governed create rejects is_blocked=true without a blocked_note", async () => {
  rejected(await call("taiga_tasks_create", { user_story: 1, project: 49, subject: "s", description: GOOD, is_blocked: true }), "create no note");
});
test("governed update accepts is_blocked=true with a non-empty blocked_note", async () => {
  const r = await call("taiga_tasks_update", { id: 7, version: 3, is_blocked: true, blocked_note: "waiting for PO" });
  assert.notEqual(r.isError, true);
  assert.equal(writes().length, 1);
});

// ---- status changes must use the governed transition ----------------------
test("governed generic update refuses a status change (must use taiga_workflow_transition)", async () => {
  rejected(await call("taiga_tasks_update", { id: 7, version: 3, status: 334 }), "status via generic update");
});

// ---- governed transition ---------------------------------------------------
const transition = (args) => call("taiga_workflow_transition", { entity: "task", id: 7, status: 334, author: "Tester", ...args });

test("taiga_workflow_transition exists with entity/id/status/comment and a required author field", async () => {
  const c = await connect();
  const t = (await c.listTools()).tools.find((x) => x.name === "taiga_workflow_transition");
  await c.close();
  assert.ok(t, "taiga_workflow_transition missing");
  const props = Object.keys(t.inputSchema.properties);
  for (const k of ["entity", "id", "status", "comment", "author"]) assert.ok(props.includes(k), `${k} missing`);
  assert.ok(t.inputSchema.required.includes("author"), "author must be required");
});
test("a governed transition without a comment is rejected before any mutation", async () => {
  for (const comment of [undefined, "", "   "]) { requests = []; rejected(await transition({ comment }), `comment ${JSON.stringify(comment)}`); }
});
test("a governed transition reusing the latest existing comment is rejected (must be NEW)", async () => {
  world.comments = ["same evidence\n\n-- Tester"];
  rejected(await transition({ comment: "same evidence" }), "stale comment");
});
test("a governed transition posts the comment signed with the author, verifies it in history, and only then changes status", async () => {
  const r = await transition({ comment: "Signed: scope-ca\nevidence" });
  assert.notEqual(r.isError, true, JSON.stringify(r.content));
  const w = writes();
  assert.equal(w.length, 2, JSON.stringify(w));
  assert.equal(w[0].body.comment, "Signed: scope-ca\nevidence\n\n-- Tester", "text kept as is, `-- <author>` appended");
  assert.equal(w[1].body.status, 334);
  const iComment = requests.indexOf(w[0]), iStatus = requests.indexOf(w[1]);
  assert.ok(requests.slice(iComment + 1, iStatus).some((x) => x.method === "GET" && x.path.startsWith("/history/")), "no persistence check between comment and status");
});
test("if the comment did not persist, the status is NOT changed and the result is an error", async () => {
  world.dropComments = true;
  const r = await transition({ comment: "evidence" });
  assert.equal(r.isError, true);
  assert.equal(payload(r).code, "comment_not_persisted", "must be the typed persistence failure, not a missing tool");
  assert.deepEqual(writes().filter((w) => w.body?.status !== undefined), [], "status changed without a verified comment");
});
test("Task -> Done without canonical GPT approval evidence is rejected (invented markers, wrong first line, wrong signature)", async () => {
  world.comments = ["Signed: scope-ca\nmy own evidence", "Signed: GPT\nVerdict: PASS", "GPT Validation — APPROVED\nbody\nno signature line", "intro\nGPT Validation — APPROVED\n-- GPT-5.6 Sol"];
  rejected(await transition({ status: 335, comment: "closing" }), "done without GPT evidence");
});
test("Task -> Done with a canonical GPT approval comment in history is allowed, and the result claims no authenticated identity", async () => {
  world.comments = ["GPT Validation — APPROVED\nAll criteria revalidated.\n\n-- GPT (GPT-6)"];
  const r = await transition({ status: 335, comment: "closing after PASS" });
  assert.notEqual(r.isError, true, JSON.stringify(r.content));
  assert.equal(writes().at(-1).body.status, 335);
  assert.ok(!/authenticat|identity (is )?verified|verified (as )?gpt/i.test(r.content[0].text), "result must not claim authenticated identity");
});

test("Task -> Done accepts an approval signed by any author (GPT, Kimi, Claude, the PO) and the legacy GPT forms", async () => {
  for (const sig of ["-- GPT (GPT-5.6)", "-- GPT (GPT-7 Pro)", "-- GPT-5.6 Sol", "-- Kimi (K3)", "-- Claude (Sonnet 5.5)", "-- Andre"]) {
    world.comments = ["GPT Validation — APPROVED\nOK.\n" + sig];
    const r = await transition({ status: 335, comment: "closing after PASS" });
    assert.notEqual(r.isError, true, sig + " " + JSON.stringify(r.content));
  }
});
test("Task -> Done rejects an approval whose last line is not a `-- <author>` signature", async () => {
  for (const sig of ["--", "-- ", "GPT (GPT-6)", "signed by GPT"]) {
    world.comments = ["GPT Validation — APPROVED\nOK.\n" + sig];
    rejected(await transition({ status: 335, comment: "closing after PASS" }), "bad signature " + sig);
  }
});
// ---- startup default, control surface, diagnostics -------------------------
test("an explicit enabled:true file is governed", async () => {
  rejected(await call("taiga_tasks_create", { user_story: 1, project: 49, subject: "s", description: "plain" }), "explicit ON");
});
test("taiga_governance_status is read-only diagnostics reporting the single global state", async () => {
  const r = await call("taiga_governance_status", {});
  assert.notEqual(r.isError, true, JSON.stringify(r.content));
  assert.deepEqual(payload(r), { enabled: true });
  setGovernance({ enabled: false });
  assert.deepEqual(payload(await call("taiga_governance_status", {})), { enabled: false });
  assert.deepEqual(writes(), []);
});
test("no MCP tool can disable, enable or bypass governance", async () => {
  const c = await connect();
  const { tools } = await c.listTools();
  await c.close();
  const gov = tools.filter((t) => /governance/i.test(t.name));
  assert.deepEqual(gov.map((t) => t.name), ["taiga_governance_status"]);
  assert.deepEqual(Object.keys(gov[0].inputSchema.properties ?? {}), []);
  for (const t of tools) {
    const props = Object.keys(t.inputSchema.properties ?? {});
    assert.ok(!props.some((p) => /governance|bypass|skip_validation|force/i.test(p)), `${t.name} has a bypass-like parameter: ${props}`);
  }
});
test("the MCP never writes the governance file", async () => {
  const file = process.env.TAIGA_MCP_GOVERNANCE_FILE;
  const before = JSON.stringify(JSON.parse(await import("node:fs").then((m) => m.readFileSync(file, "utf8"))));
  await call("taiga_tasks_create", { user_story: 1, project: 49, subject: "s", description: "plain" });
  await call("taiga_governance_status", {});
  assert.equal(JSON.stringify(JSON.parse(await import("node:fs").then((m) => m.readFileSync(file, "utf8")))), before);
});

// ---- global switch ----------------------------------------------------------
test("global OFF keeps the generic tools fully usable for any project (malformed description, blocked w/o note, status)", async () => {
  setGovernance({ enabled: false });
  const a = await call("taiga_tasks_create", { user_story: 1, project: 49, subject: "s", description: "plain" });
  const b = await call("taiga_tasks_update", { id: 7, version: 3, is_blocked: true });
  const c = await call("taiga_tasks_update", { id: 7, version: 3, status: 334 });
  const d = await call("taiga_tasks_create", { user_story: 1, project: 99, subject: "s", description: "plain" });
  for (const r of [a, b, c, d]) assert.notEqual(r.isError, true, JSON.stringify(r.content));
  assert.equal(writes().length, 4);
});
test("global ON governs every project, listed or not", async () => {
  for (const project of [49, 50, 99]) { requests = []; rejected(await call("taiga_tasks_create", { user_story: 1, project, subject: "s", description: "plain" }), `project ${project}`); }
});
test("with no governance file at all, governance is ON", async () => {
  process.env.TAIGA_MCP_GOVERNANCE_FILE = join(dir, "does-not-exist.json");
  rejected(await call("taiga_tasks_create", { user_story: 1, project: 49, subject: "s", description: "plain" }), "missing file");
  assert.deepEqual(payload(await call("taiga_governance_status", {})), { enabled: true });
});
test("a file without the enabled field is ON; per-project maps are ignored (no project overrides exist)", async () => {
  setGovernance({ projects: { 49: { enabled: false } } });
  rejected(await call("taiga_tasks_create", { user_story: 1, project: 49, subject: "s", description: "plain" }), "project map ignored");
  assert.deepEqual(payload(await call("taiga_governance_status", {})), { enabled: true });
});
test("a malformed governance file fails closed at server creation", async () => {
  for (const body of ["{not json", JSON.stringify({ enabled: "no" }), "[]"]) {
    const file = join(dir, "bad.json"); writeFileSync(file, body);
    process.env.TAIGA_MCP_GOVERNANCE_FILE = file;
    assert.throws(() => createTaigaMcpServer(new TaigaClient()), /governance file/, body);
  }
});

import { transitionCommentProblems } from "../dist/governance.js";

test("transition comment: rejects short and generic, accepts an explanation", () => {
  assert.ok(transitionCommentProblems("movido").length);
  assert.ok(transitionCommentProblems("x".repeat(59)).length);
  assert.equal(transitionCommentProblems("Implemented the retry guard in occurrence-scheduler.ts; focused test passes.").length, 0);
});

import { loadGovernance as loadLive } from "../dist/governance.js";

test("the switch is re-read on every access, so a hand edit applies without a restart", () => {
  const file = join(mkdtempSync(join(tmpdir(), "gov-")), "governance.json");
  writeFileSync(file, '{"enabled": true}');
  const state = loadLive(file);
  assert.equal(state.enabled, true);
  writeFileSync(file, '{"enabled": false}');
  assert.equal(state.enabled, false);
  writeFileSync(file, "not json");
  assert.equal(state.enabled, true, "a broken file after startup reads as ON");
});


// ---- Epic transitions ---------------------------------------------------------
const epicMove = (args) => call("taiga_workflow_transition", { entity: "epic", id: 7, status: 335, author: "Tester", ...args });
const GOOD_COMMENT = "Closed the Epic: all Stories are Done or superseded, evidence in the Story comments.";

test("governed epic status through the generic update is still rejected", async () => {
  rejected(await call("taiga_epics_update", { id: 7, version: 3, status: 335 }), "epic generic status");
});

test("epic transition posts the comment, proves it in history, then sets the closed status", async () => {
  const r = await epicMove({ comment: GOOD_COMMENT });
  assert.notEqual(r.isError, true, JSON.stringify(r.content));
  assert.equal(payload(r).closed, true);
  assert.deepEqual(world.comments, [GOOD_COMMENT + "\n\n-- Tester"]);
  const w = writes();
  assert.equal(w.length, 2);
  assert.deepEqual([w[0].path, w[0].body.comment, w[1].path, w[1].body.status], ["/epics/7", GOOD_COMMENT + "\n\n-- Tester", "/epics/7", 335]);
  const i = requests.findIndex((q) => q.method === "PATCH" && q.body?.status === 335);
  assert.ok(requests.slice(0, i).some((q) => q.method === "GET" && q.path === "/history/epic/7"), "history re-read before the status change");
});

test("epic transition without a comment is rejected with zero mutations", async () => {
  rejected(await epicMove({}), "no comment");
  rejected(await epicMove({ comment: "   " }), "blank comment");
});

test("epic transition does not change status when the comment is not persisted", async () => {
  world.dropComments = true;
  const r = await epicMove({ comment: GOOD_COMMENT });
  assert.equal(r.isError, true);
  assert.equal(payload(r).code, "comment_not_persisted");
  assert.deepEqual(writes().filter((q) => q.body?.status !== undefined), []);
});

test("epic reopening (backwards move) is allowed with a comment and carries the backward reminder", async () => {
  world.entity.status = 335;
  const r = await epicMove({ status: 334, comment: "Reopened: a late finding means Story scope is incomplete, see the new Issue." });
  assert.notEqual(r.isError, true, JSON.stringify(r.content));
  assert.equal(payload(r).closed, false);
  assert.match(payload(r).reminder, /backwards/);
});

test("with governance OFF an epic status moves without a comment", async () => {
  setGovernance({ enabled: false });
  const r = await epicMove({});
  assert.notEqual(r.isError, true, JSON.stringify(r.content));
  assert.deepEqual(writes().map((q) => q.body.status), [335]);
});

test("task and user story transitions keep working", async () => {
  const t = await call("taiga_workflow_transition", { entity: "task", id: 7, status: 334, author: "Tester", comment: "Started the work: wrote the failing test first." });
  assert.notEqual(t.isError, true, JSON.stringify(t.content));
  const u = await call("taiga_workflow_transition", { entity: "userstory", id: 7, status: 334, author: "Tester", comment: "Story moved forward after its Tasks started." });
  assert.notEqual(u.isError, true, JSON.stringify(u.content));
});

// ---- refusal and description hints ----------------------------------------------
for (const tool of ["taiga_tasks_update", "taiga_userstories_update", "taiga_epics_update"]) {
  test(`${tool} refusal of a status change tells how to fix it and mutates nothing`, async () => {
    const r = await call(tool, { id: 7, version: 3, status: 335 });
    rejected(r, "status hint");
    const msg = payload(r).violations.join(" ");
    assert.match(msg, /taiga_workflow_transition/);
    assert.match(msg, /`comment`/);
    assert.match(msg, /only comment/);
  });
  test(`${tool} description warns that status is not usable in a governed project`, async () => {
    const c = await connect();
    try {
      const t = (await c.listTools()).tools.find((x) => x.name === tool);
      assert.match(t.description, /taiga_workflow_transition/);
      assert.match(t.description, /`comment`/);
    } finally { await c.close(); }
  });
}

test("taiga_workflow_transition description makes comment mandatory evidence, one comment only", async () => {
  const c = await connect();
  try {
    const t = (await c.listTools()).tools.find((x) => x.name === "taiga_workflow_transition");
    assert.match(t.description, /`comment` is required/);
    assert.match(t.description, /do NOT post a separate comment/);
  } finally { await c.close(); }
});

test("a transition without a valid author is refused and nothing is posted", async () => {
  for (const author of [undefined, "", "   ", "a\nb", "x".repeat(61)]) {
    requests = [];
    const r = await call("taiga_workflow_transition", { entity: "task", id: 7, status: 334, comment: "Started the work: wrote the failing test first.", ...(author === undefined ? {} : { author }) });
    assert.equal(r.isError, true, `author ${JSON.stringify(author)}`);
    assert.deepEqual(writes(), [], "no mutation without a valid author");
  }
});

test("comment delete sends the comment id as a query parameter and accepts an empty 200 body", async () => {
  const inner = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) =>
    String(url).includes("/delete_comment") ? (requests.push({ method: init.method, path: new URL(String(url)).pathname + new URL(String(url)).search }), new Response("", { status: 200 })) : inner(url, init);
  const r = await call("taiga_task_comment_delete", { id: 7, comment_id: "abc-123" });
  assert.notEqual(r.isError, true, JSON.stringify(r.content));
  const d = requests.find((q) => q.path?.includes("delete_comment"));
  assert.equal(d.method, "POST");
  assert.match(d.path, /\/history\/task\/7\/delete_comment\?id=abc-123$/);
});
