import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, cpSync, readFileSync, existsSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { TaigaClient } from "../dist/client.js";
import { createTaigaMcpServer } from "../dist/server.js";
import { actorFor, loadActorConfig, identityFromEnv } from "../dist/workflow/actor.js";
import { exact, loadTemplates, latest, compareSemVer, parseSemVer, templatesDir } from "../dist/workflow/templates.js";

// Executable workflow contract: authenticated actors, actor/state matrix, versioned Markdown artifacts, free-comment
// lock, workflow-state read model and structured Requests. Taiga history is the only store.
const GOOD = ["Purpose", "Context", "What to do", "Deliverables", "Acceptance / Evidence", "Do not", "Dependencies", "Documentation", "Execution Notes"].map((h) => `**${h}**\ntext`).join("\n\n");
const realFetch = globalThis.fetch;
const env = { TAIGA_URL: "http://taiga.invalid", TAIGA_USERNAME: "u", TAIGA_PASSWORD: "p" };
const saved = {};
const T = { todo: 1, prog: 2, val: 3, human: 4, done: 5, canc: 6, req: 7 };
const S = { ready: 10, prog: 11, val: 12, done: 13, human: 14, canc: 15 };
const TASK_STATUSES = [[1, "To Do"], [2, "In Progress"], [3, "GPT Validation"], [4, "Human Decision"], [5, "Done"], [6, "Cancelled"], [7, "Request"]].map(([id, name]) => ({ id, name }));
const STORY_STATUSES = [[10, "Ready"], [11, "In Progress"], [12, "GPT Validation"], [13, "Done"], [14, "Human Decision"], [15, "Cancelled"]].map(([id, name]) => ({ id, name }));
let requests, world, dir;

beforeEach(() => {
  for (const k of Object.keys(env)) { saved[k] = process.env[k]; process.env[k] = env[k]; }
  saved.GOV = process.env.TAIGA_MCP_GOVERNANCE_FILE;
  dir = mkdtempSync(join(tmpdir(), "wf-"));
  writeFileSync(join(dir, "governance.json"), JSON.stringify({ enabled: true }));
  process.env.TAIGA_MCP_GOVERNANCE_FILE = join(dir, "governance.json");
  process.env.TAIGA_MCP_CONTINUATION_FILE = join(dir, "continuations.jsonl");
  requests = [];
  let n = 0;
  const mk = (extra) => ({ comments: [], entity: { id: 7, ref: 905, project: 49, version: 3, status: T.todo, subject: "s", description: GOOD, is_blocked: false, blocked_note: "", milestone: null, ...extra } });
  world = { task: mk({}), userstory: mk({ status: S.ready, ref: 12 }), dropComments: false, storyTasks: [{ id: 1001, ref: 901, status: T.done }, { id: 1002, ref: 902, status: T.done }] };
  const kindOf = (p) => (p.includes("userstor") ? "userstory" : "task");
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).endsWith("/auth")) return new Response(JSON.stringify({ auth_token: "t", refresh: "r" }), { status: 200 });
    const u = new URL(String(url));
    const path = u.pathname.replace(/^.*\/api\/v1/, "");
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(init.body) : undefined;
    requests.push({ method, path, body });
    const ok = (x) => new Response(JSON.stringify(x), { status: 200 });
    if (method === "GET") {
      if (path === "/task-statuses") return ok(Number(u.searchParams.get("project")) === 49 ? [...TASK_STATUSES.filter((x) => !(world.noRequestStatus && x.name === "Request")).map((x) => ({ ...x, id: x.id + (world.statusOffset ?? 0) })), ...(world.dupInProgress ? [{ id: 99, name: "in  progress" }] : []), ...(world.dupRequest ? [{ id: 98, name: " request" }] : [])] : [{ id: 1, name: "New" }, { id: 2, name: "Closed" }]);
      if (path === "/users/me") return ok({ username: world.me });
      if (path === "/users") return ok(world.users ?? []);
      if (path === "/wiki/by_slug") return world.wiki ? ok(world.wiki) : new Response("{}", { status: 404 });
      if (path === "/milestones") return ok(world.milestones ?? [{ id: 300 }]);
      if (path === "/projects") return ok(world.projects ?? [{ id: 49 }]);
      if (path === "/tasks") return ok(u.searchParams.has("milestone") ? [world.task.entity, ...(world.sprintTasks ?? [])] : world.storyTasks);
      if (path === "/userstory-statuses") return ok([...STORY_STATUSES.filter((x) => !(world.noReadyStory && x.name === "Ready")), ...(world.dupStoryDone ? [{ id: 98, name: "done" }] : [])]);
      let m;
      if ((m = /^\/(task|userstory)-statuses\/(\d+)$/.exec(path))) return ok({ id: Number(m[2]), is_closed: world.statusClosed?.[m[1] + m[2]] ?? (m[1] === "task" ? [5, 6] : [13, 15]).includes(Number(m[2])), order: Number(m[2]) });
      if ((m = /^\/history\/(task|userstory)\/\d+$/.exec(path))) return ok(world[m[1]].comments);
      // Identity for canonical references: by_ref -> entity (id = 1000 + ref), one "UUID" definition (id 7), value from world.uuids["<kind>:<ref>"] or a valid default.
      if ((m = /^\/(tasks|userstories|epics|issues)\/by_ref$/.exec(path))) { const ref = Number(u.searchParams.get("ref")); const owner = { 905: "tasks", 1: "issues", 12: "userstories", 5: "epics", ...(world.refKind ?? {}) }[ref]; return (world.noRef ?? []).includes(`${m[1]}:${ref}`) || (owner !== undefined && owner !== m[1]) || (owner === undefined && ref !== 404 && !world.anyRef) ? new Response("{}", { status: 404 }) : ok({ id: 1000 + ref, ref, project: Number(u.searchParams.get("project")) }); }
      if ((m = /^\/(task|userstory|epic|issue)-custom-attributes$/.exec(path))) return ok(world.noUuidDef ? [] : [{ id: 7, name: "UUID" }]);
      if ((m = /^\/(tasks|userstories|epics|issues)\/custom-attributes-values\/(\d+)$/.exec(path))) { const ref = Number(m[2]) - 1000; const v = world.uuids?.[`${m[1]}:${ref}`] ?? `0190aaaa-0000-7000-8000-${String(ref).padStart(12, "0")}`; return ok({ version: 1, attributes_values: v === null ? {} : { 7: v } }); }
      if (path === "/userstories" && u.searchParams.get("milestone")) return ok([world.userstory.entity, ...(world.sprintRows ?? [])].filter((r) => r.milestone === Number(u.searchParams.get("milestone"))).sort((x, y) => x.sprint_order - y.sprint_order));
      if ((m = /^\/userstories\/(\d+)$/.exec(path)) && world.sprintRows?.some((r) => r.id === Number(m[1]))) return ok({ ...world.sprintRows.find((r) => r.id === Number(m[1])) });
      if ((m = /^\/milestones\/(\d+)$/.exec(path))) return ok({ id: Number(m[1]), project: world.milestoneProject ?? 49 });
      if (/^\/(tasks|userstories)\/\d+$/.test(path)) return ok({ ...world[kindOf(path)].entity });
    }
    if (method === "PATCH") {
      const k = kindOf(path);
      const sr = /^\/userstories\/(\d+)$/.exec(path);
      const srow = sr && world.sprintRows?.find((r) => r.id === Number(sr[1]));
      if (world.failSprintPatch && body?.sprint_order !== undefined) return new Response("boom", { status: 500 });
      if (srow) { Object.assign(srow, { sprint_order: body.sprint_order, version: srow.version + 1 }); return ok({ ...srow }); }
      if (world.failUnblock && body?.is_blocked === false) return new Response("boom", { status: 500 });
      if (body?.comment !== undefined && !world.dropComments) world[k].comments.push({ id: world.uuidIds ? `${(0x393c47f0 + ++n).toString(16)}-dd90-11f1-84e4-cacb139fa1ca` : `c${++n}`, comment: body.comment, created_at: new Date(1760000000000 + n * 1000).toISOString() });
      // eslint-disable-next-line @typescript-eslint/no-unused-vars -- rest-omit
      const { comment, version, ...rest } = body;
      if (world.dropAssignee && k === "userstory") delete rest.assigned_to;
      if (world.dropClosed) delete rest.is_closed;
      if (world.dropStatus) delete rest.status;
      Object.assign(world[k].entity, rest);
      return ok({ ...world[k].entity });
    }
    return ok({});
  };
});
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const k of Object.keys(env)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  if (saved.GOV === undefined) delete process.env.TAIGA_MCP_GOVERNANCE_FILE; else process.env.TAIGA_MCP_GOVERNANCE_FILE = saved.GOV;
  delete process.env.TAIGA_MCP_CONTINUATION_FILE;
  rmSync(dir, { recursive: true, force: true });
});

// role = "gpt" | "claude" | "po" (authenticated) or null (syntactic; pass `author` in args)
async function call(role, name, args) {
  requests = []; // each assertion looks at the writes of ONE call
  if (world.accounts) world.me = world.accounts[role]; // a real process is logged in as the account of its actor
  const server = createTaigaMcpServer(new TaigaClient(), role ? { mode: "authenticated", actor: actorFor(role) } : { mode: "syntactic", actor: null });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "1" });
  await Promise.all([server.connect(a), client.connect(b)]);
  try { return await client.callTool({ name, arguments: args }); } finally { await client.close(); }
}
const payload = (r) => { try { return JSON.parse(r.content[0].text); } catch { return {}; } };
const writes = () => requests.filter((r) => r.method !== "GET");
const reject = (r, why, re) => {
  assert.equal(r.isError, true, `${why}: expected isError, got ${JSON.stringify(r.content)}`);
  assert.match(payload(r).code, /^(governance_violation|WORKFLOW_[A-Z_]+)$/, why);
  assert.deepEqual(writes(), [], `${why}: a rejected call must not mutate Taiga`);
  if (re) assert.match(JSON.stringify(payload(r).violations), re, why);
};
const okr = (r) => { assert.notEqual(r.isError, true, JSON.stringify(r.content)); return payload(r); };

// ---- valid artifact builders -------------------------------------------------
const L = (x = "x") => [x];
const blueprint = (o = {}) => ({
  type: "implementation_blueprint", mode: "initial", objective: "o", verified_baseline: "b", problem_model: "The retry guard ignores throttled-only failures.",
  binding_contracts: L(), architecture_owners: [{ responsibility: "r", current_owner: "a", intended_owner: "a", forbidden_parallel_owner: "none" }],
  implementation_scope: L(), files_and_interfaces: L(), invariants: L(), known_traps_and_risks: L(), focused_test_matrix: L(), evidence_expected: L(),
  operational_steps: L("None."), prohibited_actions: L("No push."), stop_condition: "Stop at GPT Validation.", open_questions: [], ...o,
});
const correction = (o = {}) => blueprint({
  mode: "correction", validation_round: 1, supersedes_blueprint_comment_id: "SET", cumulative_audit_scope: "full diff",
  findings: [{ id: "F1", evidence: "e", classification: "functional", root_cause: "stale fixture", required_correction: "fix", affected_owners: "a", regression_scope: "pool" }],
  unchanged_verified_invariants: L(), cumulative_revalidation_matrix: L(), ...o,
});
const handoff = (o = {}) => ({
  type: "execution_handoff", blueprint_comment_id: "SET", branch: "feature/x", commits: [{ id: "abc123", contains: "fix" }], implementation_summary: L(), files_changed: L(),
  focused_tests: [{ command: "node --test", result: "pass", counts: "3/3" }], typecheck: "clean", runtime_evidence: L("None."), migrations_or_service_actions: L("None."),
  deviations_from_blueprint: L("No deviations."), known_limits: L("None."), bug_hunt: L(), unrelated_findings: L("None."), prohibited_actions_not_performed: L("No push."), working_tree_notes: L("clean"), ...o,
});
const approval = (o = {}) => ({
  type: "validation_approval", blueprint_comment_id: "SET", handoff_comment_id: "SET", commits_validated: L(), cumulative_diff_review: "reviewed", contracts_rechecked: L(), owners_rechecked: L(),
  acceptance_results: L(), tests_verified: L(), runtime_evidence_verified: L("None."), regression_hunt: L(), issues_created: L("None."), known_limits: L("None."), po_gates_not_run: L("push"), verdict: "approved", ...o,
});
const hdr = (o = {}) => ({
  type: "human_decision_request", decision_needed: "Choose between two product behaviors for expired postings", why_existing_contract_does_not_decide_it: "ADR silent", evidence: L(),
  options: ["Keep", "Drop"], recommendation: "Keep", impact_of_each_option: L(), blocked: false, resume_target: "In Progress", ...o,
});
const blocker = (o = {}) => ({ type: "blocker_report", finding: "schema missing", evidence: L(), blocked_note: "needs predecessor task", issue_reference: "Issue #1", required_predecessor_work: L(), ...o });
const poDecision = (o = {}) => ({ type: "po_decision", decision: "reopen", rationale: "late finding", effect: "back to In Progress", ...o });

const tr = (role, status, artifact, extra = {}, entity = "task") => call(role, "taiga_workflow_transition", { entity, id: 7, status, artifact, ...(role ? {} : { author: "Tester" }), ...extra });
const state = (role = "gpt", extra = {}) => call(role, "taiga_task_workflow_state", { id: 7, ...extra });
const lastComment = () => world.task.comments.at(-1);
const bySchema = (name) => world.task.comments.filter((c) => (c.comment.split("\n")[1] ?? "").startsWith(`Schema: ${name} `));
const bpId = () => bySchema("Implementation Blueprint")[0].id;
const cur = (name) => bySchema(name).at(-1).id;

async function release() { okr(await tr("gpt", T.prog, blueprint())); }
async function toValidation() { await release(); okr(await tr("claude", T.val, handoff({ blueprint_comment_id: bpId() }))); }

// ============================ templates =======================================
test("templates: the shipped directory loads; every field has a short description", () => {
  const set = loadTemplates();
  for (const name of ["implementation-blueprint", "correction-blueprint", "execution-handoff", "validation-approval", "human-decision-request", "blocker-report", "po-decision", "workflow-request", "workflow-request-response"]) {
    const t = latest(set, name);
    assert.equal(t.version, "1.0.0");
    for (const f of t.fields) assert.ok(f.description.length >= 10, `${name}.${f.key} needs a description`);
  }
});

function tmpTemplates(extra = {}) {
  const d = mkdtempSync(join(tmpdir(), "tpl-"));
  cpSync(templatesDir(), d, { recursive: true });
  for (const [file, body] of Object.entries(extra)) writeFileSync(join(d, file), body);
  return d;
}
const bumped = () => readFileSync(join(templatesDir(), "execution-handoff-v1.0.0.md"), "utf8");

test("templates: SemVer is parsed numerically, never alphabetically (1.10.0 > 1.9.0 > 1.2.0)", () => {
  const body = bumped();
  const d = tmpTemplates({ "execution-handoff-v1.2.0.md": body, "execution-handoff-v1.9.0.md": body, "execution-handoff-v1.10.0.md": body, "execution-handoff-v2.0.0.md": body.replace("branch", "branch") });
  try {
    const set = loadTemplates(d);
    assert.equal(latest(set, "execution-handoff").version, "2.0.0");
    rmSync(join(d, "execution-handoff-v2.0.0.md"));
    assert.equal(latest(loadTemplates(d), "execution-handoff").version, "1.10.0");
    assert.ok(compareSemVer(parseSemVer("1.10.0"), parseSemVer("1.9.0")) > 0);
    assert.equal(parseSemVer("1.0"), null);
    assert.equal(parseSemVer("01.0.0"), null);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("templates: invalid file names, unknown names, bad front matter and missing templates fail closed", () => {
  const body = bumped();
  for (const [file, content] of [["execution-handoff-v1.0.md", body], ["execution-handoff-1.0.0.md", body], ["execution-handoff-v01.0.0.md", body], ["Execution-Handoff-v1.0.0.md", body], ["README.md", "x"], ["surprise-v1.0.0.md", body], ["execution-handoff-v1.1.0.md", body.replace("type: execution_handoff", "type: wrong")], ["execution-handoff-v1.1.0.md", "no front matter"], ["execution-handoff-v1.1.0.md", body.replace("`typecheck` (text,", "`typecheck` (nonsense,")]]) {
    const d = tmpTemplates({ [file]: content });
    try { assert.throws(() => loadTemplates(d), undefined, file); } finally { rmSync(d, { recursive: true, force: true }); }
  }
  const d = tmpTemplates();
  rmSync(join(d, "po-decision-v1.0.0.md"));
  try { assert.throws(() => loadTemplates(d), /po-decision/); } finally { rmSync(d, { recursive: true, force: true }); }
});

test("templates: a malformed template directory makes the server refuse to start", () => {
  const d = tmpTemplates({ "junk.txt": "x" });
  process.env.TAIGA_MCP_TEMPLATES_DIR = d;
  try { assert.throws(() => createTaigaMcpServer(new TaigaClient()), /junk\.txt/); } finally { delete process.env.TAIGA_MCP_TEMPLATES_DIR; rmSync(d, { recursive: true, force: true }); }
});

test("templates: a NEW artifact uses the highest version; history keeps the version it declares", async () => {
  await release();
  const old = lastComment();
  assert.match(old.comment, /^To Do → In Progress\nSchema: Implementation Blueprint 1\.0\.0\nAuthor: GPT\nModel: Unknown\nEffort: Unknown\n/);
  const body = readFileSync(join(templatesDir(), "execution-handoff-v1.0.0.md"), "utf8");
  const d = tmpTemplates({ "execution-handoff-v1.1.0.md": body, "execution-handoff-v2.0.0.md": body.replace("- `branch` (text)", "- `branch` (text)").replace("- `typecheck` (text, label=**Typecheck**): Typecheck result.", "- `typecheck` (text, label=**Typecheck**): Typecheck result.\n- `lint` (text, label=**Lint**): Lint result.") });
  process.env.TAIGA_MCP_TEMPLATES_DIR = d;
  try {
    // v2.0.0 adds a required field: the old shape no longer validates for a NEW handoff, and an explicit older version is refused
    reject(await tr("claude", T.val, handoff({ blueprint_comment_id: bpId() })), "v2 requires lint", /lint is required/);
    reject(await tr("claude", T.val, handoff({ blueprint_comment_id: bpId(), lint: "ok", version: "1.0.0" })), "explicit older version", /2\.0\.0/);
    okr(await tr("claude", T.val, handoff({ blueprint_comment_id: bpId(), lint: "ok", version: "2.0.0" })));
    assert.match(lastComment().comment, /^In Progress → GPT Validation\nSchema: Execution Handoff 2\.0\.0\n/);
    // the older Blueprint (declared 1.0.0) is still understood while newer templates exist
    const st = okr(await state("gpt"));
    assert.equal(st.current_blueprint.comment_id, bpId());
  } finally { delete process.env.TAIGA_MCP_TEMPLATES_DIR; rmSync(d, { recursive: true, force: true }); }
});

test("templates: an artifact declaring a version with no template file fails closed", async () => {
  await release();
  world.task.comments.push({ id: "z9", comment: "Implementation Blueprint\nSchema: implementation-blueprint/9.9.9\n\n## Objective\nx", created_at: "2030-01-01T00:00:00Z" });
  const r = await state("gpt");
  assert.equal(r.isError, true);
  assert.equal(payload(r).code, "WORKFLOW_TEMPLATE_UNAVAILABLE");
  reject(await tr("claude", T.val, handoff({ blueprint_comment_id: "z9" })), "unsupported history", /9\.9\.9/);
});

test("taiga_workflow_template lists templates and returns the Markdown contract", async () => {
  const list = okr(await call("gpt", "taiga_workflow_template", {}));
  assert.ok(list.templates.some((t) => t.name === "execution-handoff" && t.latest === "1.0.0"));
  const one = okr(await call("claude", "taiga_workflow_template", { name: "execution-handoff" }));
  assert.match(one.markdown, /`blueprint_comment_id`/);
  assert.equal((await call("claude", "taiga_workflow_template", { name: "nope" })).isError, true);
});

test("taiga_workflow_template: raw is the default, parsed and both are derived from the same file", async () => {
  const raw = okr(await call("claude", "taiga_workflow_template", { name: "execution-handoff" }));
  assert.equal(raw.format, "raw");
  assert.equal(raw.source_file, "execution-handoff-v1.0.0.md");
  assert.equal(raw.markdown, readFileSync(join(templatesDir(), raw.source_file), "utf8"));
  assert.equal(raw.parsed, undefined);
  const parsedOnly = okr(await call("claude", "taiga_workflow_template", { name: "execution-handoff", format: "parsed" }));
  assert.equal(parsedOnly.markdown, undefined);
  const both = okr(await call("claude", "taiga_workflow_template", { name: "execution-handoff", format: "both" }));
  assert.equal(both.markdown, raw.markdown);
  assert.deepEqual(both.parsed, parsedOnly.parsed);
  const p = both.parsed;
  assert.deepEqual(p.artifact, { type: "execution_handoff", title: "Execution Handoff — READY FOR GPT VALIDATION", display: "Execution Handoff" });
  assert.equal(p.common_header.length, 5);
  const f = Object.fromEntries(p.fields.map((x) => [x.key, x]));
  assert.deepEqual([f.blueprint_comment_id.kind, f.blueprint_comment_id.placement, f.blueprint_comment_id.task_only], ["id", "header", true]);
  assert.deepEqual(f.focused_tests.record_keys, ["command", "result"]);
  assert.deepEqual(f.focused_tests.optional_record_keys, ["counts", "pre_existing"]);
  const req = okr(await call("claude", "taiga_workflow_template", { name: "workflow-request", format: "parsed" }));
  assert.deepEqual(req.parsed.fields.find((x) => x.key === "request_type").allowed_values, ["analysis", "clarification", "evidence", "capability_gap"]);
  const dec = okr(await call("claude", "taiga_workflow_template", { name: "human-decision-request", format: "parsed" }));
  assert.equal(dec.parsed.fields.find((x) => x.key === "options").min_items, 2);
});

test("taiga_workflow_template: a new 1.0.1 file is picked up with no code or RULES change; 1.0.0 stays readable; bad input fails closed", async () => {
  const tdir = mkdtempSync(join(tmpdir(), "tpl-"));
  cpSync(templatesDir(), tdir, { recursive: true });
  const src = readFileSync(join(tdir, "execution-handoff-v1.0.0.md"), "utf8");
  writeFileSync(join(tdir, "execution-handoff-v1.0.1.md"), src.replace("- `branch` (text, label=**Branch**)", "- `extra_note` (text, optional, label=**Extra**): New in 1.0.1.\n- `branch` (text, label=**Branch**)"));
  const prev = process.env.TAIGA_MCP_TEMPLATES_DIR; process.env.TAIGA_MCP_TEMPLATES_DIR = tdir;
  try {
    const latestOne = okr(await call("claude", "taiga_workflow_template", { name: "execution-handoff", format: "parsed" }));
    assert.equal(latestOne.version, "1.0.1");
    assert.ok(latestOne.parsed.optional_fields.includes("extra_note"));
    assert.deepEqual(latestOne.versions, ["1.0.1", "1.0.0"]);
    const old = okr(await call("claude", "taiga_workflow_template", { name: "execution-handoff", version: "1.0.0", format: "parsed" }));
    assert.ok(!old.parsed.fields.some((x) => x.key === "extra_note"));
    assert.equal((await call("claude", "taiga_workflow_template", { name: "execution-handoff", version: "9.9.9" })).isError, true);
    writeFileSync(join(tdir, "execution-handoff-v1.0.2.md"), "not a template");
    assert.throws(() => loadTemplates(tdir), /missing front matter/, "a malformed template fails closed (the server refuses to start)");
  } finally { if (prev === undefined) delete process.env.TAIGA_MCP_TEMPLATES_DIR; else process.env.TAIGA_MCP_TEMPLATES_DIR = prev; rmSync(tdir, { recursive: true, force: true }); }
});

// knowledge-base/ is its own repository (gitignored here), so a clean CI clone does not have it: skip instead of failing.
test("RULES.md carries no hard-coded status ids", { skip: !existsSync(new URL("../knowledge-base/RULES.md", import.meta.url)) && "knowledge-base/ is not part of this repository" }, () => {
  const rules = readFileSync(new URL("../knowledge-base/RULES.md", import.meta.url), "utf8");
  assert.doesNotMatch(rules, /(?:To Do|In Progress|GPT Validation|Human Decision|Done|Cancelled|Icebox|Ready|New|Closed|Rejected|Postponed|Needs Info|Ready for test)\s+\d{3}\b/);
});

// ============================ transition matrix ===============================
test("GPT To Do -> In Progress with an Implementation Blueprint: artifact posted and proven BEFORE the status change; MCP owns the markdown and the signature", async () => {
  const r = okr(await tr("gpt", T.prog, blueprint()));
  assert.equal(r.artifact.type, "implementation_blueprint");
  assert.equal(r.identity, "authenticated");
  const w = writes();
  assert.equal(w.length, 2);
  assert.match(w[0].body.comment, /^To Do → In Progress\nSchema: Implementation Blueprint 1\.0\.0\nAuthor: GPT\nModel: Unknown\nEffort: Unknown\nMode: initial\nRound: 1\n/);
  assert.ok(!/\n-- /.test(w[0].body.comment), "governed artifacts have no trailing signature");
  assert.equal(w[1].body.status, T.prog);
  assert.ok(requests.slice(requests.indexOf(w[0]) + 1, requests.indexOf(w[1])).some((x) => x.method === "GET" && x.path.startsWith("/history/")), "no persistence read-back");
});

test("Claude cannot release (To Do -> In Progress), GPT cannot hand off, Claude cannot leave GPT Validation or approve: zero writes", async () => {
  reject(await tr("claude", T.prog, blueprint()), "claude releases", /gpt\/po/);
  await release();
  requests = [];
  reject(await tr("gpt", T.val, handoff({ blueprint_comment_id: bpId() })), "gpt hands off", /claude/);
  await toValidation_after_release();
  requests = [];
  reject(await tr("claude", T.prog, correction({ supersedes_blueprint_comment_id: bpId() })), "claude returns", /gpt\/po/);
  reject(await tr("claude", T.done, approval()), "claude approves", /gpt\/po/);
});
async function toValidation_after_release() { okr(await tr("claude", T.val, handoff({ blueprint_comment_id: bpId() }))); }

test("Claude In Progress -> GPT Validation needs a handoff that points at the CURRENT blueprint", async () => {
  await release();
  reject(await tr("claude", T.val, handoff({ blueprint_comment_id: "nope" })), "wrong blueprint id", /current Blueprint/);
  reject(await tr("claude", T.val, undefined), "no artifact", /artifact/);
  reject(await tr("claude", T.val, handoff({ commits: [] }), {}), "no commits", /commits/);
  reject(await tr("claude", T.val, handoff({ blueprint_comment_id: bpId(), focused_tests: [{ command: "x" }] })), "test without result", /focused_tests/);
  reject(await tr("claude", T.val, handoff({ blueprint_comment_id: bpId() }), { comment: "free text evidence that is long enough to pass the legacy rule" }), "comment + artifact", /free-text/);
  const r = okr(await tr("claude", T.val, handoff({ blueprint_comment_id: bpId() })));
  assert.equal(r.to, "gpt validation");
  assert.match(lastComment().comment, /^In Progress → GPT Validation\nSchema: Execution Handoff 1\.0\.0\nAuthor: Claude Code\nModel: Unknown\nEffort: Unknown\nBlueprint: /);
});

test("correction blueprint: GPT only, round chain and supersedes id are enforced, old blueprint stays in history", async () => {
  await toValidation();
  const first = bpId();
  reject(await tr("gpt", T.prog, blueprint()), "initial mode on a return", /correction/);
  reject(await tr("gpt", T.prog, correction({ supersedes_blueprint_comment_id: "wrong" })), "bad supersedes", new RegExp(first));
  reject(await tr("gpt", T.prog, correction({ supersedes_blueprint_comment_id: first, validation_round: 2 })), "bad round", /validation_round must be 1/);
  reject(await tr("gpt", T.prog, correction({ supersedes_blueprint_comment_id: first, findings: [] })), "no findings", /findings/);
  reject(await tr("gpt", T.prog, correction({ supersedes_blueprint_comment_id: first, findings: [{ id: "F1", evidence: "e", classification: "c", root_cause: "unknown, Claude to investigate", required_correction: "r", affected_owners: "a", regression_scope: "s" }] })), "delegated root cause", /root_cause/);
  okr(await tr("gpt", T.prog, correction({ supersedes_blueprint_comment_id: first })));
  assert.match(lastComment().comment, /^GPT Validation → In Progress\nSchema: Correction Blueprint 1\.0\.0\nAuthor: GPT\nModel: Unknown\nEffort: Unknown\nMode: correction\nRound: 2\nValidation round: 1\nSupersedes: /);
  assert.ok(world.task.comments.some((c) => c.id === first), "older blueprint remains");
  const st = okr(await state("claude"));
  assert.equal(st.current_blueprint.mode, "correction");
  assert.equal(st.current_validation_round, 1);
  assert.notEqual(st.current_blueprint.comment_id, first);
  okr(await tr("claude", T.val, handoff({ blueprint_comment_id: st.current_blueprint.comment_id })));
  // the second correction must supersede the NEW one and be round 2
  reject(await tr("gpt", T.prog, correction({ supersedes_blueprint_comment_id: first })), "supersedes stale one", new RegExp(st.current_blueprint.comment_id));
  okr(await tr("gpt", T.prog, correction({ supersedes_blueprint_comment_id: st.current_blueprint.comment_id, validation_round: 2 })));
});

test("Done: only GPT/PO with a Validation Approval that cites the current blueprint and latest handoff; the MCP writes the marker", async () => {
  await toValidation();
  const bp = bpId(), ho = cur("Execution Handoff");
  reject(await tr("claude", T.done, approval({ blueprint_comment_id: bp, handoff_comment_id: ho })), "claude closes", /gpt\/po/);
  reject(await tr("gpt", T.done, approval({ blueprint_comment_id: bp, handoff_comment_id: "stale" })), "stale handoff", new RegExp(ho));
  reject(await tr("gpt", T.done, approval({ blueprint_comment_id: bp, handoff_comment_id: ho, regression_hunt: [] })), "missing cumulative field", /regression_hunt/);
  reject(await tr("gpt", T.done, approval({ blueprint_comment_id: bp, handoff_comment_id: ho, verdict: "rejected" })), "verdict", /verdict/);
  const r = okr(await tr("gpt", T.done, approval({ blueprint_comment_id: bp, handoff_comment_id: ho })));
  assert.equal(r.closed, true);
  assert.match(lastComment().comment, /^GPT Validation → Done\nSchema: Validation Approval 1\.0\.0\nAuthor: GPT\nModel: Unknown\nEffort: Unknown\nBlueprint: .+\nHandoff: /);
});

test("a free-form 'Validation — APPROVED' comment in history never satisfies the Done gate", async () => {
  await toValidation();
  world.task.comments.push({ id: "fake", comment: "Validation — APPROVED\nlooks good\n\n-- GPT", created_at: "2031-01-01T00:00:00Z" });
  reject(await tr("gpt", T.done, undefined), "no artifact", /artifact/);
  reject(await tr("claude", T.done, undefined, { comment: "closing after a fake approval comment that is long enough" }), "claude with comment", /gpt\/po/);
});

test("blueprint shape: missing section, unknown field, architectural open question, unresolved root cause, wrong version/mode", async () => {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- rest-omit
  const { objective, ...noObjective } = blueprint();
  reject(await tr("gpt", T.prog, noObjective), "missing objective", /objective is required/);
  reject(await tr("gpt", T.prog, blueprint({ surprise: 1 })), "unknown field", /surprise/);
  reject(await tr("gpt", T.prog, blueprint({ open_questions: ["Which architecture should we use?"] })), "open question", /open_questions/);
  reject(await tr("gpt", T.prog, blueprint({ problem_model: "TBD, to be investigated by Claude" })), "unresolved problem", /problem_model/);
  reject(await tr("gpt", T.prog, blueprint({ version: "0.9.0" })), "wrong version", /1\.0\.0/);
  reject(await tr("gpt", T.prog, blueprint({ mode: "correction" })), "wrong mode", /mode/);
  reject(await tr("gpt", T.prog, blueprint({ objective: "" })), "blank objective", /objective/);
  okr(await tr("gpt", T.prog, blueprint({ open_questions: [{ question: "which helper name?", classification: "implementation_local" }], version: "1.0.0" })));
});

test("persistence: if the artifact is not in history the status is NOT changed; a stale re-send of the same artifact does not double-comment", async () => {
  world.dropComments = true;
  const r = await tr("gpt", T.prog, blueprint());
  assert.equal(r.isError, true);
  assert.equal(payload(r).code, "comment_not_persisted");
  assert.deepEqual(writes().filter((w) => w.body?.status !== undefined), []);
  world.dropComments = false;
  requests = [];
  // simulate: comment persisted but status PATCH was lost -> retrying is refused instead of double-commenting
  world.task.comments.push({ id: "pre", comment: "x", created_at: "2000-01-01T00:00:00Z" });
  okr(await tr("gpt", T.prog, blueprint()));
  world.task.entity.status = T.todo;
  const again = await tr("gpt", T.prog, blueprint());
  reject(again, "retry of the same rendered artifact", /NEW/);
});

test("Human Decision Request and Blocker Report: shape, routine-operation rejection, blocked flag set with the status", async () => {
  await release();
  reject(await tr("gpt", T.human, hdr()), "gpt cannot take an In Progress card to Human Decision", /claude/);
  reject(await tr("claude", T.human, hdr({ decision_needed: "Approve the container restart and migration cutover", options: ["restart now", "restart later"] })), "routine operation", /routine execution/);
  reject(await tr("claude", T.human, hdr({ blocked: true })), "blocked without note", /blocked_note/);
  reject(await tr("claude", T.human, hdr({ options: ["only one"] })), "one option", /options/);
  okr(await tr("claude", T.human, hdr({ blocked: true, blocked_note: "gates the next Task" })));
  assert.equal(world.task.entity.is_blocked, true);
  assert.equal(world.task.entity.blocked_note, "gates the next Task");
  assert.equal(world.task.entity.status, T.human);
  // Human Decision belongs to the PO: peers cannot take it away
  reject(await tr("claude", T.prog, poDecision({ instruction_reference: "x" })), "claude resolves HD", /reserved|no transition/);
  reject(await tr("gpt", T.prog, poDecision({ instruction_reference: "x" })), "gpt resolves HD", /reserved|no transition/);
  okr(await tr("po", T.prog, poDecision()));
});

test("blocker report: In Progress -> To Do sets is_blocked with the note", async () => {
  await release();
  reject(await tr("claude", T.todo, blocker({ blocked_note: "" })), "blank note", /blocked_note/);
  okr(await tr("claude", T.todo, blocker()));
  assert.equal(world.task.entity.is_blocked, true);
  assert.equal(world.task.entity.blocked_note, "needs predecessor task");
  assert.equal(world.task.entity.status, T.todo);
});

test("PO override and cancellation need a PO Decision; GPT may cancel only citing an explicit PO instruction", async () => {
  await toValidation();
  okr(await tr("gpt", T.done, approval({ blueprint_comment_id: bpId(), handoff_comment_id: cur("Execution Handoff") })));
  reject(await tr("gpt", T.prog, poDecision()), "gpt reopens Done", /no transition|only the PO/);
  reject(await tr("claude", T.prog, poDecision()), "claude reopens Done", /no transition|only the PO/);
  okr(await tr("po", T.prog, poDecision()));
  assert.equal(world.task.entity.status, T.prog);
  reject(await tr("gpt", T.canc, poDecision()), "gpt cancels without instruction", /instruction_reference/);
  reject(await tr("claude", T.canc, poDecision({ instruction_reference: "PO said so" })), "claude cancels", /gpt\/po/);
  okr(await tr("gpt", T.canc, poDecision({ instruction_reference: "PO, chat 2026-11-01: cancel" })));
});

// ============================ identity ========================================
test("identity is FAIL-CLOSED in a strict workflow project: a synthetic (typed author) caller gains no authority and nothing is mutated", async () => {
  const synthetic = (status, artifact, author, extra = {}) => call(null, "taiga_workflow_transition", { entity: "task", id: 7, status, artifact, author, ...extra });
  const identityRequired = (r, why) => {
    reject(r, why, /authenticated actor identity is required for strict workflow mutations/);
    assert.equal(payload(r).code, "WORKFLOW_IDENTITY_REQUIRED", why);
  };
  // synthetic GPT cannot release
  identityRequired(await synthetic(T.prog, blueprint(), "GPT"), "synthetic GPT release");
  assert.equal(world.task.entity.status, T.todo);
  // synthetic Claude cannot hand off
  await release();
  identityRequired(await synthetic(T.val, handoff({ blueprint_comment_id: bpId() }), "Claude Code"), "synthetic Claude handoff");
  assert.equal(world.task.entity.status, T.prog);
  // synthetic PO cannot override
  identityRequired(await synthetic(T.done, poDecision(), "Andre"), "synthetic PO override");
  identityRequired(await synthetic(T.canc, poDecision(), "Andre"), "synthetic PO cancel");
  // even a commented (legacy-shaped) move or an unknown signer is refused in a strict project
  identityRequired(await synthetic(T.val, undefined, "Kimi (K3)", { comment: "Moving this Task to validation with a long enough comment." }), "commented move");
  // requests: create and answer both need an authenticated actor
  identityRequired(await call(null, "taiga_workflow_request_create", { task_id: 7, to_actor: "gpt", request_type: "analysis", question: "q?", context_evidence: ["c"], blocking: false, author: "Claude Code (x)" }), "synthetic request create");
  const r1 = okr(await rq("claude", { blocking: false }));
  identityRequired(await call(null, "taiga_workflow_request_answer", { task_id: 7, request_id: r1.request_id, answer: "a", evidence: [], resolved: true, author: "GPT" }), "synthetic answer");
  // free comments stay closed
  reject(await call(null, "taiga_task_comment_create", { id: 7, comment: "x", author: "GPT" }), "synthetic free comment", /disabled/);
  assert.equal(world.task.entity.status, T.prog, "no synthetic call moved the card");
});

test("a synthetic caller keeps every read in a strict project; a non-strict project keeps the legacy commented transition", async () => {
  await release();
  const st = okr(await call(null, "taiga_task_workflow_state", { id: 7, author: "GPT" }));
  assert.equal(st.identity, "syntactic"); assert.equal(st.profile, "strict"); assert.equal(st.current_status, "in progress");
  assert.ok(st.allowed_actions_for_caller.length > 0, "the read model still answers");
  assert.ok(okr(await call(null, "taiga_workflow_template", {})).templates.length >= 10);
  assert.notEqual((await call(null, "taiga_task_history", { id: 7 })).isError, true);
  world.task.entity.project = 50; world.task.entity.status = 1;
  const legacy = await call(null, "taiga_workflow_transition", { entity: "task", id: 7, status: 2, author: "Tester", comment: "Started the work: wrote the failing test first." });
  assert.notEqual(legacy.isError, true, JSON.stringify(legacy.content));
});

test("authenticated mode: there is no author field to lie in, and the signature is chosen by the MCP", async () => {
  const server = createTaigaMcpServer(new TaigaClient(), { mode: "authenticated", actor: actorFor("claude") });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const c = new Client({ name: "t", version: "1" });
  await Promise.all([server.connect(a), c.connect(b)]);
  const tools = (await c.listTools()).tools;
  await c.close();
  for (const n of ["taiga_workflow_transition", "taiga_task_workflow_state", "taiga_workflow_request_create", "taiga_workflow_request_answer"]) {
    assert.ok(!("author" in tools.find((t) => t.name === n).inputSchema.properties), `${n} must not take author`);
  }
  // an `author` smuggled in by the caller is ignored: claude stays claude
  await release();
  const r = await call("claude", "taiga_workflow_transition", { entity: "task", id: 7, status: T.val, author: "GPT", artifact: handoff({ blueprint_comment_id: bpId() }) });
  okr(r);
  assert.match(lastComment().comment, /\nAuthor: Claude Code\n/);
  assert.ok(!/\nAuthor: GPT\n/.test(lastComment().comment), "the Author is the authenticated actor, whatever the caller typed");
});

test("actor config: stdio actor, distinct tokens of enough length, no secrets in errors", () => {
  assert.equal(identityFromEnv({}).mode, "syntactic");
  assert.equal(identityFromEnv({ TAIGA_MCP_ACTOR: "gpt" }).actor.display, "GPT");
  assert.equal(identityFromEnv({ TAIGA_MCP_ACTOR: "claude" }).actor.role, "claude");
  assert.throws(() => identityFromEnv({ TAIGA_MCP_ACTOR: "root" }), /TAIGA_MCP_ACTOR/);
  assert.throws(() => loadActorConfig({ TAIGA_MCP_GPT_TOKEN: "short" }), /at least/);
  const secret = "s".repeat(24);
  assert.throws(() => loadActorConfig({ TAIGA_MCP_GPT_TOKEN: secret, TAIGA_MCP_CLAUDE_TOKEN: secret }), (e) => !e.message.includes(secret) && /distinct/.test(e.message));
});

// ============================ free comments & contract lock ====================
test("free Task comments are closed for agents and for syntactic callers; append-only evidence cannot be deleted; PO maintenance comment allowed", async () => {
  for (const role of ["gpt", "claude"]) {
    requests = [];
    reject(await call(role, "taiga_task_comment_create", { id: 7, comment: "side channel handoff" }), `${role} create`, /disabled/);
    reject(await call(role, "taiga_task_comment_delete", { id: 7, comment_id: "c1" }), `${role} delete`, /append-only/);
  }
  reject(await call(null, "taiga_task_comment_create", { id: 7, comment: "x", author: "Andre" }), "syntactic create");
  const r = await call("po", "taiga_task_comment_create", { id: 7, comment: "maintenance note" });
  assert.notEqual(r.isError, true, JSON.stringify(r.content));
  assert.ok(lastComment().comment.endsWith("-- Andre"));
});

test("Issue and Story comments stay available; other projects keep free Task comments; governance OFF frees everything", async () => {
  world.task.entity.project = 50;
  assert.notEqual((await call("claude", "taiga_task_comment_create", { id: 7, comment: "ok in a project without the vocabulary" })).isError, true);
  world.task.entity.project = 49;
  assert.notEqual((await call("claude", "taiga_userstory_comment_create", { id: 7, comment: "story closing summary" })).isError, true);
  writeFileSync(join(dir, "governance.json"), JSON.stringify({ enabled: false }));
  assert.notEqual((await call("claude", "taiga_task_comment_create", { id: 7, comment: "governance OFF" })).isError, true);
});

test("the Task description (execution contract) is locked for agents once the Task is in execution; the PO can amend it", async () => {
  const upd = (role, extra = {}) => call(role, "taiga_tasks_update", { id: 7, version: 3, description: GOOD, ...extra });
  reject(await upd("claude"), "claude in To Do", /execution contract/);
  assert.notEqual((await upd("gpt")).isError, true, "GPT may edit a Task that is still To Do");
  await release();
  requests = [];
  reject(await upd("gpt"), "gpt while In Progress", /execution contract/);
  reject(await upd("claude"), "claude while In Progress", /execution contract/);
  reject(await upd(null), "syntactic while In Progress", /execution contract/);
  assert.notEqual((await upd("po")).isError, true);
  assert.notEqual((await call("claude", "taiga_tasks_update", { id: 7, version: 3, is_blocked: true, blocked_note: "n" })).isError, true, "non-description fields stay usable");
});

// ============================ multiproject & Story parity =====================
test("a project without the workflow vocabulary keeps the generic commented transition and refuses an artifact", async () => {
  world.task.entity.project = 50;
  world.task.entity.status = 1;
  const legacy = await call("claude", "taiga_workflow_transition", { entity: "task", id: 7, status: 2, comment: "Started the work: wrote the failing test first." });
  assert.notEqual(legacy.isError, true, JSON.stringify(legacy.content));
  reject(await tr("claude", 2, handoff()), "artifact in a non-workflow project", /vocabulary/);
  const st = okr(await state("claude"));
  assert.equal(st.profile, "not_applicable");
});

// ============================ Story workflow parity & closure integrity =====================
const sttr = (role, status, artifact, extra = {}) => tr(role, status, artifact, extra, "userstory");
const storyStart = (o = {}) => ({
  type: "story_start", acceptance_criteria: L("AC1"), child_tasks: [{ ref: "#901", purpose: "p", initial_status: "To Do" }], execution_order_or_plan: L("901 then 902"),
  dependencies_or_gates: L("None."), known_constraints: L("None."), known_risks: L("None."), start_decision: "started", ...o,
});
const storyHandoff = (o = {}) => ({
  type: "story_validation_handoff", completed_tasks: [{ ref: "#901", status: "Done", evidence_summary: "ok" }], acceptance_criteria_mapping: [{ criterion: "AC1", evidence: "e", result: "pass" }],
  commits_or_integrations: L("abc123"), cumulative_implementation_summary: L(), task_validation_evidence: L(), integration_evidence: L("None."), focused_or_component_tests: L("node --test"),
  full_ci: "pending", runtime_or_migration_evidence: L("None."), known_limits: L("None."), outstanding_findings: L("None."), readiness_decision: "ready_for_gpt_validation", ...o,
});
const storyApproval = (o = {}) => ({
  type: "story_validation_approval", handoff_comment_id: "SET", completed_tasks_rechecked: L(), acceptance_results: [{ criterion: "AC1", result: "pass", evidence: "e" }],
  cumulative_diff_or_integration_review: "reviewed", contracts_and_adrs_rechecked: L(), tests_verified: L(), ci_or_final_gate_evidence: L("pending"), runtime_evidence_verified: L("None."),
  regression_hunt: L(), pending_items: L("None."), issues_created: L("None."), known_limits: L("None."), verdict: "approved", ...o,
});
const storyCorrection = (o = {}) => ({
  type: "story_correction", handoff_comment_id: "SET", findings: [{ id: "F1", evidence: "e", required_correction: "fix" }], corrective_work: L("new Task"), revalidation_scope: L("AC1"), known_limits: L("None."), ...o,
});
const sc = () => world.userstory.comments;
const lastStory = () => sc().at(-1);
const storyWrites = () => writes().filter((w) => w.path.startsWith("/userstories"));
const lastHandoff = () => sc().filter((c) => (c.comment.split("\n")[1] ?? "").startsWith("Schema: Story Validation Handoff ")).at(-1).id;
const lastReadiness = () => sc().filter((c) => (c.comment.split("\n")[1] ?? "").startsWith("Schema: Story Readiness Promotion ")).at(-1).id;
const storyPatch = () => requests.filter((r) => r.method === "PATCH" && r.path.startsWith("/userstories")).at(-1)?.body;
async function storyInProgress() { okr(await sttr("gpt", S.prog, storyStart())); }
async function storyInValidation() { await storyInProgress(); okr(await sttr("gpt", S.val, storyHandoff())); }

test("Story lifecycle: Ready -> In Progress -> GPT Validation -> Done is typed, GPT/PO-owned, and closure is derived from status", async () => {
  // Ready -> In Progress
  reject(await call("gpt", "taiga_workflow_transition", { entity: "userstory", id: 7, status: S.prog, comment: "Starting the Story: Tasks are ordered and the first one is released." }), "commented start", /artifact/);
  reject(await sttr("claude", S.prog, storyStart()), "claude starts a story", /gpt\/po/);
  reject(await sttr("gpt", S.prog, storyHandoff()), "wrong artifact for start", /story_start/);
  const start = okr(await sttr("gpt", S.prog, storyStart()));
  assert.equal(start.artifact.type, "story_start");
  assert.deepEqual([storyPatch().status, "is_closed" in storyPatch()], [S.prog, false]);
  assert.match(lastStory().comment, /^Ready → In Progress\nSchema: Story Start 1\.0\.0\nAuthor: GPT\n/);
  // In Progress -> GPT Validation
  reject(await sttr("claude", S.val, storyHandoff()), "claude promotes a story", /gpt\/po/);
  reject(await sttr("gpt", S.val, { ...storyHandoff(), blueprint_comment_id: "c1" }), "no Task-only blueprint id on a story handoff", /unknown artifact field blueprint_comment_id/);
  okr(await sttr("po", S.val, storyHandoff()));
  assert.deepEqual([storyPatch().status, "is_closed" in storyPatch()], [S.val, false]);
  const ho = lastHandoff();
  // GPT Validation -> Done
  reject(await sttr("claude", S.done, storyApproval({ handoff_comment_id: ho })), "claude closes a story", /gpt\/po/);
  reject(await sttr("gpt", S.done, approval({ handoff_comment_id: ho })), "task-level approval is not the story approval", /story_validation_approval/);
  const done = okr(await sttr("gpt", S.done, storyApproval({ handoff_comment_id: ho })));
  assert.equal(done.closed, true);
  assert.deepEqual([storyPatch().status, "is_closed" in storyPatch()], [S.done, false]);
  assert.match(lastStory().comment, /^GPT Validation → Done\nSchema: Story Validation Approval 1\.0\.0\n/);
});

test("UUID-shaped ids on the Story path: the exact Story Validation Handoff id passes, a one-character-different or earlier id fails closed", async () => {
  world.uuidIds = true;
  try {
    await storyInProgress();
    okr(await sttr("po", S.val, storyHandoff()));
    const ho = lastHandoff();
    assert.match(ho, /^[0-9a-f]{8}-dd90-11f1-84e4-cacb139fa1ca$/);
    reject(await sttr("gpt", S.done, storyApproval({ handoff_comment_id: ho.replace(/^./, ho[0] === "a" ? "b" : "a") })), "one-character-different Story handoff id", /latest Story Validation Handoff comment id/);
    reject(await sttr("gpt", S.done, storyApproval({ handoff_comment_id: sc()[0].id })), "an earlier comment id", /latest Story Validation Handoff comment id/);
    okr(await sttr("gpt", S.done, storyApproval({ handoff_comment_id: ho })));
  } finally { world.uuidIds = false; }
});

test("provenance fixture (read-only copy of Bridge Task 63): its real Blueprint and Handoff ids satisfy id equality and ordering, so the current code accepts the approval", async () => {
  // Header lines copied from the persisted Bridge comments; the Bridge card itself is never touched, this is a local mock.
  const bp = "ec762686-dc07-11f1-8772-fe9b29cf2c2b", ho = "0c159b84-dc08-11f1-8276-fe9b29cf2c2b";
  world.task.comments.push(
    { id: bp, created_at: "2026-11-09T06:36:41.524Z", comment: "To Do → In Progress\nSchema: Implementation Blueprint 1.0.0\nAuthor: GPT\nModel: GPT-5.6 Sol\nEffort: Medium\nMode: initial\nRound: 1\n\n**Objective**\nx" },
    { id: ho, created_at: "2026-11-09T06:37:34.578Z", comment: `In Progress → GPT Validation\nSchema: Execution Handoff 1.0.0\nAuthor: Claude Code\nModel: claude-sonnet-5-5\nEffort: Low\nBlueprint: ${bp}\n\n**Branch**\nNone` },
  );
  world.task.entity.status = T.val;
  const st = okr(await state("gpt"));
  assert.equal(st.current_blueprint.comment_id, bp);
  assert.equal(st.current_handoff.comment_id, ho);
  reject(await tr("gpt", T.done, approval({ blueprint_comment_id: ho, handoff_comment_id: ho })), "swapped ids", /current Blueprint comment id/);
  okr(await tr("gpt", T.done, approval({ blueprint_comment_id: bp, handoff_comment_id: ho })));
});

test("Story child-Task gate: every child must be semantically terminal (Done or Cancelled), checked at call time; a rejection mutates nothing", async () => {
  await storyInProgress();
  const before = sc().length;
  const cases = [["To Do", T.todo], ["In Progress", T.prog], ["GPT Validation", T.val], ["Human Decision", T.human], ["Request", T.req]];
  for (const [name, status] of cases) {
    world.storyTasks = [{ id: 1001, ref: 901, status: T.done }, { id: 1002, ref: 902, status }];
    reject(await sttr("gpt", S.val, storyHandoff()), name, new RegExp(`Task #902 is \\\\"${name}\\\\"`));
    assert.equal(sc().length, before, `${name}: no Story artifact`);
    assert.equal(world.userstory.entity.status, S.prog, `${name}: Story status untouched`);
  }
  world.storyTasks = [];
  reject(await sttr("gpt", S.val, storyHandoff()), "no child task", /no child Task/);
  // Done and Cancelled are both terminal (PO decision, Issue #335): a Cancelled child no longer blocks the manual handoff either
  world.storyTasks = [{ id: 1001, ref: 901, status: T.done }, { id: 1002, ref: 902, status: T.canc }];
  okr(await sttr("gpt", S.val, storyHandoff()));
  assert.equal(world.userstory.entity.status, S.val);
});

test("Story: a Task reaching Done with a non-terminal sibling never touches the Story", async () => {
  await storyInProgress();
  world.storyTasks = [{ id: 1001, ref: 901, status: T.done }, { id: 1002, ref: 902, status: T.prog }];
  await toValidation();
  requests = [];
  okr(await tr("gpt", T.done, approval({ blueprint_comment_id: bpId(), handoff_comment_id: cur("Execution Handoff") })));
  assert.equal(requests.filter((r) => r.method !== "GET" && !r.path.startsWith("/tasks")).length, 0, "no write outside the Task");
  assert.equal(requests.filter((r) => r.path.startsWith("/userstories") && r.method !== "GET").length, 0);
  assert.equal(world.userstory.entity.status, S.prog);
});

test("Story correction: returns to In Progress still open; an approval against a stale (pre-correction) handoff is refused", async () => {
  await storyInValidation();
  const h1 = lastHandoff();
  reject(await sttr("claude", S.prog, storyCorrection({ handoff_comment_id: h1 })), "claude corrects a story", /gpt\/po/);
  reject(await sttr("gpt", S.prog, storyCorrection({ handoff_comment_id: "nope" })), "wrong handoff id on correction", /latest Story Validation Handoff/);
  okr(await sttr("gpt", S.prog, storyCorrection({ handoff_comment_id: h1 })));
  assert.deepEqual([storyPatch().status, "is_closed" in storyPatch()], [S.prog, false]);
  assert.match(lastStory().comment, /^GPT Validation → In Progress\nSchema: Story Correction 1\.0\.0\n/);
  // a Story forced back into validation without a new handoff cannot be approved on the old one
  world.userstory.entity.status = S.val;
  reject(await sttr("gpt", S.done, storyApproval({ handoff_comment_id: h1 })), "stale handoff after correction", /predates the latest Story Correction/);
  world.userstory.entity.status = S.prog;
  okr(await sttr("gpt", S.val, storyHandoff()));
  const h2 = lastHandoff();
  assert.notEqual(h1, h2);
  reject(await sttr("gpt", S.done, storyApproval({ handoff_comment_id: h1 })), "old handoff", new RegExp(`latest Story Validation Handoff comment id ${h2}`));
  okr(await sttr("gpt", S.done, storyApproval({ handoff_comment_id: h2 })));
  assert.equal(world.userstory.entity.status, S.done);
});

test("Story approval without any Story handoff is refused", async () => {
  world.userstory.entity.status = S.val;
  reject(await sttr("gpt", S.done, storyApproval({ handoff_comment_id: "c1" })), "no handoff", /never handed off/);
});

test("closure integrity: direct is_closed is refused for Stories and Tasks of a governed strict project, and only there", async () => {
  reject(await call("claude", "taiga_userstories_update", { id: 7, version: 3, is_closed: true }), "story is_closed", /status is authoritative/);
  reject(await call("po", "taiga_userstories_update", { id: 7, version: 3, is_closed: false }), "story is_closed even for the PO", /derived/);
  reject(await call("claude", "taiga_tasks_update", { id: 7, version: 3, is_closed: true }), "task is_closed", /status is authoritative/);
  reject(await call("claude", "taiga_userstories_create", { project: 49, subject: "s", is_closed: true }), "story born closed", /status is authoritative/);
  reject(await call("claude", "taiga_tasks_create", { project: 49, subject: "s", is_closed: true }), "task born closed", /status is authoritative/);
  assert.notEqual((await call("claude", "taiga_userstories_update", { id: 7, version: 3, is_blocked: true, blocked_note: "n" })).isError, true, "other fields stay usable");
  // non-strict story vocabulary keeps legacy behaviour
  world.noReadyStory = true;
  assert.notEqual((await call("claude", "taiga_userstories_update", { id: 7, version: 3, is_closed: true })).isError, true, "non-strict project");
  // governance OFF is free
  world.noReadyStory = false;
  writeFileSync(join(dir, "governance.json"), JSON.stringify({ enabled: false }));
  assert.notEqual((await call("claude", "taiga_userstories_update", { id: 7, version: 3, is_closed: true })).isError, true, "governance OFF");
  assert.notEqual((await call("claude", "taiga_tasks_update", { id: 7, version: 3, is_closed: true })).isError, true, "governance OFF task");
});

test("closure integrity: a Task status definition that contradicts the derived closure fails closed before any write; a Story status definition is not consulted", async () => {
  await toValidation();
  world.statusClosed = { task5: false };
  const t = await tr("gpt", T.done, approval({ blueprint_comment_id: bpId(), handoff_comment_id: cur("Execution Handoff") }));
  reject(t, "Task Done configured open", /is_closed=false.*require is_closed=true/);
  assert.equal(payload(t).code, "WORKFLOW_INTEGRITY_FAILURE");
  world.statusClosed = { userstory13: false, userstory11: true };
  await storyInValidation();
  okr(await sttr("gpt", S.done, storyApproval({ handoff_comment_id: lastHandoff() })));
  assert.equal(world.userstory.entity.status, S.done);
});

test("closure integrity: a Story reread proves the status only; a Task reread still proves is_closed", async () => {
  await storyInValidation();
  const ho = lastHandoff();
  world.userstory.entity.is_closed = true; // upstream already closed it; the write cannot change that
  okr(await sttr("gpt", S.done, storyApproval({ handoff_comment_id: ho })));
  world.dropStatus = true; world.userstory.entity.status = S.val;
  const b = await sttr("gpt", S.done, storyApproval({ handoff_comment_id: ho, cumulative_diff_or_integration_review: "reviewed again" }));
  assert.equal(b.isError, true);
  assert.match(payload(b).message, /status is 12, expected 13/);
  world.dropStatus = false;
  // Task closure stays strict: the reread disagreeing on is_closed is a hard failure
  const upstream = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const res = await upstream(url, init);
    if ((init.method ?? "GET") === "PATCH" && /\/tasks\/7$/.test(String(url))) world.task.entity.is_closed = false;
    return res;
  };
  await toValidation();
  const c = await tr("gpt", T.done, approval({ blueprint_comment_id: bpId(), handoff_comment_id: cur("Execution Handoff") }));
  assert.equal(c.isError, true);
  assert.equal(payload(c).code, "WORKFLOW_INTEGRITY_FAILURE");
  assert.match(payload(c).message, /is_closed is false, expected true/);
});

test("Story escape states keep the commented path but derive closure from status (Cancelled closes, Human Decision stays open)", async () => {
  await storyInProgress();
  const note = "Escalating the Story to the PO because a product choice is unresolved.";
  okr(await call("gpt", "taiga_workflow_transition", { entity: "userstory", id: 7, status: S.human, comment: note }));
  assert.deepEqual([storyPatch().status, "is_closed" in storyPatch()], [S.human, false]);
  okr(await call("po", "taiga_workflow_transition", { entity: "userstory", id: 7, status: S.canc, comment: "Cancelling the Story by explicit PO decision after review." }));
  assert.deepEqual([storyPatch().status, "is_closed" in storyPatch()], [S.canc, false]);
  // governance cannot be bypassed by a generic status write either
  reject(await call("gpt", "taiga_userstories_update", { id: 7, version: 3, status: S.done }), "generic status", /taiga_workflow_transition/);
});

test("Story vocabulary: missing or ambiguous names fail closed; non-strict Story projects keep the legacy path", async () => {
  world.userstory.entity.status = S.ready;
  world.noReadyStory = true;
  reject(await sttr("gpt", S.prog, storyStart()), "no Ready status", /vocabulary/);
  world.noReadyStory = false; world.dupStoryDone = true;
  reject(await sttr("gpt", S.prog, storyStart()), "ambiguous Done", /ambiguous/);
});

test("Story artifacts: canonical references normalize, templates parse, and the handoff declares no Task-only blueprint field", async () => {
  const set = loadTemplates();
  for (const n of ["story-start", "story-validation-handoff", "story-validation-approval", "story-correction"]) assert.equal(latest(set, n).version, "1.0.0", n);
  assert.ok(!latest(set, "story-validation-handoff").fields.some((f) => /blueprint/.test(f.key) || f.taskOnly));
  assert.ok(latest(set, "story-validation-approval").fields.some((f) => f.key === "handoff_comment_id" && f.header && !f.optional));
  await storyInProgress();
  okr(await sttr("gpt", S.val, storyHandoff({ cumulative_implementation_summary: ["Delivered Task #905 and Issue #1"] })));
  assert.ok(lastStory().comment.includes("Task 0190aaaa-0000-7000-8000-000000000905 (#905)"), lastStory().comment);
});

test("Story and Epic policy: Epic keeps the shared card pairs; closure semantics exist only for governed Story/Task statuses", async () => {
  const { resolveTransition, closureFor } = await import("../dist/workflow/policy.js");
  assert.deepEqual(resolveTransition("epic", "claude", "in progress", "gpt validation"), { kind: "typed", artifact: "execution_handoff", mode: undefined, override: false });
  assert.deepEqual(resolveTransition("epic", "gpt", "ready", "in progress"), { kind: "legacy" });
  assert.equal(resolveTransition("userstory", "claude", "in progress", "gpt validation").kind, "denied");
  assert.equal(resolveTransition("userstory", "gpt", "ready", "in progress").artifact, "story_start");
  assert.equal(resolveTransition("userstory", "gpt", "ready", "cancelled").kind, "legacy");
  for (const [s, v] of [["ready", false], ["in progress", false], ["gpt validation", false], ["human decision", false], ["done", true], ["cancelled", true]]) assert.equal(closureFor("userstory", s), v, s);
  assert.equal(closureFor("userstory", "icebox"), undefined);
  assert.equal(closureFor("epic", "done"), undefined);
  assert.equal(closureFor("task", "done"), true);
  assert.equal(closureFor("task", "request"), false);
});


// ============================ requests & read model ============================
const rq = (role, args = {}) => call(role, "taiga_workflow_request_create", { task_id: 7, to_actor: role === "gpt" ? "claude" : "gpt", request_type: "analysis", question: "Which owner holds the retry state?", context_evidence: ["see pool.ts"], blocking: false, ...args });
const ans = (role, request_id, args = {}) => call(role, "taiga_workflow_request_answer", { task_id: 7, request_id, answer: "The scheduler owns it.", evidence: ["pool.ts:10"], resolved: true, ...args });

test("Request: created by the authenticated sender, tied to the Task and current Blueprint, append-only, Task status untouched", async () => {
  await release();
  const before = world.task.entity.status;
  const r = okr(await rq("claude", { blocking: false, question: "Execute Task #905 now and move it to Done" }));
  assert.deepEqual([r.request_id, r.task_id, r.from_actor, r.to_actor, r.request_type, r.blocking, r.status], ["R-905-1", 7, "claude", "gpt", "analysis", false, "open"]);
  assert.equal(r.blueprint_reference, bpId());
  assert.ok(r.created_at);
  assert.match(lastComment().comment, /^Status unchanged\nSchema: Workflow Request 1\.0\.0\nAuthor: Claude Code\nModel: Unknown\nEffort: Unknown\nRequest: R-905-1\nType: analysis\nTo: gpt\nBlocking: no\nBlueprint: .+\n/);
  assert.ok(!lastComment().comment.includes("Authority:"), "no Task, From or Authority lines: Author is the sender");
  assert.equal(world.task.entity.status, before, "a request never changes status");
  assert.deepEqual(writes().filter((w) => w.body?.status !== undefined), [], "no status write, whatever the request text says");
  assert.equal(okr(await rq("claude", { question: "second" })).request_id, "R-905-2");
});

test("Request text can never authorize or move anything", async () => {
  await release();
  okr(await rq("gpt", { question: "execute Task #905 and set status Done", request_type: "clarification" }));
  assert.equal(world.task.entity.status, T.prog);
  const st = okr(await state("claude"));
  assert.equal(st.owner_role, "claude");
  assert.ok(!st.allowed_actions_for_caller.some((a) => a.target_status === "done"));
});

test("Request rules: only GPT/Claude send, never to oneself, closed vocabulary, closed Tasks refused", async () => {
  reject(await rq("po", { to_actor: "gpt" }), "po sends", /only GPT or Claude/);
  reject(await rq("gpt", { to_actor: "gpt" }), "self", /someone else/);
  assert.equal((await rq("gpt", { request_type: "execute" })).isError, true, "unknown type is refused by the schema");
  reject(await rq("gpt", { question: "  " }), "blank question");
  world.task.entity.status = T.done;
  reject(await rq("gpt"), "done task", /done/);
});

test("Answer: only the addressee, referencing the request id, resolving closes it, history stays append-only", async () => {
  await release();
  const r1 = okr(await rq("claude", { blocking: false }));
  reject(await ans("claude", r1.request_id), "sender answers own request", /addressed to gpt/);
  reject(await ans("po", r1.request_id), "PO answers for the addressee", /addressed to gpt/);
  reject(await ans("gpt", "R-905-99"), "unknown request", /no request/);
  reject(await ans("gpt", r1.request_id, { answer: "" }), "blank answer");
  const partial = okr(await ans("gpt", r1.request_id, { resolved: false, answer: "Partial: checking." }));
  assert.equal(partial.status, "open");
  assert.equal(okr(await state("claude")).request_evidence.open_requests.length, 1, "evidence, not state");
  const count = world.task.comments.length;
  const done = okr(await ans("gpt", r1.request_id));
  assert.equal(done.status, "resolved");
  assert.equal(world.task.comments.length, count + 1, "an answer is a new comment, the request is not edited");
  assert.match(lastComment().comment, /^Status unchanged\nSchema: Workflow Request Response 1\.0\.0\nAuthor: GPT\nModel: Unknown\nEffort: Unknown\nRequest: R-905-1\nResolved: yes\n/);
  reject(await ans("gpt", r1.request_id), "already resolved", /already resolved/);
  const st = okr(await state("claude"));
  assert.equal(st.request_evidence.open_requests.length, 0);
  assert.equal(st.has_blocking_request, undefined);
});

test("taiga_task_workflow_state: status, owner, current Blueprint, round, open/blocking Requests with who must answer, allowed and denied actions per actor", async () => {
  await toValidation();
  const bp = bpId();
  okr(await rq("claude", { blocking: true, to_actor: "gpt" }));
  const c = okr(await state("claude"));
  assert.equal(c.profile, "strict");
  assert.equal(c.current_status, "gpt validation");
  assert.equal(c.owner_role, "gpt");
  assert.equal(c.actor.role, "claude");
  assert.equal(c.identity, "authenticated");
  assert.equal(c.current_blueprint.comment_id, bp);
  assert.equal(c.current_validation_round, 0);
  assert.equal(c.has_blocking_request, undefined, "no history-derived blocker in the state");
  assert.equal(c.open_requests, undefined, "requests are evidence, listed under request_evidence");
  assert.equal(c.request_evidence.open_requests[0].must_answer, "gpt");
  assert.equal(c.request_evidence.open_requests[0].blueprint_reference, bp);
  assert.equal(c.request_evidence.open_requests[0].question, "Which owner holds the retry state?");
  assert.deepEqual(c.request_evidence.open_requests[0].context_evidence, ["see pool.ts"]);
  assert.deepEqual(c.allowed_actions_for_caller.map((a) => a.action), ["create_workflow_request"]);
  const denied = c.denied_for_caller.map((d) => `${d.target_status}:${d.why}`).join("|");
  assert.match(denied, /in progress:"gpt validation" -> "in progress" is reserved for gpt\/po/);
  assert.match(denied, /done:"gpt validation" -> "done" is reserved for gpt\/po/);
  assert.ok(!/gpt validation:/.test(denied.replace(/-> "gpt validation"/g, "")), "the current status is not listed as a target");
  const g = okr(await state("gpt"));
  assert.ok(g.allowed_actions_for_caller.some((a) => a.action === "workflow_transition" && a.target_status === "done"));
  assert.ok(g.allowed_actions_for_caller.some((a) => a.action === "answer_workflow_request" && a.blocking === true));
  const p = okr(await state(null, { author: "Andre" }));
  assert.equal(p.identity, "syntactic");
});

test("the read model is read-only: no write reaches Taiga", async () => {
  await release();
  requests = [];
  okr(await state("gpt"));
  assert.deepEqual(writes(), []);
});

// ============================ status bypass through bulk tools ================
test("bulk tools cannot move or create cards in a chosen status while governance is ON", async () => {
  const drop = (status_id) => call("gpt", "taiga_tasks_bulk_update_taskboard_order", { project_id: 49, bulk_tasks: [[7, 1]], status_id });
  // Issue #244: in a strict project the bulk order tools are refused outright (taiga_move kind task is the one precedence operation), which also closes the status drop.
  reject(await drop(T.done), "taskboard drop into another column", /taiga_move/);
  reject(await drop(T.todo), "same column reordering goes through taiga_move", /taiga_move/);
  reject(await call("gpt", "taiga_tasks_bulk_update_taskboard_order", { project_id: 49, bulk_tasks: [[7, 1]] }), "plain taskboard reorder", /taiga_move/);
  reject(await call("gpt", "taiga_tasks_bulk_create", { project_id: 49, us_id: 1, bulk_tasks: "a", status_id: T.done }), "bulk create in Done", /taiga_workflow_transition/);
  assert.notEqual((await call("gpt", "taiga_tasks_bulk_create", { project_id: 49, us_id: 1, bulk_tasks: "a" })).isError, true);
  writeFileSync(join(dir, "governance.json"), JSON.stringify({ enabled: false }));
  assert.notEqual((await drop(T.done)).isError, true, "governance OFF is free");
});

// ============================ HTTP actor authentication ========================
import { startHttpServer } from "../dist/http.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

test("HTTP: static bearer tokens resolve the actor; missing/unknown token is 401; tokens are never echoed", async () => {
  globalThis.fetch = realFetch; // real sockets here; the fake Taiga client below never touches the network
  const tokens = { gpt: "g".repeat(20), claude: "c".repeat(20), po: "p".repeat(20) };
  const config = loadActorConfig({ TAIGA_MCP_GPT_TOKEN: tokens.gpt, TAIGA_MCP_CLAUDE_TOKEN: tokens.claude, TAIGA_MCP_PO_TOKEN: tokens.po });
  const fake = { get: async (path) => (path === "/tasks/7" ? { id: 7, ref: 905, project: 49, status: 1 } : path === "/task-statuses" ? TASK_STATUSES : []) };
  const http = await startHttpServer({ host: "127.0.0.1", port: 0, path: "/mcp" }, fake, config);
  const url = new URL(`http://127.0.0.1:${http.address().port}/mcp`);
  const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "c", version: "1" } } };
  const post = (headers) => fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers }, body: JSON.stringify(init) });
  try {
    assert.equal((await post({})).status, 401);
    assert.equal((await post({ authorization: "Bearer nope-nope-nope-nope-nope" })).status, 401);
    assert.equal((await post({ authorization: `Basic ${tokens.gpt}` })).status, 401);
    const bad = await post({ authorization: "Bearer wrong-token-value-1234" });
    assert.ok(!(await bad.text()).includes(tokens.gpt));
    for (const [role, display] of [["gpt", "GPT"], ["claude", "Claude Code"], ["po", "Andre"]]) {
      const client = new Client({ name: "t", version: "1" });
      await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { authorization: `Bearer ${tokens[role]}` } } }));
      const r = await client.callTool({ name: "taiga_task_workflow_state", arguments: { id: 7 } });
      await client.close();
      const st = JSON.parse(r.content[0].text);
      assert.deepEqual([st.identity, st.actor.role, st.actor.display], ["authenticated", role, display]);
      assert.ok(!r.content[0].text.includes(tokens[role]));
    }
  } finally { http.close(); }
});

test("HTTP: a fixed stdio actor cannot be combined with the HTTP transport", () => {
  assert.throws(() => startHttpServer({ host: "127.0.0.1", port: 0, path: "/mcp" }, {}, loadActorConfig({ TAIGA_MCP_ACTOR: "gpt" })), /stdio only/);
});

// ============================ Bridge notification (best effort, after Taiga) ====
function fakeNotifier(exitCode = 0) {
  const log = join(dir, "notify.log");
  const script = join(dir, "notify.ts");
  writeFileSync(script, `import { appendFileSync } from "node:fs"; appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: process.argv.slice(2), leaked: Object.keys(process.env).filter((k) => k.startsWith("TAIGA_")) }) + "\\n"); process.exit(${exitCode});`);
  process.env.TAIGA_MCP_NOTIFY_COMMAND = JSON.stringify([process.execPath, script, "notify"]);
  return () => { try { return readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
}
afterEach(() => { delete process.env.TAIGA_MCP_NOTIFY_COMMAND; });

test("notifications: every ownership event emits one typed pointer AFTER Taiga persisted it; no payload, no credentials in the child", async () => {
  const sent = fakeNotifier();
  const argv = () => sent().map((s) => s.argv.slice(1).join(" "));
  const r = okr(await tr("gpt", T.prog, blueprint()));
  assert.equal(r.notification, "sent");
  assert.equal(argv().at(-1), "--type TASK_RELEASED --task 905 --project 49 --from gpt --to claude --status In Progress");
  okr(await tr("claude", T.val, handoff({ blueprint_comment_id: bpId() })));
  assert.match(argv().at(-1), /^--type TASK_MOVED_TO_GPT_VALIDATION --task 905 --project 49 --from claude --to gpt --status GPT Validation$/);
  okr(await tr("gpt", T.prog, correction({ supersedes_blueprint_comment_id: bpId() })));
  assert.match(argv().at(-1), /^--type TASK_RETURNED_TO_IN_PROGRESS --task 905 --project 49 --from gpt --to claude/);
  okr(await tr("claude", T.human, hdr()));
  assert.match(argv().at(-1), /^--type TASK_MOVED_TO_HUMAN_DECISION --task 905 --project 49 --from claude --to gpt/);
  assert.ok(sent().every((s) => s.leaked.length === 0), "the child never sees TAIGA_* credentials");
  assert.ok(sent().every((s) => s.argv.join(" ").length < 160), "identifiers only");
});

test("notifications: Done, requests (opened / answered / resolved) and PO overrides", async () => {
  const sent = fakeNotifier();
  const last = () => sent().at(-1).argv.slice(1).join(" ");
  await toValidation();
  sent(); // flush reads
  okr(await rq("claude", { blocking: true }));
  assert.equal(last(), "--type WORKFLOW_REQUEST_OPENED --task 905 --project 49 --from claude --to gpt --request R-905-1");
  okr(await ans("gpt", "R-905-1", { resolved: false }));
  assert.equal(last(), "--type WORKFLOW_REQUEST_ANSWERED --task 905 --project 49 --from gpt --to claude --request R-905-1");
  okr(await ans("gpt", "R-905-1"));
  assert.equal(last(), "--type WORKFLOW_REQUEST_RESOLVED --task 905 --project 49 --from gpt --to claude --request R-905-1");
  const count = sent().length;
  okr(await rq("claude", { to_actor: "po" }));
  assert.equal(sent().length, count, "the PO is not a Bridge party: no notification");
  okr(await tr("gpt", T.done, approval({ blueprint_comment_id: bpId(), handoff_comment_id: cur("Execution Handoff") })));
  assert.match(last(), /^--type TASK_DONE --task 905 --project 49 --from gpt --to claude --status Done$/);
  const n = sent().length;
  okr(await tr("po", T.prog, poDecision()));
  assert.equal(sent().length, n, "a PO override has no Bridge notice");
});

test("notifications: an approved Story Done emits exactly one STORY_DONE pointer after persistence; other Story moves, rejections and failures stay safe", async () => {
  const sent = fakeNotifier();
  const argv = () => sent().map((s) => s.argv.slice(1).join(" "));
  await storyInProgress();
  const n0 = argv().length;
  assert.equal(n0, 0, "Story start and handoff are silent");
  okr(await sttr("gpt", S.val, storyHandoff()));
  assert.equal(argv().length, n0, "Story handoff emits nothing");
  const h = lastHandoff();
  reject(await sttr("gpt", S.done, storyApproval({ handoff_comment_id: "nope" })), "rejected Story Done", /latest Story Validation Handoff/);
  assert.equal(argv().length, n0, "a rejected Story Done emits nothing");
  const r = okr(await sttr("gpt", S.done, storyApproval({ handoff_comment_id: h })));
  assert.equal(world.userstory.entity.status, S.done, "persisted before the pointer");
  assert.equal(r.notification, "sent");
  assert.deepEqual(argv().slice(n0), ["--type STORY_DONE --story 12 --project 49 --from gpt --to claude --status Done"], "exactly one typed pointer: Story + project identity, no --task");
  // a failing notifier never undoes the completed Story
  world.userstory.entity.status = S.val;
  process.env.TAIGA_MCP_NOTIFY_COMMAND = JSON.stringify(["/definitely/not/a/binary"]);
  assert.equal(okr(await sttr("gpt", S.done, storyApproval({ handoff_comment_id: h, cumulative_diff_or_integration_review: "re-reviewed" }))).notification, "failed");
  assert.equal(world.userstory.entity.status, S.done);
});

test("notifications: a failing or broken notifier never undoes a valid Taiga transition; rejected operations notify nothing", async () => {
  fakeNotifier(1);
  const r = okr(await tr("gpt", T.prog, blueprint()));
  assert.equal(r.notification, "failed");
  assert.equal(world.task.entity.status, T.prog, "the transition stands");
  process.env.TAIGA_MCP_NOTIFY_COMMAND = "not json";
  assert.equal(okr(await tr("claude", T.val, handoff({ blueprint_comment_id: bpId() }))).notification, "failed");
  process.env.TAIGA_MCP_NOTIFY_COMMAND = JSON.stringify(["/definitely/not/a/binary"]);
  assert.equal(okr(await tr("gpt", T.done, approval({ blueprint_comment_id: bpId(), handoff_comment_id: cur("Execution Handoff") }))).notification, "failed");
  const emitted = fakeNotifier();
  const n0 = emitted().length;
  reject(await tr("claude", T.prog, blueprint()), "rejected reopen", /no transition/);
  reject(await tr("gpt", T.done, undefined), "no artifact");
  assert.equal(emitted().length, n0, "nothing was emitted for rejected calls");
  delete process.env.TAIGA_MCP_NOTIFY_COMMAND;
  assert.equal(okr(await tr("po", T.prog, poDecision())).notification, "disabled");
});

// ============================ the Request status ================================
const reqArt = (o = {}) => ({ type: "workflow_request", request_type: "analysis", to_actor: "gpt", blocking: true, question: "Which owner holds the retry state?", context_evidence: ["see pool.ts:10"], ...o });
const resume = (o = {}) => ({ type: "request_resume", request_id: "R-905-1", response_comment_id: "SET", applied_answer: "Use the scheduler owner as the answer says.", blueprint_deviation: "None.", ...o });
const toRequest = async () => { await release(); return okr(await tr("claude", T.req, reqArt())); };
const responseId = () => bySchema("Workflow Request Response").at(-1).id;

test("Request status: Claude In Progress -> Request with a valid blocking request to GPT, tied to the Blueprint in force; the card is GPT-owned and Claude may not implement", async () => {
  await release();
  const r = okr(await tr("claude", T.req, reqArt()));
  assert.equal(r.to, "request"); assert.equal(r.request_id, "R-905-1");
  assert.match(lastComment().comment, new RegExp(`^In Progress → Request\\nSchema: Workflow Request 1\\.0\\.0\\nAuthor: Claude Code\\nModel: Unknown\\nEffort: Unknown\\nRequest: R-905-1\\nType: analysis\\nTo: gpt\\nBlocking: yes\\nBlueprint: ${bpId()}\\n`));
  assert.equal(world.task.entity.status, T.req);
  const st = okr(await state("claude"));
  assert.equal(st.current_status, "request"); assert.equal(st.owner_role, "gpt");
  assert.deepEqual([st.request_status.in_request, st.request_status.awaiting_response_from, st.request_status.claude_may_implement], [true, "gpt", false]);
  assert.equal(st.has_blocking_request, undefined);
  assert.equal(st.request_evidence.open_requests[0].blueprint_reference, bpId());
  // Claude can do nothing but ask for more / pause: no handoff, no done, no release
  assert.deepEqual(st.allowed_actions_for_caller.filter((a) => a.action === "workflow_transition").map((a) => a.target_status).sort(), ["in progress"]);
});

test("Request status: only Claude, only from In Progress, only to gpt, only blocking, with the full request", async () => {
  await release();
  reject(await tr("gpt", T.req, reqArt()), "gpt enters Request", /claude/);
  reject(await tr("claude", T.req, reqArt({ to_actor: "claude" })), "to claude", /gpt/);
  reject(await tr("claude", T.req, reqArt({ to_actor: "po" })), "to po", /gpt/);
  reject(await tr("claude", T.req, reqArt({ blocking: false })), "non-blocking", /blocking must be true/);
  reject(await tr("claude", T.req, reqArt({ question: "" })), "no question", /question/);
  reject(await tr("claude", T.req, reqArt({ request_type: "execute" })), "unknown type", /request_type/);
  reject(await tr("claude", T.req, reqArt({ context_evidence: [] })), "no context", /context_evidence/);
  reject(await tr("claude", T.req, undefined, { comment: "I need help from GPT with the retry owner, please answer soon." }), "free comment", /artifact|free-text/);
  world.task.entity.status = T.todo;
  reject(await tr("claude", T.req, reqArt()), "from To Do", /closed state|reserved/);
  world.task.entity.status = T.val;
  reject(await tr("claude", T.req, reqArt()), "from GPT Validation", /closed state|reserved/);
  world.task.entity.status = T.prog;
  reject(await tr(null, T.req, reqArt(), { author: "Kimi" }), "unknown signer");
});

test("Request status: while in Request nobody can hand off, close or validate; the only ways out are resume (Claude), Human Decision, cancel, PO", async () => {
  await toRequest();
  for (const [role, status, artifact] of [
    ["claude", T.val, handoff({ blueprint_comment_id: bpId() })], ["gpt", T.val, handoff({ blueprint_comment_id: bpId() })],
    ["gpt", T.done, approval()], ["claude", T.done, approval()], ["gpt", T.prog, blueprint()], ["gpt", T.prog, correction({ supersedes_blueprint_comment_id: bpId() })],
    ["gpt", T.prog, resume()], ["claude", T.todo, blocker()], ["gpt", T.todo, blocker()], ["claude", T.req, reqArt()],
  ]) reject(await tr(role, status, artifact), `${role} -> ${status} from Request`);
  assert.equal(world.task.entity.status, T.req);
});

test("Request status: only GPT answers and a partial answer keeps it open; leaving Request is authorized by the status, the history only warns", async () => {
  await toRequest();
  reject(await ans("claude", "R-905-1"), "claude answers own", /addressed to gpt/);
  reject(await ans("po", "R-905-1"), "po answers for gpt", /addressed to gpt/);
  okr(await ans("gpt", "R-905-1", { resolved: false, answer: "Checking." }));
  okr(await ans("gpt", "R-905-1"));
  assert.equal(world.task.entity.status, T.req, "answering alone does not release the card");
  reject(await tr("gpt", T.prog, resume({ response_comment_id: responseId() })), "GPT cannot resume Claude", /claude/);
  reject(await tr("claude", T.prog, resume({ response_comment_id: responseId(), applied_answer: "" })), "a field the template requires is still required", /applied_answer/);
  const r = okr(await tr("claude", T.prog, resume({ response_comment_id: responseId() })));
  assert.equal(r.to, "in progress");
  assert.equal(r.evidence_warnings, undefined, "a citation that matches the history raises no warning");
  assert.match(lastComment().comment, new RegExp(`^Request → In Progress\\nSchema: Request Resume 1\\.0\\.0\\nAuthor: Claude Code\\nModel: Unknown\\nEffort: Unknown\\nRequest: R-905-1\\nResponse: ${responseId()}\\n`));
  // the same request can be cited again after another cycle: no one-time-use bookkeeping is state
  okr(await tr("claude", T.val, handoff({ blueprint_comment_id: bpId() })));
  world.task.entity.status = T.req;
  const again = okr(await tr("claude", T.prog, resume({ response_comment_id: responseId() })));
  assert.equal(again.to, "in progress");
});

test("Request status: history never vetoes the visible status — no answer, wrong citations, an open or reused request only produce warnings", async () => {
  await toRequest();
  const noAnswer = okr(await tr("claude", T.prog, resume({ response_comment_id: "none" })));
  assert.equal(noAnswer.to, "in progress", "a manual or unanswered move is honored");
  assert.ok(noAnswer.evidence_warnings.some((w) => /no resolving/.test(w)), "the missing evidence is reported");
  assert.ok(noAnswer.evidence_warnings.some((w) => /response_comment_id/.test(w) || /request_id/.test(w) || /no resolving/.test(w)));
  world.task.entity.status = T.req;
  const wrong = okr(await tr("claude", T.prog, resume({ request_id: "R-905-9", response_comment_id: "wrong" })));
  assert.ok(wrong.evidence_warnings.some((w) => /request_id is not the latest/.test(w)));
  assert.equal(world.task.entity.status, T.prog);
});

test("Request status: repeated Request -> In Progress -> Request cycles need no hidden counter and an old open request cannot stop Claude", async () => {
  await toRequest();
  okr(await ans("gpt", "R-905-1"));
  okr(await tr("claude", T.prog, resume({ response_comment_id: responseId() })));
  const r2 = okr(await tr("claude", T.req, reqArt({ request_type: "clarification" })));
  assert.equal(r2.request_id, "R-905-2");
  // R-905-2 is still open in the comments, yet the board says In Progress after the move: the status alone decides
  const back = okr(await tr("claude", T.prog, resume({ request_id: "R-905-2", response_comment_id: responseId() })));
  assert.equal(back.to, "in progress");
  const st = okr(await state("claude"));
  assert.equal(st.request_status.claude_may_implement, true, "In Progress means Claude may implement, whatever old comments say");
  assert.equal(st.request_status.in_request, false);
  assert.equal(st.request_evidence.open_requests.length, 1, "the open request is reported as evidence only");
  const r3 = okr(await tr("claude", T.req, reqArt()));
  assert.equal(r3.request_id, "R-905-3");
});

test("Request status: every exit is modelled explicitly — resume (Claude), Human Decision (GPT/PO), Cancelled (PO only); agents have no generic way in or out, the authenticated PO moves it freely", async () => {
  await toRequest();
  // Human Decision: GPT (it received the request and decides the PO must decide) or the PO; never Claude
  reject(await tr("claude", T.human, hdr()), "claude escalates from Request", /reserved for gpt\/po/);
  okr(await tr("gpt", T.human, hdr({ blocked: false })));
  assert.equal(world.task.entity.status, T.human);
  world.task.entity.status = T.req;
  okr(await tr("po", T.human, hdr({ blocked: false })));
  // Cancelled is an explicit PO exception: GPT (even with an instruction) and Claude cannot
  world.task.entity.status = T.req;
  reject(await tr("gpt", T.canc, poDecision({ instruction_reference: "PO said so" })), "gpt cancels a Request", /explicit PO exception/);
  reject(await tr("claude", T.canc, poDecision({ instruction_reference: "x" })), "claude cancels a Request", /explicit PO exception/);
  okr(await tr("po", T.canc, poDecision()));
  // The authenticated PO is authoritative: a manual move into or out of Request is accepted with a PO Decision, whatever the history says.
  for (const to of [T.todo, T.prog, T.val, T.done]) { world.task.entity.status = T.req; okr(await tr("po", to, poDecision())); assert.equal(world.task.entity.status, to, `PO moves Request -> ${to}`); }
  for (const from of [T.todo, T.val, T.human, T.done, T.canc]) { world.task.entity.status = from; okr(await tr("po", T.req, poDecision())); assert.equal(world.task.entity.status, T.req, `PO moves ${from} -> Request`); }
  // Agents keep the closed state: nothing but the modelled pairs.
  for (const role of ["gpt", "claude"]) for (const to of [T.todo, T.val, T.done]) { world.task.entity.status = T.req; reject(await tr(role, to, poDecision()), `${role} Request -> ${to}`, /closed state|reserved/); }
  for (const role of ["gpt", "claude"]) for (const from of [T.todo, T.val, T.human, T.done, T.canc]) { world.task.entity.status = from; reject(await tr(role, T.req, poDecision()), `${role} ${from} -> Request`, /closed state|reserved|no transition/); }
});

test("PO manual move is authoritative: an open blocking Request and an old Blueprint cannot veto it, and the next read follows the visible status", async () => {
  await toRequest();
  okr(await tr("po", T.prog, poDecision()));
  let st = JSON.parse((await call("claude", "taiga_task_workflow_state", { id: 7 })).content[0].text);
  assert.equal(st.current_status, "in progress");
  assert.equal(st.request_status.in_request, false, "status, not the open Request in the history, decides");
  okr(await tr("po", T.val, poDecision()));
  st = JSON.parse((await call("gpt", "taiga_task_workflow_state", { id: 7 })).content[0].text);
  assert.equal(st.current_status, "gpt validation");
  assert.equal(st.owner_role, "gpt");
});

test("UUID-shaped comment ids round-trip losslessly: exact Blueprint/Handoff/Supersedes ids pass, one-character-different or stale ids fail closed", async () => {
  world.uuidIds = true;
  try {
    await release();
    const bp = bpId();
    assert.match(bp, /^[0-9a-f]{8}-dd90-11f1-84e4-cacb139fa1ca$/);
    const wrong = bp.replace(/^./, bp[0] === "a" ? "b" : "a");
    reject(await tr("claude", T.val, handoff({ blueprint_comment_id: wrong })), "one-character-different Blueprint id", /current Blueprint comment id/);
    okr(await tr("claude", T.val, handoff({ blueprint_comment_id: bp })));
    assert.equal(okr(await state("gpt")).current_blueprint.comment_id, bp);
    const ho = cur("Execution Handoff");
    reject(await tr("gpt", T.done, approval({ blueprint_comment_id: bp, handoff_comment_id: bp })), "Blueprint id given as the Handoff id", /latest Execution Handoff comment id/);
    reject(await tr("gpt", T.done, approval({ blueprint_comment_id: bp, handoff_comment_id: ho.replace(/^./, ho[0] === "a" ? "b" : "a") })), "one-character-different Handoff id", /latest Execution Handoff comment id/);
    reject(await tr("gpt", T.prog, correction({ supersedes_blueprint_comment_id: wrong })), "wrong supersedes id", /current Blueprint comment id/);
    okr(await tr("gpt", T.prog, correction({ supersedes_blueprint_comment_id: bp })));
    const bp2 = okr(await state("claude")).current_blueprint.comment_id;
    assert.notEqual(bp2, bp, "the correction is the new current Blueprint");
    reject(await tr("claude", T.val, handoff({ blueprint_comment_id: bp })), "stale prior Blueprint id", /current Blueprint comment id/);
    okr(await tr("claude", T.val, handoff({ blueprint_comment_id: bp2 })));
    okr(await tr("gpt", T.done, approval({ blueprint_comment_id: bp2, handoff_comment_id: cur("Execution Handoff") })));
  } finally { world.uuidIds = false; }
});

test("Request status: stand-alone requests never move the card; a blocking Claude->GPT question in progress must use the status; nothing stacks on a Request", async () => {
  await release();
  reject(await rq("claude", { blocking: true }), "blocking question must stop the work", /In Progress -> Request/);
  okr(await rq("claude", { blocking: false }));
  assert.equal(world.task.entity.status, T.prog);
  await tr("claude", T.req, reqArt({ context_evidence: ["x"] }));
  reject(await rq("gpt", { to_actor: "claude" }), "stack on Request", /Request/);
});

test("Request status: the description (execution contract) is locked in Request too", async () => {
  await toRequest();
  reject(await call("gpt", "taiga_tasks_update", { id: 7, version: 3, description: GOOD }), "gpt edits in Request", /execution contract/);
  reject(await call("claude", "taiga_tasks_update", { id: 7, version: 3, description: GOOD }), "claude edits in Request", /execution contract/);
});

test("Request status is optional per project: without it the rest of the workflow is unchanged and the status cannot be entered", async () => {
  world.noRequestStatus = true;
  await release();
  reject(await tr("claude", T.req, reqArt()), "no such status in this project", /not a status/);
  okr(await tr("claude", T.val, handoff({ blueprint_comment_id: bpId() })));
  const st = okr(await state("claude"));
  assert.equal(st.profile, "strict"); assert.equal(st.request_status.available, false);
  okr(await rq("claude", { blocking: true })); // without the Request status a stand-alone blocking question is the only option
});

test("Request status: notifications and templates", async () => {
  const sent = fakeNotifier();
  await release();
  okr(await tr("claude", T.req, reqArt()));
  assert.equal(sent().at(-1).argv.slice(1).join(" "), "--type WORKFLOW_REQUEST_OPENED --task 905 --project 49 --from claude --to gpt --request R-905-1");
  const set = loadTemplates();
  assert.equal(latest(set, "request-resume").version, "1.0.0");
  assert.ok(latest(set, "workflow-request").fields.some((f) => f.key === "to_actor" && f.header));
});

import { resolveTransition } from "../dist/workflow/policy.js";
test("matrix audit: Request is a closed state for agents (entry only Claude from In Progress; exits resume / Human Decision / PO cancel); the authenticated PO may move it anywhere with a PO Decision", () => {
  const S = ["to do", "in progress", "request", "gpt validation", "human decision", "done", "cancelled"];
  const res = (role, from, to) => resolveTransition("task", role, from, to);
  const typed = (role, from, to) => { const r = res(role, from, to); return r.kind === "typed" ? r.artifact + (r.override ? "!override" : "") : null; };
  // role x all destinations from Request
  const expected = {
    "to do": { gpt: null, claude: null, po: "po_decision!override" }, "in progress": { gpt: null, claude: "request_resume", po: "po_decision!override" },
    "gpt validation": { gpt: null, claude: null, po: "po_decision!override" }, "human decision": { gpt: "human_decision_request", claude: null, po: "human_decision_request" },
    "done": { gpt: null, claude: null, po: "po_decision!override" }, "cancelled": { gpt: null, claude: null, po: "po_decision" },
  };
  for (const [to, byRole] of Object.entries(expected)) for (const role of ["gpt", "claude", "po"]) assert.equal(typed(role, "request", to), byRole[role], `${role}: request -> ${to}`);
  // entry: only Claude from In Progress, for every role x source
  for (const from of S) for (const role of ["gpt", "claude", "po"]) {
    if (from === "request") continue;
    assert.equal(typed(role, from, "request"), role === "claude" && from === "in progress" ? "workflow_request" : role === "po" ? "po_decision!override" : null, `${role}: ${from} -> request`);
  }
  // elsewhere the PO override always leaves a PO Decision and never opens a path into execution through Done/Cancelled for the agents
  for (const from of ["human decision", "done", "cancelled"]) for (const to of S) for (const role of ["gpt", "claude"]) {
    if (to !== "cancelled" && to !== from && to !== "request") assert.equal(typed(role, from, to), null, `${role}: ${from} -> ${to}`);
  }
  assert.equal(typed("po", "done", "in progress"), "po_decision!override");
});

test("GPT may return a Task from GPT Validation to To Do with a Blocker Report; Claude may not", () => {
  const typed = (role) => { const r = resolveTransition("task", role, "gpt validation", "to do"); return r.kind === "typed" ? r.artifact : null; };
  assert.equal(typed("gpt"), "blocker_report");
  assert.equal(typed("claude"), null);
});

// ============================ guided rejection ==================================
const KEYS = ["code", "message", "actor", "current_status", "attempted_action", "required_artifact", "required_version", "missing_fields", "invalid_fields", "template_path", "allowed_actions", "next_step"];
function guided(r, want) {
  assert.equal(r.isError, true, JSON.stringify(r.content));
  const p = payload(r);
  for (const k of KEYS) assert.ok(k in p, `${k} missing in ${JSON.stringify(p)}`);
  assert.deepEqual(writes(), [], "a rejection mutates nothing");
  for (const [k, v] of Object.entries(want)) {
    if (v instanceof RegExp) assert.match(String(Array.isArray(p[k]) ? p[k].join(",") : p[k]), v, k);
    else assert.deepEqual(p[k], v, k);
  }
  assert.ok(!JSON.stringify(p).includes("## "), "the error never returns the template content");
  assert.ok(JSON.stringify(p).length < 6000, "the error stays small");
  return p;
}

test("guided rejection: missing artifact, wrong type, wrong version, missing and invalid fields all name the template and the fields", async () => {
  await release(); // Task In Progress
  const hand = handoff({ blueprint_comment_id: bpId() });
  guided(await tr("claude", T.val, undefined), { code: "WORKFLOW_ARTIFACT_MISSING", actor: "claude", current_status: "In Progress", attempted_action: "GPT Validation", required_artifact: "execution_handoff", required_version: "1.0.0", template_path: "workflow/templates/execution-handoff-v1.0.0.md" });
  guided(await tr("claude", T.val, { ...hand, type: "validation_approval" }), { code: "WORKFLOW_ARTIFACT_INVALID", invalid_fields: /type/ });
  guided(await tr("claude", T.val, { ...hand, version: "0.9.0" }), { code: "WORKFLOW_ARTIFACT_INVALID", invalid_fields: /version/, required_version: "1.0.0" });
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- rest-omit
  const { typecheck, branch, ...partial } = hand;
  const p = guided(await tr("claude", T.val, partial), { code: "WORKFLOW_ARTIFACT_INVALID", missing_fields: ["branch", "typecheck"] });
  assert.match(p.next_step, /taiga_workflow_template.*execution-handoff/);
  guided(await tr("claude", T.val, { ...hand, commits: [{ id: "x" }], surprise: 1 }), { invalid_fields: /commits.*surprise|surprise.*commits/ });
  guided(await tr("claude", T.val, { ...hand, blueprint_comment_id: "wrong" }), { invalid_fields: ["blueprint_comment_id"] });
  assert.ok(p.allowed_actions.some((a) => a.target_status === "gpt validation" && a.artifact === "execution_handoff"), "allowed_actions tells what Claude may do here");
});

test("guided rejection: unauthorized actor, incompatible source status and an unknown status", async () => {
  const p = guided(await tr("claude", T.prog, blueprint()), { code: "WORKFLOW_TRANSITION_REJECTED", actor: "claude", current_status: "To Do", attempted_action: "In Progress" });
  assert.match(p.message, /reserved for gpt\/po/);
  assert.deepEqual(p.allowed_actions.map((a) => a.target_status), [], "Claude has nothing to do on a To Do card");
  await release();
  guided(await tr("gpt", T.val, handoff()), { code: "WORKFLOW_TRANSITION_REJECTED", actor: "gpt", current_status: "In Progress", message: /reserved for claude/ });
  guided(await tr("claude", T.done, approval()), { code: "WORKFLOW_TRANSITION_REJECTED", message: /no transition/ });
  guided(await tr("claude", 999, handoff()), { code: "WORKFLOW_TRANSITION_REJECTED", message: /not a status/ });
});

test("guided rejection: malformed Request, answer by the wrong actor, resume without a valid answer", async () => {
  await release();
  guided(await tr("claude", T.req, reqArt({ blocking: false, question: "" })), { code: "WORKFLOW_REQUEST_REJECTED", required_artifact: "workflow_request", required_version: "1.0.0", template_path: "workflow/templates/workflow-request-v1.0.0.md", invalid_fields: /blocking|question/ });
  guided(await rq("claude", { question: " ", blocking: false }), { code: "WORKFLOW_REQUEST_REJECTED", invalid_fields: /question/ });
  okr(await tr("claude", T.req, reqArt()));
  guided(await ans("claude", "R-905-1"), { code: "WORKFLOW_REQUEST_REJECTED", actor: "claude", required_artifact: "workflow_response", template_path: "workflow/templates/workflow-request-response-v1.0.0.md", message: /addressed to gpt/ });
  guided(await ans("gpt", "R-905-77"), { code: "WORKFLOW_REQUEST_REJECTED", invalid_fields: ["request_id"] });
  guided(await tr("claude", T.prog, resume({ applied_answer: "" })), { code: "WORKFLOW_RESUME_REJECTED", required_artifact: "request_resume", template_path: "workflow/templates/request-resume-v1.0.0.md", invalid_fields: /applied_answer/ });
});

test("guided rejection: the version and path come from the SAME resolver (highest SemVer for new artifacts, declared version for history)", async () => {
  const d = tmpTemplates({ "execution-handoff-v1.4.0.md": readFileSync(join(templatesDir(), "execution-handoff-v1.0.0.md"), "utf8").replace("- `branch` (text, label=**Branch**): Local branch holding the work.", "- `branch` (text, label=**Branch**): Local branch holding the work.\n- `lint` (text, label=**Lint**): Lint result.") });
  process.env.TAIGA_MCP_TEMPLATES_DIR = d;
  try {
    await release();
    const p = guided(await tr("claude", T.val, handoff({ blueprint_comment_id: bpId() })), { code: "WORKFLOW_ARTIFACT_INVALID", required_version: "1.4.0", template_path: "workflow/templates/execution-handoff-v1.4.0.md", missing_fields: ["lint"] });
    assert.ok(readFileSync(join(d, "execution-handoff-v1.4.0.md"), "utf8").includes("`lint`"), "the reported file is the one that was resolved");
    // history declaring a version that no file provides: structured, template-unavailable, nothing mutated
    world.task.comments.push({ id: "old", comment: "Execution Handoff — READY FOR GPT VALIDATION\nSchema: execution-handoff/0.5.0\n", created_at: "2031-01-01T00:00:00Z" });
    guided(await tr("claude", T.val, handoff({ blueprint_comment_id: bpId(), lint: "ok" })), { code: "WORKFLOW_TEMPLATE_UNAVAILABLE", message: /0\.5\.0/ });
    void p;
  } finally { delete process.env.TAIGA_MCP_TEMPLATES_DIR; rmSync(d, { recursive: true, force: true }); }
  const missing = guided(await call("gpt", "taiga_workflow_template", { name: "nope" }), { code: "WORKFLOW_TEMPLATE_UNAVAILABLE", message: /no template nope/ });
  assert.match(missing.next_step, /implementation-blueprint \[1\.0\.0\]/);
  guided(await call("gpt", "taiga_workflow_template", { name: "execution-handoff", version: "9.9.9" }), { code: "WORKFLOW_TEMPLATE_UNAVAILABLE", message: /9\.9\.9/ });
});

// ============================ common header: Author / Model / Effort ==============
import { normalizeModel, normalizeEffort, AUTHOR_LABEL } from "../dist/workflow/actor.js";
const head = (text, n) => text.split("\n").slice(0, n);
const tplOf = (name) => latest(loadTemplates(), name);
const R = (name, artifact, o) => renderArtifact({ template: tplOf(name), entity: "task", artifact, ...o });
const hd = (who, model = "Unknown", effort = "Unknown") => [`Author: ${who}`, `Model: ${model}`, `Effort: ${effort}`];

test("headers: the ten governed artifacts share the common envelope, the real movement on line 1 and their own metadata after it", () => {
  const T1 = (from, to) => ({ from, to });
  const cases = [
    ["implementation-blueprint", blueprint(), { author: "gpt", transition: T1("To Do", "In Progress"), round: 1 }, ["To Do → In Progress", "Schema: Implementation Blueprint 1.0.0", ...hd("GPT"), "Mode: initial", "Round: 1"]],
    ["correction-blueprint", correction({ supersedes_blueprint_comment_id: "bp-1" }), { author: "gpt", transition: T1("GPT Validation", "In Progress"), round: 2 }, ["GPT Validation → In Progress", "Schema: Correction Blueprint 1.0.0", ...hd("GPT"), "Mode: correction", "Round: 2", "Validation round: 1", "Supersedes: bp-1"]],
    ["execution-handoff", handoff({ blueprint_comment_id: "bp-1" }), { author: "claude", transition: T1("In Progress", "GPT Validation") }, ["In Progress → GPT Validation", "Schema: Execution Handoff 1.0.0", ...hd("Claude Code"), "Blueprint: bp-1"]],
    ["validation-approval", approval({ blueprint_comment_id: "bp-1", handoff_comment_id: "ho-1" }), { author: "po", transition: T1("GPT Validation", "Done") }, ["GPT Validation → Done", "Schema: Validation Approval 1.0.0", ...hd("PO"), "Blueprint: bp-1", "Handoff: ho-1"]],
    ["human-decision-request", hdr(), { author: "gpt", transition: T1("Request", "Human Decision") }, ["Request → Human Decision", "Schema: Human Decision Request 1.0.0", ...hd("GPT"), "Blocking: no"]],
    ["blocker-report", blocker(), { author: "claude", transition: T1("In Progress", "To Do") }, ["In Progress → To Do", "Schema: Blocker Report 1.0.0", ...hd("Claude Code")]],
    ["po-decision", poDecision(), { author: "po", transition: T1("Request", "Cancelled") }, ["Request → Cancelled", "Schema: PO Decision 1.0.0", ...hd("PO")]],
    ["workflow-request", reqArt(), { author: "claude", transition: T1("In Progress", "Request"), preLines: ["Request: R-9-1"], postLines: ["Blueprint: bp-1"] }, ["In Progress → Request", "Schema: Workflow Request 1.0.0", ...hd("Claude Code"), "Request: R-9-1", "Type: analysis", "To: gpt", "Blocking: yes", "Blueprint: bp-1"]],
    ["workflow-request", reqArt({ blocking: false }), { author: "gpt", transition: null, preLines: ["Request: R-9-2"] }, ["Status unchanged", "Schema: Workflow Request 1.0.0", ...hd("GPT"), "Request: R-9-2", "Type: analysis", "To: gpt", "Blocking: no"]],
    ["workflow-request-response", { type: "workflow_response", request_id: "R-9-1", resolved: true, answer: "a", evidence: [] }, { author: "gpt", transition: null }, ["Status unchanged", "Schema: Workflow Request Response 1.0.0", ...hd("GPT"), "Request: R-9-1", "Resolved: yes"]],
    ["request-resume", resume({ response_comment_id: "rs-1" }), { author: "claude", transition: T1("Request", "In Progress") }, ["Request → In Progress", "Schema: Request Resume 1.0.0", ...hd("Claude Code"), "Request: R-905-1", "Response: rs-1"]],
  ];
  assert.equal(new Set(cases.map((c) => c[0])).size, 10, "all ten templates are exercised");
  for (const [name, artifact, o, expected] of cases) {
    const text = R(name, artifact, o);
    assert.deepEqual(head(text, expected.length), expected, name);
    assert.ok(!/\n-- /.test(text), `${name}: no trailing signature`);
  }
});

test("headers: Author is the authenticated role label; nothing from the launcher environment or the artifact body can change it", async () => {
  assert.deepEqual(["gpt", "claude", "po"].map((r) => AUTHOR_LABEL[r]), ["GPT", "Claude Code", "PO"]);
  assert.ok(!("model" in actorFor("gpt")), "the identity carries no model");
  process.env.TAIGA_MCP_MODEL = "launcher-model"; process.env.TAIGA_MCP_GPT_MODEL = "launcher-model";
  try {
    okr(await tr("gpt", T.prog, blueprint()));
    assert.deepEqual(head(lastComment().comment, 5), ["To Do → In Progress", "Schema: Implementation Blueprint 1.0.0", "Author: GPT", "Model: Unknown", "Effort: Unknown"], "no fixed launcher model");
  } finally { delete process.env.TAIGA_MCP_MODEL; delete process.env.TAIGA_MCP_GPT_MODEL; }
  await call("gpt", "taiga_workflow_transition", { entity: "task", id: 7, status: T.val, artifact: blueprint() });
  world.task.entity.status = T.prog;
  for (const spoof of [{ author: "GPT" }, { model: "gpt-9" }, { effort: "High" }]) {
    reject(await tr("claude", T.val, { ...handoff({ blueprint_comment_id: bpId() }), ...spoof }), `payload ${Object.keys(spoof)[0]}`, /unknown artifact field/);
  }
});

test("telemetry: Model and Effort come from the call; absent or invalid is Unknown, never an error, never a truncation", async () => {
  assert.equal(normalizeModel("5.6 Sol"), "5.6 Sol"); assert.equal(normalizeModel("  claude-sonnet-5-5 "), "claude-sonnet-5-5");
  for (const bad of ["", "   ", "a\nb", "x".repeat(61), "<script>", "unknown", 42, null, undefined]) assert.equal(normalizeModel(bad), "Unknown", String(bad));
  assert.equal(normalizeModel("x".repeat(80)), "Unknown", "a too-long model is Unknown, not a cut-off value");
  for (const [raw, out] of [["Low", "Low"], ["medium", "Medium"], ["HIGH", "High"], ["Unknown", "Unknown"], ["extreme", "Unknown"], ["", "Unknown"], [undefined, "Unknown"], [3, "Unknown"]]) assert.equal(normalizeEffort(raw), out, String(raw));
  okr(await tr("gpt", T.prog, blueprint(), { model: "5.6 Sol", effort: "Medium" }));
  assert.deepEqual(head(lastComment().comment, 5), ["To Do → In Progress", "Schema: Implementation Blueprint 1.0.0", "Author: GPT", "Model: 5.6 Sol", "Effort: Medium"]);
  world.task.entity.status = T.todo;
  okr(await tr("gpt", T.prog, blueprint({ objective: "again" }), { model: "x".repeat(61), effort: "extreme" }));
  assert.deepEqual(head(lastComment().comment, 5).slice(3), ["Model: Unknown", "Effort: Unknown"]);
});

test("telemetry: Model and Effort never affect authorization, validity or the outcome", async () => {
  const args = { model: "gpt-6-pro", effort: "High" };
  const denied = await tr("claude", T.prog, blueprint(), args);
  assert.equal(denied.isError, true); assert.equal(payload(denied).code, "WORKFLOW_TRANSITION_REJECTED"); assert.deepEqual(writes(), [], "claiming a GPT model does not make Claude a releaser");
  okr(await tr("gpt", T.prog, blueprint(), { model: "claude-opus-5-5", effort: "Low" }));
  assert.equal(world.task.entity.status, T.prog, "claiming a Claude model does not stop GPT");
  okr(await tr("claude", T.req, reqArt(), { model: "???", effort: "ultra" }));
  assert.equal(world.task.entity.status, T.req, "garbage telemetry never blocks");
  okr(await ans("gpt", "R-905-1", { model: "m", effort: "nope" }));
  okr(await tr("claude", T.prog, resume({ response_comment_id: responseId() })));
  assert.equal(world.task.entity.status, T.prog, "absent telemetry never blocks");
});

test("telemetry: requests and responses carry it too, and the read model reports known vs unknown coverage without making it a gate", async () => {
  await release();
  okr(await rq("claude", { blocking: false, model: "claude-sonnet-5-5", effort: "Medium" }));
  assert.deepEqual(head(lastComment().comment, 5), ["Status unchanged", "Schema: Workflow Request 1.0.0", "Author: Claude Code", "Model: claude-sonnet-5-5", "Effort: Medium"]);
  okr(await ans("gpt", "R-905-1"));
  assert.deepEqual(head(lastComment().comment, 5).slice(2), ["Author: GPT", "Model: Unknown", "Effort: Unknown"]);
  const st = okr(await state("gpt"));
  assert.deepEqual([st.model_telemetry.known, st.model_telemetry.unknown], [1, 2]); // blueprint (Unknown), request (known), response (Unknown)
});

test("compatibility: history without Author or Effort, with or without Model, and with the old signature, is still read", async () => {
  const set = loadTemplates();
  const noModel = "Implementation Blueprint\nSchema: implementation-blueprint/1.0.0\nMode: initial\nRound: 1\n\n## Objective\nold\n\n-- GPT";
  const withModel = "Implementation Blueprint\nSchema: implementation-blueprint/1.0.0\nModel: gpt-x\nMode: initial\nRound: 1\n\n## Objective\nold\n\n-- GPT (GPT-6)";
  const a = parseArtifact({ id: "h1", comment: noModel }, set), b = parseArtifact({ id: "h2", comment: withModel }, set);
  assert.deepEqual([a.kind, a.model, a.author, a.effort], ["implementation_blueprint", null, undefined, null]);
  assert.deepEqual([b.model, b.author], ["gpt-x", undefined]);
  const fresh = R("workflow-request", reqArt(), { author: "claude", transition: { from: "In Progress", to: "Request" }, preLines: ["Request: R-9-1"] });
  const p = parseArtifact({ id: "n1", comment: fresh }, set);
  assert.deepEqual([p.kind, p.author, p.from, p.to, p.model, p.effort, p.requestId], ["workflow_request", "Claude Code", "claude", "gpt", null, null, "R-9-1"]);
  await release();
  world.task.comments.push({ id: "h3", comment: noModel, created_at: "2031-01-01T00:00:00Z" });
  assert.equal(okr(await state("gpt")).current_blueprint.mode, "initial", "the read model keeps working next to old and new artifacts");
});

test("signature: governed artifacts have none; the legacy path outside the workflow keeps its signature", async () => {
  okr(await tr("gpt", T.prog, blueprint()));
  assert.ok(!/\n-- /.test(lastComment().comment));
  world.task.entity.project = 50; world.task.entity.status = 1;
  okr(await call("claude", "taiga_workflow_transition", { entity: "task", id: 7, status: 2, comment: "Started the work: wrote the failing test first." }));
  assert.ok(lastComment().comment.endsWith("-- Claude Code"), "legacy comment keeps the signature");
  world.task.entity.project = 49;
  okr(await call("claude", "taiga_userstory_comment_create", { id: 7, comment: "story note" }));
  assert.ok(world.userstory.comments.at(-1).comment.endsWith("-- Claude Code"), "Story comments are legacy comments");
});

test("idempotency: a retry of the same governed artifact is detected with Author in the header; a different declaration is a different artifact", async () => {
  okr(await tr("gpt", T.prog, blueprint(), { model: "m1", effort: "Low" }));
  const count = world.task.comments.length;
  world.task.entity.status = T.todo; // the status write was lost; the artifact persisted
  reject(await tr("gpt", T.prog, blueprint(), { model: "m1", effort: "Low" }), "same artifact, same declaration", /NEW/);
  assert.equal(world.task.comments.length, count, "no double comment");
  okr(await tr("gpt", T.prog, blueprint(), { model: "m2", effort: "Low" }));
  assert.equal(world.task.comments.length, count + 1, "a different declared model is a different text");
  const a = R("implementation-blueprint", blueprint(), { author: "gpt", transition: { from: "To Do", to: "In Progress" }, meta: { model: "m", effort: "Low" } });
  assert.equal(a, R("implementation-blueprint", blueprint(), { author: "gpt", transition: { from: "To Do", to: "In Progress" }, meta: { model: "m", effort: "Low" } }), "rendering is deterministic");
});

test("headers: the transition on line 1 is the REAL movement in Taiga, not a fixed origin", async () => {
  await toValidation();
  okr(await tr("gpt", T.human, hdr()));
  assert.equal(head(lastComment().comment, 1)[0], "GPT Validation → Human Decision");
  world.task.entity.status = T.req;
  okr(await tr("gpt", T.human, hdr({ blocked: false })));
  assert.equal(head(lastComment().comment, 1)[0], "Request → Human Decision");
  world.task.entity.status = T.req;
  okr(await tr("po", T.canc, poDecision()));
  assert.deepEqual(head(lastComment().comment, 3), ["Request → Cancelled", "Schema: PO Decision 1.0.0", "Author: PO"]);
  world.task.entity.status = T.prog;
  okr(await tr("claude", T.todo, blocker()));
  assert.equal(head(lastComment().comment, 1)[0], "In Progress → To Do");
});

// ============================ presentation = template label ======================
import { renderArtifact } from "../dist/workflow/render.js";
import { parseArtifact } from "../dist/workflow/state.js";
import { plainLabel } from "../dist/workflow/templates.js";

// edit ONLY the label of one field of one template inside a throwaway copy of the templates directory
function withLabel(file, key, label) {
  const d = tmpTemplates();
  const p = join(d, file);
  const lines = readFileSync(p, "utf8").split("\n").map((l) => {
    const m = new RegExp("^- `" + key + "` \\(([^)]*)\\): (.+)$").exec(l);
    if (!m) return l;
    const parts = m[1].split(", ").filter((x) => !x.startsWith("label="));
    return "- `" + key + "` (" + [...parts, "label=" + label].join(", ") + "): " + m[2];
  });
  writeFileSync(p, lines.join("\n"));
  return d;
}
const FORMS = [["plain", "Objective", "Objective"], ["bold", "**Objective**", "**Objective**"], ["heading", "# Objective", "# Objective"], ["heading + bold", "# **Objective**", "# **Objective**"]];

test("label formatting: the template label is printed literally (plain, bold, heading, heading + bold)", () => {
  for (const [name, label, expected] of FORMS) {
    const d = withLabel("implementation-blueprint-v1.0.0.md", "objective", label);
    try {
      const set = loadTemplates(d);
      const tpl = latest(set, "implementation-blueprint");
      const text = renderArtifact({ template: tpl, entity: "task", artifact: blueprint({ objective: "Ship it" }), author: "gpt", transition: { from: "To Do", to: "In Progress" } });
      assert.ok(text.split("\n").includes(expected), `${name}: line "${expected}" present`);
      assert.ok(text.split("\n")[text.split("\n").indexOf(expected) + 1] === "Ship it", `${name}: content right after the label`);
      assert.ok(!text.includes("## "), `${name}: the renderer adds no heading of its own`);
    } finally { rmSync(d, { recursive: true, force: true }); }
  }
});

test("label formatting: changing ONLY the template label changes the rendered artifact through the MCP, with no code change", async () => {
  const before = (await (async () => { await tr("gpt", T.prog, blueprint({ objective: "Same text" })); return lastComment().comment; })());
  assert.match(before, /\n\*\*Objective\*\*\nSame text\n/);
  world.task.entity.status = T.todo; world.task.comments.length = 0;
  const d = withLabel("implementation-blueprint-v1.0.0.md", "objective", "# **Objective**");
  process.env.TAIGA_MCP_TEMPLATES_DIR = d;
  try {
    okr(await tr("gpt", T.prog, blueprint({ objective: "Same text" })));
    assert.match(lastComment().comment, /\n# \*\*Objective\*\*\nSame text\n/);
    assert.ok(!lastComment().comment.includes("\n**Objective**\n"));
    assert.equal(okr(await state("claude")).current_blueprint.mode, "initial", "the read model still understands it");
  } finally { delete process.env.TAIGA_MCP_TEMPLATES_DIR; rmSync(d, { recursive: true, force: true }); }
});

test("label formatting: headers keep their semantics and a new artifact renders exactly what the shipped templates declare", async () => {
  await toValidation();
  const first = bySchema("Implementation Blueprint")[0].comment;
  assert.match(first, /^To Do → In Progress\nSchema: Implementation Blueprint 1\.0\.0\nAuthor: GPT\nModel: Unknown\nEffort: Unknown\nMode: initial\nRound: 1\n/);
  const set = loadTemplates();
  for (const f of latest(set, "implementation-blueprint").fields.filter((x) => !x.header)) assert.ok(first.split("\n").includes(f.label), `label line for ${f.key}: ${f.label}`);
  assert.ok(first.split("\n").includes("# **Implementation scope**") && first.split("\n").includes("**Objective**"), "the declared mix of heading and bold");
  okr(await tr("gpt", T.prog, correction({ supersedes_blueprint_comment_id: bpId() })));
  const corr = lastComment().comment;
  assert.match(corr, /\nValidation round: 1\nSupersedes: /);
  assert.ok(corr.split("\n").includes("# **Findings**") && corr.split("\n").includes("**Cumulative audit scope**"));
});

test("parser: fields are recovered in the four declared formats, keyed by the field key, not by the label text", () => {
  for (const [name, label] of FORMS) {
    const d2 = withLabel("workflow-request-v1.0.0.md", "question", label.replace("Objective", "Question"));
    try {
      const set = loadTemplates(d2);
      const tpl = latest(set, "workflow-request");
      const art = { type: "workflow_request", request_type: "analysis", to_actor: "gpt", blocking: true, question: "Who owns the retry state?", context_evidence: ["pool.ts:10", "see ADR"] };
      const comment = renderArtifact({ template: tpl, entity: "task", artifact: art, author: "claude", transition: null, preLines: ["Request: R-905-1"] });
      const p = parseArtifact({ id: "c1", comment }, set);
      assert.equal(p.question, "Who owns the retry state?", name);
      assert.deepEqual(p.contextEvidence, ["pool.ts:10", "see ADR"], name);
      assert.deepEqual([p.requestId, p.to, p.requestType, p.blocking], ["R-905-1", "gpt", "analysis", true], name);
    } finally { rmSync(d2, { recursive: true, force: true }); }
  }
  assert.equal(plainLabel("# **Objective**"), "Objective"); assert.equal(plainLabel("**Objective**"), "Objective"); assert.equal(plainLabel("# Objective"), "Objective"); assert.equal(plainLabel("Objective"), "Objective");
  assert.equal(plainLabel("**a** and _b_"), "**a** and _b_", "any other marking is ordinary text");
});

test("parser: artifacts persisted in the OLD `## Label` format stay readable (no migration, no change of authority)", async () => {
  const set = loadTemplates();
  const legacyRequest = ["Workflow Request — GPT ANALYSIS", "Schema: workflow-request/1.0.0", "Request: R-905-1", "Task: #905", "From: claude", "Authority: none (a request grants no execution authority)", "Type: analysis", "To: gpt", "Blocking: yes", "", "## Question", "Which owner holds it?", "", "## Context / evidence", "- pool.ts:10", "", "-- Claude Code"].join("\n");
  const p = parseArtifact({ id: "old1", comment: legacyRequest }, set);
  assert.equal(p.question, "Which owner holds it?"); assert.deepEqual(p.contextEvidence, ["pool.ts:10"]); assert.equal(p.blocking, true);
  // and through the read model, next to a new-format artifact
  await release();
  world.task.comments.push({ id: "old1", comment: legacyRequest, created_at: "2031-01-01T00:00:00Z" });
  const st = okr(await state("gpt"));
  assert.equal(st.request_evidence.open_requests.length, 1);
  assert.equal(st.request_evidence.open_requests[0].question, "Which owner holds it?");
  assert.equal(st.current_blueprint.mode, "initial");
  const legacyBlueprint = "Implementation Blueprint\nSchema: implementation-blueprint/1.0.0\nMode: initial\nRound: 1\n\n## Objective\nold style\n\n## Stop condition\nstop";
  assert.equal(parseArtifact({ id: "old2", comment: legacyBlueprint }, set).kind, "implementation_blueprint");
});

test("the workflow state still rebuilds Blueprint, Handoff, Request and answers after the format change; authority is untouched", async () => {
  await toRequest();
  okr(await ans("gpt", "R-905-1"));
  const st = okr(await state("claude"));
  assert.equal(st.current_status, "request");
  assert.equal(st.request_evidence.resolved_requests, 1);
  assert.ok(st.current_blueprint.comment_id);
  assert.equal(st.owner_role, "gpt");
  reject(await tr("gpt", T.prog, resume({ response_comment_id: responseId() })), "authority unchanged: GPT still cannot resume", /reserved for claude/);
});

test("all seventeen templates exist, are 1.0.0 (the Human Decision Resolution also has 1.1.0), and declare every body label themselves (nothing is hardcoded in TypeScript)", () => {
  const set = loadTemplates();
  const names = [...new Set(set.map((t) => t.name))].sort();
  assert.equal(names.length, 17, names.join());
  for (const t of set) {
    assert.equal(t.version, t.name === "human-decision-resolution" && t.semver[1] === 1 ? "1.1.0" : "1.0.0", t.name);
    for (const f of t.fields.filter((x) => !x.header)) assert.ok(/^(# )?\*\*.+\*\*$/.test(f.label), `${t.name}.${f.key} declares its presentation: ${f.label}`);
  }
  const src = readFileSync(join(templatesDir(), "..", "..", "src", "workflow", "render.ts"), "utf8");
  assert.ok(!/`## \$\{/.test(src) && !src.includes('"## "'), "the renderer no longer imposes a heading");
  const state = readFileSync(join(templatesDir(), "..", "..", "src", "workflow", "state.ts"), "utf8");
  assert.ok(!/startsWith\("## "\)/.test(state) && !/s\.get\("(Question|Context)/.test(state), "the parser does not hardcode labels");
});

// ============================ statuses by NAME ===============================
test("status by name: the same names resolve to the real ids of projects whose ids differ", async () => {
  const writesTo = () => requests.filter((r) => r.method === "PATCH" && r.body?.status !== undefined).map((r) => r.body.status);
  const a = okr(await tr("gpt", "In Progress", blueprint()));
  assert.equal(a.transitioned, true);
  assert.deepEqual(writesTo(), [T.prog]);
  // same project vocabulary shifted by 100 (what another project would look like): same call, different real id
  world.statusOffset = 100; world.task.entity.status = T.todo + 100; requests = []; world.task.comments = [];
  const b = okr(await tr("gpt", "  in   progress ", blueprint()));
  assert.equal(b.transitioned, true);
  assert.deepEqual(writesTo(), [T.prog + 100]);
});

test("status by name: unknown or ambiguous names fail closed with a clear error and zero writes", async () => {
  const unknown = await tr("gpt", "Almost Done", blueprint());
  assert.equal(unknown.isError, true);
  assert.match(JSON.parse(unknown.content[0].text).violations[0], /no task status named "Almost Done".*Available: .*In Progress/);
  world.dupInProgress = true; requests = [];
  const amb = await tr("gpt", "In Progress", blueprint());
  assert.equal(amb.isError, true);
  assert.match(amb.content[0].text, /ambiguous/);
  const viaId = await tr("gpt", T.prog, blueprint());
  assert.equal(viaId.isError, true, "the workflow also refuses ambiguous required names when a numeric id is passed");
  assert.match(viaId.content[0].text, /ambiguous status names/);
  assert.equal(requests.filter((r) => r.method !== "GET").length, 0);
});

test("status by name: a numeric id is still accepted (generic compatibility)", async () => {
  assert.equal(okr(await tr("gpt", T.prog, blueprint())).transitioned, true);
});

test("no workflow source, doc or tool description depends on a fixed status id", () => {
  const root = new URL("../", import.meta.url);
  const files = ["src/governance.ts", "src/workflow/policy.ts", "src/workflow/transition.ts", "src/workflow/tools.ts", "src/workflow/state.ts", "knowledge-base/RULES.md", "README.md"].filter((f) => existsSync(new URL(f, root)));
  for (const f of files) assert.doesNotMatch(readFileSync(new URL(f, root), "utf8"), /(?:To Do|In Progress|GPT Validation|Human Decision|Done|Cancelled|Request)\s*[:=(]?\s*(?:33\d|34\d|350)\b/, f);
});

test("request_type is validated at runtime against the latest template: editing the .md changes the accepted values, no code change", async () => {
  assert.equal((await rq("gpt", { request_type: "new_kind" })).isError, true);
  const tdir = mkdtempSync(join(tmpdir(), "tpl-"));
  cpSync(templatesDir(), tdir, { recursive: true });
  const src = readFileSync(join(tdir, "workflow-request-v1.0.0.md"), "utf8");
  writeFileSync(join(tdir, "workflow-request-v1.0.1.md"), src.replace("values=analysis|clarification|evidence|capability_gap", "values=analysis|clarification|evidence|capability_gap|new_kind"));
  const prev = process.env.TAIGA_MCP_TEMPLATES_DIR; process.env.TAIGA_MCP_TEMPLATES_DIR = tdir;
  try { assert.notEqual((await rq("gpt", { request_type: "new_kind" })).isError, true); }
  finally { if (prev === undefined) delete process.env.TAIGA_MCP_TEMPLATES_DIR; else process.env.TAIGA_MCP_TEMPLATES_DIR = prev; rmSync(tdir, { recursive: true, force: true }); }
});

test("HISTORICAL-CONTRACT-1.0.0: a request created under 1.0.0 is interpreted with the 1.0.0 contract after 1.0.1 exists, never silently re-read with the latest", async () => {
  okr(await rq("gpt", { request_type: "analysis" }));
  const comment = world.task.comments.find((c) => /Schema: Workflow Request 1\.0\.0/.test(c.comment));
  assert.ok(comment, "the stored artifact declares Schema 1.0.0");
  const tdir = mkdtempSync(join(tmpdir(), "tpl-"));
  cpSync(templatesDir(), tdir, { recursive: true });
  const src = readFileSync(join(tdir, "workflow-request-v1.0.0.md"), "utf8");
  // 1.0.1 renames the field `question` -> `question_text`: reading the 1.0.0 artifact with 1.0.1 would lose the question.
  writeFileSync(join(tdir, "workflow-request-v1.0.1.md"), src.replace("- `question` (", "- `question_text` ("));
  const prev = process.env.TAIGA_MCP_TEMPLATES_DIR; process.env.TAIGA_MCP_TEMPLATES_DIR = tdir;
  try {
    const st = okr(await call("claude", "taiga_task_workflow_state", { id: 7 }));
    const all = JSON.stringify(st);
    assert.match(all, /Which owner holds the retry state\?/, "the 1.0.0 question is still parsed with the 1.0.0 field names");
    assert.equal(st.request_evidence.open_requests.length, 1);
    assert.equal(world.task.comments.find((c) => c.id === comment.id).comment, comment.comment, "history is untouched");
    const fresh = okr(await call("claude", "taiga_workflow_template", { name: "workflow-request", format: "parsed" }));
    assert.equal(fresh.version, "1.0.1");
    assert.ok(fresh.parsed.fields.some((f) => f.key === "question_text"));
  } finally { if (prev === undefined) delete process.env.TAIGA_MCP_TEMPLATES_DIR; else process.env.TAIGA_MCP_TEMPLATES_DIR = prev; rmSync(tdir, { recursive: true, force: true }); }
});

test("duplicated optional `Request` status: refused by name and by numeric id, no mutation, no advice to use a numeric id", async () => {
  world.dupRequest = true; world.task.entity.status = T.prog; requests = [];
  const byName = await tr("claude", "Request", { type: "workflow_request", to_actor: "gpt", request_type: "analysis", question: "q?", context_evidence: ["c"] });
  assert.equal(byName.isError, true);
  const nameMsg = JSON.parse(byName.content[0].text).violations[0];
  assert.match(nameMsg, /ambiguous/); assert.doesNotMatch(nameMsg, /numeric id/);
  const byId = await tr("claude", T.req, { type: "workflow_request", to_actor: "gpt", request_type: "analysis", question: "q?", context_evidence: ["c"] });
  assert.equal(byId.isError, true);
  assert.match(byId.content[0].text, /ambiguous status names in this project.s task workflow: request/);
  const unrelated = await tr("claude", T.val, handoff({ blueprint_comment_id: "x" }));
  assert.equal(unrelated.isError, true, "a duplicated semantic status makes the whole governed workflow of the project fail closed");
  assert.equal(requests.filter((r) => r.method !== "GET").length, 0);
});

// ============================ adversarial audit: ambiguous vocabulary in every consumer ===============================
test("AUDIT taiga_task_workflow_state fails closed on a duplicated required status and on a duplicated Request; history stays readable", async () => {
  okr(await tr("gpt", T.prog, blueprint()));
  const healthy = okr(await call("claude", "taiga_task_workflow_state", { id: 7 }));
  assert.equal(healthy.profile, "strict"); assert.ok(healthy.allowed_actions_for_caller.length > 0);
  for (const flag of ["dupInProgress", "dupRequest"]) {
    world[flag] = true;
    const st = okr(await call("claude", "taiga_task_workflow_state", { id: 7 }));
    assert.equal(st.profile, "integrity_error");
    assert.equal(st.integrity.ok, false);
    assert.deepEqual(st.integrity.duplicated_status_names, [flag === "dupInProgress" ? "in progress" : "request"]);
    assert.deepEqual([st.allowed_actions_for_caller, st.denied_for_caller], [[], []]);
    assert.equal(st.owner_role, undefined);
    assert.ok(st.current_blueprint, "persisted history is still readable");
    world[flag] = false;
  }
});

test("AUDIT workflow request create/answer refuse an ambiguous vocabulary without mutation", async () => {
  world.task.entity.status = T.prog;
  const created = okr(await rq("gpt", { to_actor: "claude" }));
  world.dupRequest = true; requests = [];
  assert.equal((await rq("gpt")).isError, true);
  const a = await ans("claude", created.request_id ?? 1);
  assert.equal(a.isError, true);
  assert.match(JSON.stringify(a.content), /ambiguous/);
  assert.equal(requests.filter((r) => r.method !== "GET").length, 0);
});

test("AUDIT Story transitions also fail closed when a semantic Story status is duplicated (by name and by id)", async () => {
  world.userstory.entity.status = S.prog; world.dupStoryDone = true; requests = [];
  for (const target of ["Done", S.done]) {
    const r = await call("gpt", "taiga_workflow_transition", { entity: "userstory", id: 7, status: target, artifact: { type: "validation_approval", version: "1.0.0" } });
    assert.equal(r.isError, true, String(target));
    assert.match(JSON.stringify(r.content), /ambiguous/);
  }
  assert.equal(requests.filter((x) => x.method !== "GET").length, 0);
});

test("LOOP two templates sharing the same display name and version fail closed (an artifact's Schema line must identify one contract)", () => {
  const tdir = mkdtempSync(join(tmpdir(), "tpl-"));
  try {
    cpSync(templatesDir(), tdir, { recursive: true });
    const f = join(tdir, "correction-blueprint-v1.0.0.md");
    writeFileSync(f, readFileSync(f, "utf8").replace(/^display: .*$/m, "display: Implementation Blueprint"));
    assert.throws(() => loadTemplates(tdir), /already used by another template/);
  } finally { rmSync(tdir, { recursive: true, force: true }); }
});

// ============================ canonical references in governed artifacts ============================
const u = (n) => `0190aaaa-0000-7000-8000-${String(n).padStart(12, "0")}`;

test("REFS: request_create persists `Task <uuid> (#ref)`; repeating the canonical text changes nothing", async () => {
  await release();
  okr(await rq("claude", { question: "Does Task #905 depend on Issue #1 and Story #12?" }));
  assert.ok(lastComment().comment.includes(`Does Task ${u(905)} (#905) depend on Issue ${u(1)} (#1) and Story ${u(12)} (#12)?`));
  okr(await rq("claude", { question: `Again: Task ${u(905)} (#905), plain #9077 and 3 items` }));
  assert.ok(lastComment().comment.includes(`Again: Task ${u(905)} (#905), plain #9077 and 3 items`));
});

test("REFS: request_answer is canonicalized too", async () => {
  await release();
  const r = okr(await rq("claude", { question: "plain question" }));
  okr(await ans("gpt", r.request_id, { answer: "Blocked by Issue #1." }));
  assert.ok(lastComment().comment.includes(`Blocked by Issue ${u(1)} (#1).`));
});

test("REFS: a transition artifact is canonicalized (issue_reference `Issue #1`)", async () => {
  world.task.entity.status = T.prog;
  okr(await tr("claude", T.todo, blocker()));
  assert.ok(lastComment().comment.includes(`${u(1)} (#1)`), lastComment().comment);
  assert.ok(!/Issue #1\b/.test(lastComment().comment));
});

test("REFS: unresolvable reference rejects BEFORE any write (request and transition)", async () => {
  await release();
  const n = world.task.comments.length;
  const refused = (r, re) => { assert.equal(r.isError, true); assert.match(JSON.stringify(payload(r).violations), re); };
  world.noRef = ["tasks:404"];
  refused(await rq("claude", { question: "see Task #404" }), /Task #404 does not exist/);
  world.noRef = [];
  world.uuids = { "issues:1": "" };
  refused(await rq("claude", { question: "see Issue #1" }), /no valid UUIDv7/);
  world.uuids = {};
  refused(await rq("claude", { question: `see Issue ${u(2)} (#1)` }), /has UUID .* not /);
  world.noUuidDef = true;
  refused(await rq("claude", { question: "see Epic #5" }), /initialize_project/);
  world.noUuidDef = false;
  world.task.entity.status = T.prog;
  world.uuids = { "issues:1": "" };
  refused(await tr("claude", T.todo, blocker()), /no valid UUIDv7/);
  world.uuids = {};
  assert.equal(world.task.comments.length, n, "nothing was persisted");
  assert.deepEqual(writes(), [], "the last rejected call wrote nothing; the earlier ones left no comment either");
  assert.equal(world.task.entity.status, T.prog, "status untouched");
});

test("REFS audit: renderArtifact is imported only by the canonicalizing module, so no governed artifact bypasses it", async () => {
  const { readdirSync, readFileSync } = await import("node:fs");
  const hits = [];
  const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const f = `${d}/${e.name}`; if (e.isDirectory()) walk(f); else if (f.endsWith(".ts") && /\brenderArtifact\b/.test(readFileSync(f, "utf8"))) hits.push(f.replace(/^.*\/src\//, "")); } };
  walk(new URL("../src", import.meta.url).pathname);
  assert.deepEqual(hits.sort(), ["workflow/refs.ts", "workflow/render.ts"]);
  const persisters = [];
  const walk2 = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const f = `${d}/${e.name}`; if (e.isDirectory()) walk2(f); else if (f.endsWith(".ts") && /\bpostUnsignedComment\(/.test(readFileSync(f, "utf8")) && !f.endsWith("comment.ts")) persisters.push(f.replace(/^.*\/src\//, "")); } };
  walk2(new URL("../src", import.meta.url).pathname);
  assert.deepEqual(persisters.sort(), ["workflow/mutation.ts"]);
});

test("REFS: untyped #N in a governed artifact is typed by lookup when it is an entity, untouched otherwise", async () => {
  await release();
  okr(await rq("claude", { question: "Covers #905 and #12, ignores #9077 and PR #4040." }));
  assert.ok(lastComment().comment.includes(`Covers Task ${u(905)} (#905) and Story ${u(12)} (#12), ignores #9077 and PR #4040.`), lastComment().comment);
});


// ============================ Human Decision Resolution =======================
const resolution = (o = {}) => ({
  type: "human_decision_resolution", decision_request_comment_id: bySchema("Human Decision Request").at(-1)?.id ?? "0", verdict: "resolved", next_status: "GPT Validation", next_owner: "gpt",
  po_decision: "Option A: keep the current deterministic model", decision_source: "PO told GPT in chat on 2026-11-01", decision_effect: "The run proceeds with the current model",
  constraints_remaining: ["No CV for this run"], resume_instruction: "Continue the Blueprint with the current model.", ...o,
});
const resolve = (role, o, extra = {}) => call(role, "taiga_human_decision_resolve", { task_id: 7, artifact: resolution(o), ...(role ? {} : { author: "Tester" }), ...extra });
const hdState = async () => okr(await state("gpt")).human_decision;
const toHuman = async (blocked = true) => okr(await tr("gpt", T.human, hdr(blocked ? { blocked: true, blocked_note: "gates #480" } : {})));
const blockPatches = () => writes().filter((w) => w.body && "is_blocked" in w.body);

test("human decision resolve: GPT resolves, unblocks only after the artifact persisted, keeps the status, returns next_status", async () => {
  await toHuman();
  assert.equal(world.task.entity.is_blocked, true);
  assert.deepEqual({ ...(await hdState()), note: undefined }, { decision_status: "pending", request_comment_id: cur("Human Decision Request"), resolution_comment_id: null, is_blocked: true, ready_for_po_move: false, next_status: null, next_owner: null, note: undefined });
  const out = okr(await resolve("gpt"));
  assert.equal(out.resolved, true);
  assert.equal(out.status_unchanged, "Human Decision");
  assert.equal(out.unblocked, true);
  assert.equal(out.next_status, "GPT Validation");
  assert.equal(out.next_owner, "gpt");
  assert.equal(out.ready_for_po_move, true);
  assert.equal(world.task.entity.status, T.human, "status never changes");
  assert.equal(world.task.entity.is_blocked, false);
  assert.equal(world.task.entity.blocked_note, "");
  const w = writes();
  assert.equal(w.length, 2, "one comment, one unblock");
  assert.ok(w[0].body.comment && !("status" in w[0].body) && !("is_blocked" in w[0].body), "the artifact is written first, on its own");
  assert.deepEqual({ is_blocked: w[1].body.is_blocked, blocked_note: w[1].body.blocked_note, status: w[1].body.status }, { is_blocked: false, blocked_note: "", status: undefined }, "then the unblock, never a status");
  const lines = lastComment().comment.split("\n");
  assert.deepEqual(lines.slice(0, 3), ["Human Decision → GPT Validation", "Schema: Human Decision Resolution 1.1.0", "Author: GPT"]);
  assert.ok(lines.includes("Movement: intended, not executed (the Task stays in Human Decision until the PO moves it)"));
  assert.ok(lines.includes("Decision authority: PO") && lines.includes("Next status: GPT Validation") && lines.includes(`Decision request: ${cur("Human Decision Request")}`));
  const after = await hdState();
  assert.deepEqual([after.decision_status, after.ready_for_po_move, after.next_status, after.next_owner, after.resolution_comment_id], ["resolved", true, "GPT Validation", "gpt", cur("Human Decision Resolution")]);
  assert.equal(okr(await state("gpt")).owner_role, "po", "the owner stays the PO while the real status is Human Decision");
});

test("human decision resolve: a Task that is already unblocked resolves without any is_blocked write", async () => {
  await toHuman(false);
  const out = okr(await resolve("gpt"));
  assert.equal(out.unblocked, false);
  assert.equal(blockPatches().length, 0);
  assert.equal(world.task.entity.status, T.human);
});

test("human decision resolve: the PO may record it too; Claude may not; syntactic callers are refused", async () => {
  await toHuman();
  reject(await resolve("claude"), "claude", /only GPT or the PO/);
  reject(await resolve(null), "syntactic", /./);
  assert.equal(world.task.entity.is_blocked, true);
  okr(await resolve("po"));
  assert.match(lastComment().comment, /Author: PO/);
});

test("human decision resolve: refused outside Human Decision, without a request, for an unknown id and for a stale one", async () => {
  reject(await resolve("gpt", { decision_request_comment_id: "1" }), "to do", /not in Human Decision/);
  okr(await tr("po", T.human, poDecision())); // PO override: in Human Decision with no request
  assert.equal((await hdState()).decision_status, "pending");
  reject(await resolve("gpt", { decision_request_comment_id: "1" }), "no request", /no Human Decision Request/);
  okr(await tr("po", T.prog, poDecision()));
  await release_noop();
  okr(await tr("claude", T.human, hdr({ resume_target: "In Progress" })));
  const first = cur("Human Decision Request");
  reject(await resolve("gpt", { decision_request_comment_id: "999999" }), "unknown id", /must be the latest/);
  okr(await resolve("gpt", { decision_request_comment_id: first }));
  okr(await tr("po", T.prog, poDecision()));
  okr(await tr("claude", T.human, hdr({ resume_target: "In Progress" })));
  reject(await resolve("gpt", { decision_request_comment_id: first }), "stale", /stale/);
  okr(await resolve("gpt"));
});
async function release_noop() { /* the Task is already In Progress through the PO override above */ }

test("human decision resolve: a second resolution is refused; a retry never writes a second artifact", async () => {
  await toHuman(false);
  okr(await resolve("gpt"));
  reject(await resolve("gpt"), "duplicate", /already resolved/);
  assert.equal(bySchema("Human Decision Resolution").length, 1);
});

test("human decision resolve: an invalid artifact writes nothing", async () => {
  await toHuman();
  reject(await resolve("gpt", { po_decision: undefined }), "missing field", /po_decision is required/);
  reject(await resolve("gpt", { verdict: "approved" }), "bad verdict", /verdict must be one of/);
  reject(await resolve("gpt", { surprise: "x" }), "unknown field", /unknown artifact field/);
  assert.equal(world.task.entity.is_blocked, true);
});

test("human decision resolve: a NEW resolution can only target GPT Validation / gpt, whatever the origin", async () => {
  const bad = [["In Progress", "claude"], ["To Do", "gpt"], ["Done", "po"], ["Request", "gpt"], ["GPT Validation", "claude"], ["GPT Validation", "po"], ["Nowhere", "gpt"]];
  for (const origin of ["todo", "prog", "req", "val"]) {
    world.task.comments = []; world.task.entity.status = T.todo; world.task.entity.is_blocked = false;
    if (origin === "prog") await release();
    if (origin === "req") { await release(); okr(await tr("claude", T.req, reqArt())); }
    if (origin === "val") await toValidation();
    okr(await tr(origin === "req" ? "gpt" : origin === "prog" ? "claude" : "gpt", T.human, hdr()));
    const before = world.task.comments.length;
    for (const [ns, no] of bad) reject(await resolve("gpt", { next_status: ns, next_owner: no }), `${origin} -> ${ns}/${no}`, /./);
    assert.equal(world.task.comments.length, before, "rejections write nothing");
    okr(await resolve("gpt"));
  }
});

test("human decision resolve: a failed persist never unblocks", async () => {
  await toHuman();
  world.dropComments = true;
  const r = await resolve("gpt");
  assert.equal(r.isError, true);
  assert.equal(payload(r).code, "comment_not_persisted");
  assert.equal(blockPatches().length, 0);
  assert.equal(world.task.entity.is_blocked, true);
});

test("human decision resolve: persisted but unblock failed is a partial failure, and the same call finishes it without a second artifact", async () => {
  await toHuman();
  world.failUnblock = true;
  const r = await resolve("gpt");
  assert.equal(r.isError, true);
  assert.equal(payload(r).code, "WORKFLOW_INTEGRITY_FAILURE");
  assert.equal(world.task.entity.is_blocked, true);
  assert.equal(bySchema("Human Decision Resolution").length, 1);
  const st = await hdState();
  assert.deepEqual([st.decision_status, st.ready_for_po_move], ["resolved", false], "not ready while the block remains");
  world.failUnblock = false;
  const out = okr(await resolve("gpt"));
  assert.equal(out.repaired, true);
  assert.equal(out.unblocked, true);
  assert.equal(bySchema("Human Decision Resolution").length, 1, "still one artifact");
  assert.equal(world.task.entity.is_blocked, false);
  assert.equal((await hdState()).ready_for_po_move, true);
});

test("human decision resolve: a new Human Decision after the PO move is an independent round", async () => {
  await toHuman();
  okr(await resolve("gpt"));
  okr(await tr("po", T.val, poDecision())); // the PO moves it manually
  okr(await tr("gpt", T.human, hdr({ blocked: true, blocked_note: "second gate" })));
  assert.equal((await hdState()).decision_status, "pending");
  assert.equal(world.task.entity.is_blocked, true);
  okr(await resolve("gpt"));
  assert.equal(bySchema("Human Decision Resolution").length, 2);
  assert.equal(world.task.entity.is_blocked, false);
});

test("human decision resolve: a Task outside Human Decision reports no human_decision view", async () => {
  assert.equal(okr(await state("gpt")).human_decision, undefined);
});

test("human decision resolve: line 1 is the INTENDED movement `Human Decision → <next_status>`, never `Status unchanged`, and nothing moves", async () => {
  for (const [from, next, owner] of [["todo", "GPT Validation", "gpt"], ["val", "GPT Validation", "gpt"]]) {
    world.task.comments = []; world.task.entity.status = T.todo; world.task.entity.is_blocked = false;
    if (from === "val") await toValidation();
    await toHuman();
    const out = okr(await resolve("gpt", { next_status: next, next_owner: owner }));
    assert.equal(out.ready_for_po_move, true);
    const c = lastComment().comment;
    assert.equal(c.split("\n")[0], `Human Decision → ${next}`);
    assert.ok(!c.includes("Status unchanged"));
    assert.equal(world.task.entity.status, T.human, "the real status stays Human Decision");
    assert.equal(world.task.entity.is_blocked, false);
    const hd = await hdState();
    assert.deepEqual([hd.ready_for_po_move, hd.next_status], [true, next]);
  }
});

test("movement line: artifacts that really have no movement keep `Status unchanged`", async () => {
  await release();
  okr(await rq("claude", { question: "Plain question?" }));
  assert.equal(lastComment().comment.split("\n")[0], "Status unchanged");
});

// ============================ coordinated references ==========================
const coord = async (question) => { okr(await rq("claude", { question })); return lastComment().comment; };
const kinds = () => { world.refKind = { 842: "tasks", 843: "tasks", 844: "userstories", 845: "issues" }; };
const T842 = () => `Task ${u(842)} (#842)`, T843 = () => `Task ${u(843)} (#843)`, S844 = () => `Story ${u(844)} (#844)`;

test("REFS coordinated: each bare #N after a typed ref is looked up on its own, never inheriting the first type", async () => {
  await release(); kinds();
  for (const [input, want] of [
    ["Task #842 and #843.", () => `${T842()} and ${T843()}.`],
    ["Task #842 or #843.", () => `${T842()} or ${T843()}.`],
    ["Task #842 and #844.", () => `${T842()} and ${S844()}.`],
    ["Task #842, #843.", () => `${T842()}, ${T843()}.`],
    ["Task #842, #843 and #844.", () => `${T842()}, ${T843()} and ${S844()}.`],
    ["Task #842, #843 or #844.", () => `${T842()}, ${T843()} or ${S844()}.`],
    ["Tasks #842, #843, #844.", () => `${T842()}, ${T843()}, ${S844()}.`],
    ["Task #842 / #844.", () => `${T842()} / ${S844()}.`],
    ["Task #842/#844.", () => `${T842()}/${S844()}.`],
    ["Task <U842> (#842)/#843.".replace("<U842>", u(842)), () => `${T842()}/${T843()}.`],
    ["Both #842/#843 and #844.", () => `Both ${T842()}/${T843()} and ${S844()}.`],
    ["Task #842 and #845.", () => `${T842()} and Issue ${u(845)} (#845).`],
  ]) assert.ok((await coord(input)).includes(want()), `${input} -> ${lastComment().comment}`);
});

test("REFS coordinated: unknown numbers stay text; canonical + bare mix; idempotent", async () => {
  await release(); kinds();
  assert.ok((await coord("Task #842 and #999.")).includes(`${T842()} and #999.`));
  assert.ok((await coord("Only #997, #998 and #999 here.")).includes("Only #997, #998 and #999 here."));
  assert.ok((await coord(`${T842()} and #843.`)).includes(`${T842()} and ${T843()}.`));
  assert.ok((await coord(`${T842()} and ${T843()} and ${S844()}.`)).includes(`${T842()} and ${T843()} and ${S844()}.`), "already canonical: unchanged");
  assert.ok((await coord("See https://git.example/x/pull/#843 and Task #842.")).includes(`https://git.example/x/pull/#843 and ${T842()}.`), "a slash in a URL is not a coordinator");
});

test("REFS coordinated: code is never interpreted", async () => {
  await release(); kinds();
  const c = await coord("Inline `Task #842 and #843` ok.\n\n```\nTask #842 and #843\n```\n\n    Task #842 and #843\n\nOutside Task #842 and #843.");
  assert.ok(c.includes("Inline `Task #842 and #843` ok."));
  assert.ok(/\n {2}```\n {2}Task #842 and #843\n {2}```/.test(c), "fenced block intact (the renderer indents continuation lines by two)");
  assert.ok(/\n {6}Task #842 and #843\n/.test(c), "indented block intact");
  assert.ok(c.includes(`Outside ${T842()} and ${T843()}.`));
});

test("REFS coordinated: a UUID/integrity problem on ANY coordinated ref rejects the whole artifact before any write", async () => {
  await release(); kinds();
  world.uuids = { "tasks:843": "not-a-uuid" };
  const r = await rq("claude", { question: "Task #842 and #843" });
  assert.equal(r.isError, true);
  assert.match(JSON.stringify(payload(r).violations), /Task #843 has no valid UUIDv7/);
  assert.deepEqual(writes(), []);
  world.uuids = {}; world.noUuidDef = true;
  const r2 = await rq("claude", { question: "Task #842, #843" });
  assert.equal(r2.isError, true);
  assert.deepEqual(writes(), []);
});

test("REFS coordinated: a bare number that matches two kinds fails closed", async () => {
  await release(); world.anyRef = true;
  const r = await rq("claude", { question: "Task #905 and #77" });
  assert.equal(r.isError, true);
  assert.match(JSON.stringify(payload(r).violations), /matches more than one entity kind/);
  assert.deepEqual(writes(), []);
});

// ===== Human Decision always re-enters through GPT Validation =====
test("human decision: the resolution template pins GPT Validation / gpt and has no supersede/repair field", () => {
  const t = latest(loadTemplates(), "human-decision-resolution");
  assert.equal(t.version, "1.1.0");
  assert.deepEqual(t.fields.find((f) => f.key === "next_status").values, ["GPT Validation"]);
  assert.deepEqual(t.fields.find((f) => f.key === "next_owner").values, ["gpt"]);
  assert.ok(!t.fields.some((f) => /supersede/.test(f.key)));
  assert.ok(exact(loadTemplates(), "human-decision-resolution", "1.0.0"), "v1.0.0 stays readable history");
});

test("human decision: a v1.0.0 resolution in history still parses", async () => {
  await toHuman(false);
  const id = cur("Human Decision Request");
  world.task.comments.push({ id: "legacy-res", created_at: new Date(Date.parse(lastComment().created_at) + 500).toISOString(), comment: ["Human Decision → In Progress", "Schema: Human Decision Resolution 1.0.0", "Author: GPT", "Model: Unknown", "Effort: Unknown", "Decision authority: PO", `Decision request: ${id}`, "Verdict: resolved", "Next status: In Progress", "Next owner: claude", "", "# **PO decision**", "x"].join("\n") });
  const hd = await hdState();
  assert.deepEqual([hd.decision_status, hd.resolution_comment_id, hd.next_status], ["resolved", "legacy-res", "In Progress"]);
});

test("human decision: To Do -> Human Decision -> GPT Validation (PO) -> initial Blueprint -> In Progress; Claude cannot skip it", async () => {
  await toHuman(false);
  okr(await resolve("gpt"));
  okr(await tr("po", T.val, poDecision())); // the PO's manual move
  assert.equal(okr(await state("gpt")).owner_role, "gpt");
  // no Blueprint exists: a Correction Blueprint is refused, the initial one is accepted
  reject(await tr("gpt", T.prog, correction()), "correction against nothing", /./);
  okr(await tr("gpt", T.prog, blueprint()));
  assert.equal(world.task.entity.status, T.prog);
  assert.match(bySchema("Implementation Blueprint").at(-1).comment, /Round: 1/);
});

test("human decision: with an existing Blueprint, GPT Validation -> In Progress still needs a Correction Blueprint", async () => {
  await release();
  okr(await tr("claude", T.human, hdr()));
  okr(await resolve("gpt"));
  okr(await tr("po", T.val, poDecision()));
  reject(await tr("gpt", T.prog, blueprint()), "initial over an existing blueprint", /./);
  okr(await tr("gpt", T.prog, correction({ supersedes_blueprint_comment_id: bpId(), validation_round: 1 })));
});

// ============================ Issue #243: Story status is the only lifecycle authority =====================
// Proven live: this Taiga derives userstory.is_closed/finish_date from the child Tasks and ignores writes to them (PATCH is_closed:false, clearing
// finish_date and moving the Story to an open status all leave it closed). The mock reproduces that: closing the last child Task closes the Story, and
// every PATCH on the Story keeps it closed and re-stamps finish_date.
test("last child Task Done: upstream closes the Story physically, the MCP leaves it alone and the Story workflow follows the status only", async () => {
  world.task.entity.user_story = 7;
  const upstream = globalThis.fetch;
  const storyWrites = [];
  globalThis.fetch = async (url, init = {}) => {
    const res = await upstream(url, init);
    const write = (init.method ?? "GET") === "PATCH";
    if (write && /\/tasks\/7$/.test(String(url)) && JSON.parse(init.body).status === T.done && world.lastTask) Object.assign(world.userstory.entity, { is_closed: true, finish_date: "2026-11-06T03:19:46Z" });
    if (write && /\/userstories\/7$/.test(String(url))) { storyWrites.push(JSON.parse(init.body)); if (world.lastTask) Object.assign(world.userstory.entity, { is_closed: true, finish_date: "2026-11-06T03:20:00Z" }); }
    return res;
  };
  await storyInProgress();
  const closeTask = async () => { await toValidation(); okr(await tr("gpt", T.done, approval({ blueprint_comment_id: bpId(), handoff_comment_id: cur("Execution Handoff") }))); };

  world.storyTasks = [{ id: 1001, ref: 901, status: T.done }, { id: 1002, ref: 902, status: T.todo }];
  world.lastTask = false; await closeTask(); // first Task Done
  assert.notEqual(world.userstory.entity.is_closed, true);
  Object.assign(world.task, { comments: [] }); world.task.entity.status = T.todo;

  const writesBefore = storyWrites.length;
  world.storyTasks = [{ id: 1001, ref: 901, status: T.done }, { id: 1002, ref: 902, status: T.done }];
  world.lastTask = true; await closeTask(); // last Task Done: upstream closes the Story physically, the MCP promotes it by status only
  assert.deepEqual([world.userstory.entity.status, world.userstory.entity.is_closed], [S.val, true]);
  assert.equal(storyWrites.length, writesBefore + 2, "exactly two Story writes: the status promotion and its readiness comment");
  assert.ok(storyWrites.every((w) => !("is_closed" in w) && !("finish_date" in w)), "no Story write carries is_closed or finish_date");

  const done = okr(await sttr("gpt", S.done, storyApproval({ handoff_comment_id: lastReadiness() })));
  assert.equal(world.userstory.entity.status, S.done);
  assert.equal(done.closed, true, "closed is the SCOPE meaning of the Done status");
});

test("Story transitions are never refused because is_closed/finish_date contradict the status", async () => {
  await storyInProgress();
  Object.assign(world.userstory.entity, { is_closed: true, finish_date: "2026-11-06T03:19:46Z" });
  const handoff = okr(await sttr("gpt", S.val, storyHandoff()));
  assert.equal(handoff.closed, false, "GPT Validation is workflow-open whatever the physical is_closed says");
  okr(await sttr("gpt", S.prog, storyCorrection({ handoff_comment_id: lastHandoff() })));
  assert.equal(world.userstory.entity.status, S.prog);
});

// ============================ canonical Task precedence (Issue #244) ============
test("governed project: raw taskboard_order and the bulk order tool are refused; taiga_move kind task is the one operation; us_order does not exist", async () => {
  reject(await call("claude", "taiga_tasks_update", { id: 7, taskboard_order: 5, version: 3 }), "taskboard_order on update", /taiga_move/);
  reject(await call("claude", "taiga_tasks_bulk_update_taskboard_order", { project_id: 49, bulk_tasks: [[1, 1], [2, 2]] }), "bulk taskboard_order", /taiga_move/);
  assert.equal((await call("claude", "taiga_tasks_bulk_update_us_order", { project_id: 49, user_story_id: 12, bulk_tasks: [[1, 1], [2, 2]] })).isError, true, "the us_order bulk tool is gone");
  // a plain update without order fields is untouched by the order rule
  okr(await call("claude", "taiga_tasks_update", { id: 7, tags: ["x"], version: 3 }));
  // the canonical move is not blocked by governance (it reaches its own reads/writes)
  const moved = await call("claude", "taiga_move", { kind: "task", id: 7, container_id: 12, direction: "up" });
  assert.notEqual(payload(moved).code, "governance_violation", "the canonical move is allowed");
});

test("governance OFF: the taskboard_order path keeps working (non-governed compatibility)", async () => {
  writeFileSync(join(dir, "governance.json"), JSON.stringify({ enabled: false }));
  okr(await call("claude", "taiga_tasks_update", { id: 7, taskboard_order: 5, version: 3 }));
  okr(await call("claude", "taiga_tasks_bulk_update_taskboard_order", { project_id: 49, bulk_tasks: [[1, 1], [2, 2]] }));
});

// ============================ post-Done Story queue order =======================
import { REVIEW_SUBJECT as FINAL_SUBJECT } from "../dist/workflow/engineering-review.js";

const sprintSetup = (final = true) => {
  Object.assign(world.userstory.entity, { milestone: 300, subject: "A", sprint_order: 1 });
  world.sprintRows = [
    { id: 8, subject: "active", sprint_order: 2, version: 1, milestone: 300, status: S.prog },
    ...(final ? [{ id: 9, subject: FINAL_SUBJECT, sprint_order: 3, version: 1, milestone: 300, status: S.prog }] : []),
    { id: 10, subject: "X", sprint_order: 4, version: 1, milestone: 300, status: S.done },
  ];
};
const queue = () => [world.userstory.entity, ...world.sprintRows].sort((x, y) => x.sprint_order - y.sprint_order).map((r) => r.subject);

test("governed Story Done sinks the Story to the end of the Done history, FINAL stays above it, and STORY_DONE still emits", async () => {
  const sent = fakeNotifier();
  sprintSetup();
  await storyInValidation();
  const r = okr(await sttr("gpt", S.done, storyApproval({ handoff_comment_id: lastHandoff() })));
  assert.equal(world.userstory.entity.status, S.done);
  assert.deepEqual(r.queue_reorder, { moved: true });
  assert.deepEqual(queue(), ["active", FINAL_SUBJECT, "X", "A"]);
  assert.match(sent().at(-1).argv.slice(1).join(" "), /^--type STORY_DONE --story 12 /);
});

test("Story Done with no FINAL in the Sprint sinks the Story to the very end; the handoff reorders nothing", async () => {
  sprintSetup(false);
  await storyInValidation();
  assert.equal(storyWrites().some((w) => w.body?.sprint_order !== undefined), false, "handoff reorders nothing");
  okr(await sttr("gpt", S.done, storyApproval({ handoff_comment_id: lastHandoff() })));
  assert.deepEqual(queue(), ["active", "X", "A"]);
});

test("Story Done without a Sprint is a no-op for the queue", async () => {
  await storyInValidation();
  const r = okr(await sttr("gpt", S.done, storyApproval({ handoff_comment_id: lastHandoff() })));
  assert.deepEqual(r.queue_reorder, { moved: false, reason: "no_sprint" });
});

test("governed Story Cancelled (commented path) sinks the Story after the closed history and reports queue_reorder", async () => {
  sprintSetup();
  await storyInProgress();
  const r = okr(await call("po", "taiga_workflow_transition", { entity: "userstory", id: 7, status: S.canc, comment: "Cancelling the Story by explicit PO decision after review, no longer needed in this Sprint." }));
  assert.equal(world.userstory.entity.status, S.canc);
  assert.deepEqual(r.queue_reorder, { moved: true });
  assert.deepEqual(queue(), ["active", FINAL_SUBJECT, "X", "A"]);
});

test("a failing reorder leaves the Story Done, reports a structured post-persistence failure and still emits STORY_DONE", async () => {
  const sent = fakeNotifier();
  sprintSetup();
  await storyInValidation();
  world.failSprintPatch = true;
  const res = await sttr("gpt", S.done, storyApproval({ handoff_comment_id: lastHandoff() }));
  const r = okr(res);
  assert.equal(world.userstory.entity.status, S.done, "closure persisted");
  assert.equal(r.transitioned, true);
  assert.equal(r.queue_reorder.code, "STORY_QUEUE_REORDER_FAILED");
  assert.match(r.queue_reorder.note, /do not retry/);
  assert.equal(r.notification, "sent");
  assert.match(sent().at(-1).argv.slice(1).join(" "), /^--type STORY_DONE --story 12 /);
});

// ============================ merge authorization (Task 292) ================================
import { generateKeyPairSync } from "node:crypto";
import { verifyMergeAuthorization } from "../dist/workflow/merge-auth.js";
import { strictTransition } from "../dist/workflow/transition.js";

const newPair = () => { const { privateKey, publicKey } = generateKeyPairSync("ed25519"); return { priv: privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"), pub: publicKey.export({ type: "spki", format: "der" }).toString("base64") }; };
const mctx = (o = {}) => ({ repository: "taiga-mcp", source_branch: "feature/task-905-keygen", target_branch: "feature/story-12-signed", source_sha: "a".repeat(40), target_sha: "b".repeat(40), ...o });
afterEach(() => { delete process.env.TAIGA_MCP_MERGE_AUTH_PRIVATE_KEY_B64; });

async function approvedTaskInput() { world.task.entity.user_story = 7; await toValidation(); return approval({ blueprint_comment_id: bpId(), handoff_comment_id: cur("Execution Handoff") }); }

test("merge authorization: a plain Done carries none; with merge_context the signed envelope is issued only after the Done was persisted and re-read", async () => {
  const pair = newPair();
  process.env.TAIGA_MCP_MERGE_AUTH_PRIVATE_KEY_B64 = pair.priv;
  const art = await approvedTaskInput();
  const r = okr(await tr("gpt", T.done, art, { merge_context: mctx() }));
  assert.equal(r.closed, true);
  const env = r.merge_authorization;
  assert.equal(env.claims.action, "task-done");
  assert.equal(env.claims.issuer, "taiga-mcp");
  assert.equal(env.claims.project, 49);
  assert.equal(env.claims.work_item, "Task 0190aaaa-0000-7000-8000-000000000905 (#905)");
  assert.equal(env.claims.target_work_item, "Story 0190aaaa-0000-7000-8000-000000000012 (#12)");
  assert.equal(env.claims.source_sha, "a".repeat(40));
  assert.equal(verifyMergeAuthorization(env, pair.pub), true);
  assert.equal(verifyMergeAuthorization(env, newPair().pub), false, "another key never verifies");
  for (const k of ["action", "project", "work_item", "target_work_item", "repository", "source_branch", "target_branch", "source_sha", "target_sha", "authorization_id", "key_id"]) {
    const t = structuredClone(env); t.claims[k] = k === "project" ? 50 : "x" + t.claims[k]; assert.equal(verifyMergeAuthorization(t, pair.pub), false, `tampered ${k}`);
  }
  const t = structuredClone(env); t.signature = Buffer.alloc(64).toString("base64"); assert.equal(verifyMergeAuthorization(t, pair.pub), false);
  assert.ok(!JSON.stringify(r).includes(pair.priv), "the private key never appears in a result");
  assert.ok(!JSON.stringify(world.task.comments).includes(pair.priv), "nor in a comment");
});

test("merge authorization: an ordinary Done and every other transition issue nothing", async () => {
  process.env.TAIGA_MCP_MERGE_AUTH_PRIVATE_KEY_B64 = newPair().priv;
  const art = await approvedTaskInput();
  const r = okr(await tr("gpt", T.done, art));
  assert.equal(r.merge_authorization, undefined);
  assert.equal(r.merge_authorization_error, undefined);
});

test("merge authorization: invalid context, missing/invalid/non-Ed25519 key and wrong transition are refused before any mutation", async () => {
  const art = await approvedTaskInput();
  const { privateKey: rsa } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  reject(await tr("gpt", T.done, art, { merge_context: mctx() }), "key not configured", /TAIGA_MCP_MERGE_AUTH_PRIVATE_KEY_B64 is not set/);
  process.env.TAIGA_MCP_MERGE_AUTH_PRIVATE_KEY_B64 = "not-a-key";
  reject(await tr("gpt", T.done, art, { merge_context: mctx() }), "garbage key", /not a valid PKCS#8/);
  process.env.TAIGA_MCP_MERGE_AUTH_PRIVATE_KEY_B64 = rsa.export({ type: "pkcs8", format: "der" }).toString("base64");
  reject(await tr("gpt", T.done, art, { merge_context: mctx() }), "rsa key", /not an Ed25519/);
  process.env.TAIGA_MCP_MERGE_AUTH_PRIVATE_KEY_B64 = newPair().priv;
  reject(await tr("gpt", T.done, art, { merge_context: mctx({ source_sha: "abc" }) }), "bad sha", /source_sha/);
  reject(await tr("gpt", T.done, art, { merge_context: mctx({ source_branch: "feature/task-906-other" }) }), "wrong work item ref", /feature\/task-905-/);
  reject(await tr("gpt", T.done, art, { merge_context: mctx({ target_branch: "a..b" }) }), "bad branch", /target_branch/);
  reject(await tr("gpt", T.done, art, { merge_context: { ...mctx(), action: "sprint-done" } }), "caller cannot choose the action", /action is not a known field/);
  assert.equal(world.task.entity.status, T.val, "nothing moved");
});

test("merge authorization: merge_context on a transition that is not an approval to Done is refused", async () => {
  process.env.TAIGA_MCP_MERGE_AUTH_PRIVATE_KEY_B64 = newPair().priv;
  await release();
  reject(await tr("claude", T.val, handoff({ blueprint_comment_id: bpId() }), { merge_context: mctx() }), "handoff with merge_context", /only to the approval/);
});

test("merge authorization: a missing work-item UUID is refused BEFORE the approval is written (no Done without a token)", async () => {
  process.env.TAIGA_MCP_MERGE_AUTH_PRIVATE_KEY_B64 = newPair().priv;
  const art = await approvedTaskInput();
  world.noUuidDef = true;
  reject(await tr("gpt", T.done, art, { merge_context: mctx() }), "no UUID definition", /initialize_project/);
  world.noUuidDef = false;
  world.uuids = { "tasks:905": "" };
  reject(await tr("gpt", T.done, art, { merge_context: mctx() }), "no task UUID", /no valid UUIDv7/);
  assert.equal(world.task.entity.status, T.val);
});

test("merge authorization: the destination comes from Taiga - a Task merges only into its own Story", async () => {
  process.env.TAIGA_MCP_MERGE_AUTH_PRIVATE_KEY_B64 = newPair().priv;
  const art = await approvedTaskInput();
  reject(await tr("gpt", T.done, art, { merge_context: mctx({ target_branch: "main" }) }), "Task to main", /feature\/story-12-/);
  reject(await tr("gpt", T.done, art, { merge_context: mctx({ target_branch: "feature/story-13-other" }) }), "wrong Story", /feature\/story-12-/);
  reject(await tr("gpt", T.done, art, { merge_context: mctx({ target_branch: "feature/sprint-3-x" }) }), "Task to Sprint", /feature\/story-12-/);
  world.task.entity.user_story = null;
  reject(await tr("gpt", T.done, art, { merge_context: mctx() }), "no parent Story", /no parent Story/);
  world.task.entity.user_story = 7;
  world.userstory.entity.project = 50;
  reject(await tr("gpt", T.done, art, { merge_context: mctx() }), "parent Story in another project", /another project/);
  assert.equal(world.task.entity.status, T.val);
});

test("merge authorization: a signing failure after the Done is persisted never undoes it and says not to retry", async () => {
  process.env.TAIGA_MCP_MERGE_AUTH_PRIVATE_KEY_B64 = newPair().priv;
  const art = await approvedTaskInput();
  const boom = () => { throw new Error("signer exploded"); };
  const r = payload(await strictTransition(new TaigaClient(), { mode: "authenticated", actor: actorFor("gpt") }, { entity: "task", id: 7, status: T.done, artifact: art, mergeContext: mctx() }, world.task.entity, boom));
  assert.equal(r.transitioned, true);
  assert.equal(r.closed, true);
  assert.equal(world.task.entity.status, T.done);
  assert.equal(r.merge_authorization, undefined);
  assert.match(r.merge_authorization_error.message, /signer exploded/);
  assert.match(r.merge_authorization_error.note, /do not retry/);
  assert.equal(bySchema("Validation Approval").length, 1, "one approval comment, never repeated");
});

test("merge authorization: a Story approval issues story-done with the Story identity", async () => {
  const pair = newPair();
  process.env.TAIGA_MCP_MERGE_AUTH_PRIVATE_KEY_B64 = pair.priv;
  await storyInValidation();
  world.userstory.entity.milestone = 3;
  const ho = lastHandoff();
  const story = (o) => mctx({ source_branch: "feature/story-12-x", target_branch: "feature/sprint-3-y", ...o });
  reject(await sttr("gpt", S.done, storyApproval({ handoff_comment_id: ho }), { merge_context: story({ target_branch: "main" }) }), "Story to main", /feature\/sprint-3-/);
  reject(await sttr("gpt", S.done, storyApproval({ handoff_comment_id: ho }), { merge_context: story({ target_branch: "feature/sprint-4-y" }) }), "wrong Sprint", /feature\/sprint-3-/);
  world.milestoneProject = 50;
  reject(await sttr("gpt", S.done, storyApproval({ handoff_comment_id: ho }), { merge_context: story() }), "Sprint of another project", /another project/);
  world.milestoneProject = undefined;
  world.userstory.entity.milestone = null;
  reject(await sttr("gpt", S.done, storyApproval({ handoff_comment_id: ho }), { merge_context: story() }), "no Sprint", /no Sprint/);
  world.userstory.entity.milestone = 3;
  const r = okr(await sttr("gpt", S.done, storyApproval({ handoff_comment_id: ho }), { merge_context: story() }));
  assert.equal(r.merge_authorization.claims.target_work_item, "Sprint #3");
  assert.equal(r.merge_authorization.claims.action, "story-done");
  assert.match(r.merge_authorization.claims.work_item, /^Story 0190aaaa-0000-7000-8000-000000000012 \(#12\)$/);
  assert.equal(verifyMergeAuthorization(r.merge_authorization, pair.pub), true);
});

// ============================ signed authorization on the completion notice (Task 293) ================================
function stdinNotifier(exitCode = 0) {
  const log = join(dir, "notify-stdin.log");
  const script = join(dir, "notify-stdin.ts");
  writeFileSync(script, `import { appendFileSync } from "node:fs"; let d = ""; process.stdin.on("data", (c) => (d += c)); process.stdin.on("end", () => { appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: process.argv.slice(2), stdin: d }) + "\\n"); process.exit(${exitCode}); });`);
  process.env.TAIGA_MCP_NOTIFY_COMMAND = JSON.stringify([process.execPath, script, "notify"]);
  return () => { try { return readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
}
afterEach(() => { delete process.env.TAIGA_MCP_NOTIFY_AUTH_STDIN; });

test("signed notice: the exact after-Done envelope reaches the notifier over stdin, never argv, only on TASK_DONE", async () => {
  const sent = stdinNotifier();
  process.env.TAIGA_MCP_NOTIFY_AUTH_STDIN = "1";
  process.env.TAIGA_MCP_MERGE_AUTH_PRIVATE_KEY_B64 = newPair().priv;
  const art = await approvedTaskInput();
  assert.deepEqual(sent().map((x) => x.stdin), ["", ""], "TASK_RELEASED and TASK_MOVED_TO_GPT_VALIDATION carry nothing");
  const r = okr(await tr("gpt", T.done, art, { merge_context: mctx() }));
  const last = sent().at(-1);
  assert.match(last.argv.join(" "), /--type TASK_DONE/);
  assert.deepEqual(JSON.parse(last.stdin), { authorization: r.merge_authorization }, "exactly the envelope returned to the caller");
  assert.ok(!last.argv.join(" ").includes(r.merge_authorization.signature), "never on argv");
  assert.equal(r.merge_authorization_handoff, "attempted_unconfirmed", "exit 0 never proves receipt");
  assert.equal(r.notification, "sent");
});

test("signed notice: off by default, absent without merge_context, and a Story completion carries it too", async () => {
  const sent = stdinNotifier();
  process.env.TAIGA_MCP_MERGE_AUTH_PRIVATE_KEY_B64 = newPair().priv;
  const art = await approvedTaskInput();
  const off = okr(await tr("gpt", T.done, art, { merge_context: mctx() }));
  assert.equal(sent().at(-1).stdin, "", "opt-in is off by default");
  assert.equal(off.merge_authorization_handoff, "not_attempted");
  assert.ok(off.merge_authorization, "the caller still has the envelope");
});

test("signed notice: no merge_context means no token and no handoff field", async () => {
  const sent = stdinNotifier();
  process.env.TAIGA_MCP_NOTIFY_AUTH_STDIN = "1";
  const art = await approvedTaskInput();
  const r = okr(await tr("gpt", T.done, art));
  assert.equal(sent().at(-1).stdin, "");
  assert.equal(r.merge_authorization, undefined);
  assert.equal(r.merge_authorization_handoff, undefined);
});

test("signed notice: a Story completion carries the envelope; a failing notifier keeps the Done and returns the same envelope", async () => {
  const sent = stdinNotifier(1);
  process.env.TAIGA_MCP_NOTIFY_AUTH_STDIN = "1";
  process.env.TAIGA_MCP_MERGE_AUTH_PRIVATE_KEY_B64 = newPair().priv;
  await storyInValidation();
  world.userstory.entity.milestone = 3;
  const ho = lastHandoff();
  const r = okr(await sttr("gpt", S.done, storyApproval({ handoff_comment_id: ho }), { merge_context: mctx({ source_branch: "feature/story-12-x", target_branch: "feature/sprint-3-y" }) }));
  const last = sent().at(-1);
  assert.match(last.argv.join(" "), /--type STORY_DONE/);
  assert.deepEqual(JSON.parse(last.stdin), { authorization: r.merge_authorization });
  assert.equal(r.notification, "failed");
  assert.equal(r.merge_authorization_handoff, "failed");
  assert.equal(world.userstory.entity.status, S.done, "the Done stands");
  assert.equal(sc().filter((c) => (c.comment.split("\n")[1] ?? "").startsWith("Schema: Story Validation Approval ")).length, 1, "no repeated approval");
});

test("signed notice: a notifier that never reads stdin does not break the delivery result", async () => {
  fakeNotifier();
  process.env.TAIGA_MCP_NOTIFY_AUTH_STDIN = "1";
  process.env.TAIGA_MCP_MERGE_AUTH_PRIVATE_KEY_B64 = newPair().priv;
  const art = await approvedTaskInput();
  const r = okr(await tr("gpt", T.done, art, { merge_context: mctx() }));
  assert.equal(r.closed, true);
  assert.ok(r.merge_authorization);
  assert.equal(r.notification, "sent", "the pointer command succeeded");
  assert.equal(r.merge_authorization_handoff, "attempted_unconfirmed", "but a notifier that never read stdin is not a confirmed receipt");
});

// ---- Task #344 correction: the final Sprint Task completes BEFORE merge preparation (acyclic: final Task Done -> FINAL Story Done -> prepare -> confirm -> close) ----
const FINAL_TASK = "Final GPT validation of the Sprint";
async function finalTaskApproval() {
  Object.assign(world.task.entity, { subject: FINAL_TASK, milestone: 3, user_story: 12 });
  world.userstory.entity.subject = "FINAL Sprint Engineering Review";
  await toValidation();
  return tr("gpt", T.done, approval({ blueprint_comment_id: bpId(), handoff_comment_id: cur("Execution Handoff") }));
}

test("the final Sprint Task can be Done with no merge prepared or confirmed (the merge gate belongs to prepare/close, which wait for the FINAL Story)", async () => {
  okr(await finalTaskApproval());
  assert.equal(world.task.entity.status, T.done);
});


// ============================ mechanical Story readiness promotion (Issue #335) =======================
const readinessComments = () => sc().filter((c) => (c.comment.split("\n")[1] ?? "").startsWith("Schema: Story Readiness Promotion "));
const approveTask = async () => { await toValidation(); return okr(await tr("gpt", T.done, approval({ blueprint_comment_id: bpId(), handoff_comment_id: cur("Execution Handoff") }))); };
const withStoryTask = async () => { world.task.entity.user_story = 7; await storyInProgress(); };

test("last child Task Done promotes the Story In Progress -> GPT Validation once, with a mechanical readiness comment, and GPT approves citing it", async () => {
  await withStoryTask();
  const r = await approveTask();
  assert.deepEqual([r.story_promotion.promoted, r.story_promotion.story], [true, 7]);
  assert.equal(world.userstory.entity.status, S.val);
  const [c] = readinessComments();
  assert.match(c.comment, /^In Progress → GPT Validation\nSchema: Story Readiness Promotion 1\.0\.0\nAuthor: GPT/);
  assert.match(c.comment, /\*\*Triggering Task\*\*\n/);
  assert.match(c.comment, /\*\*Child Tasks\*\*\n- ref: 901; status: Done\n- ref: 902; status: Done/);
  assert.doesNotMatch(c.comment, /Acceptance criteria|Commits|tests passed/i, "no acceptance, commit or test evidence is claimed");
  const done = okr(await sttr("gpt", S.done, storyApproval({ handoff_comment_id: lastReadiness() })));
  assert.equal(done.closed, true);
  assert.equal(world.userstory.entity.status, S.done, "Done is only the explicit GPT approval");
});

test("last child Task Cancelled counts as terminal: the Story is promoted and the Cancelled child stays visible in the readiness comment", async () => {
  await withStoryTask();
  world.storyTasks = [{ id: 1001, ref: 901, status: T.done }, { id: 1002, ref: 902, status: T.canc }];
  const r = okr(await tr("gpt", T.canc, poDecision({ instruction_reference: "PO, chat 2026-11-10: cancel" })));
  assert.equal(r.story_promotion.promoted, true);
  assert.equal(world.userstory.entity.status, S.val);
  assert.match(readinessComments()[0].comment, /ref: 902; status: Cancelled/);
});

test("a non-terminal sibling, a standalone Task and a Story that is not In Progress promote nothing", async () => {
  await withStoryTask();
  world.storyTasks = [{ id: 1001, ref: 901, status: T.done }, { id: 1002, ref: 902, status: T.human }];
  assert.deepEqual((await approveTask()).story_promotion, { promoted: false, reason: "children_not_terminal" });
  assert.equal(world.userstory.entity.status, S.prog);
  assert.equal(readinessComments().length, 0);
  world.task.entity.user_story = null; world.task.entity.status = T.todo; world.task.comments = [];
  world.storyTasks = [{ id: 1001, ref: 901, status: T.done }];
  assert.deepEqual((await approveTask()).story_promotion, { promoted: false, reason: "no_story" });
  world.task.entity.user_story = 7; world.task.entity.status = T.todo; world.task.comments = []; world.userstory.entity.status = S.ready;
  assert.deepEqual((await approveTask()).story_promotion, { promoted: false, reason: "story_not_in_progress" });
  assert.equal(readinessComments().length, 0);
});

test("replay: a later terminal transition on a Story already in GPT Validation writes no second promotion or readiness comment", async () => {
  await withStoryTask();
  await approveTask();
  world.task.entity.status = T.todo; world.task.comments = [];
  assert.deepEqual((await approveTask()).story_promotion, { promoted: false, reason: "story_not_in_progress" });
  assert.equal(readinessComments().length, 1);
});

test("a lost status claim (concurrent promotion) leaves the Story In Progress, is reported without failing the Task, and the next attempt reuses the comment instead of duplicating it", async () => {
  await withStoryTask();
  const upstream = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => (init.method === "PATCH" && /\/userstories\/7$/.test(String(url)) && JSON.parse(init.body).status === S.val
    ? new Response(JSON.stringify({ _error_message: "version conflict" }), { status: 409 }) : upstream(url, init));
  try {
    const r = await approveTask();
    assert.equal(r.transitioned, true);
    assert.equal(r.story_promotion.code, "STORY_READINESS_PROMOTION_FAILED");
    assert.equal(world.userstory.entity.status, S.prog, "never in GPT Validation");
    assert.equal(readinessComments().length, 1, "the unused mechanical comment stays");
  } finally { globalThis.fetch = upstream; }
  world.task.entity.status = T.todo; world.task.comments = [];
  const again = await approveTask();
  assert.equal(again.story_promotion.promoted, true);
  assert.equal(again.story_promotion.comment_id, readinessComments()[0].id);
  assert.equal(readinessComments().length, 1, "reused, not duplicated");
  assert.equal(world.userstory.entity.status, S.val);
});

test("comment write failure, even with every later Story write failing too, never moves the Story: no status write is attempted before the comment is proven", async () => {
  await withStoryTask();
  const upstream = globalThis.fetch;
  const statusWrites = [];
  globalThis.fetch = async (url, init = {}) => {
    if (init.method === "PATCH" && /\/userstories\/7$/.test(String(url))) {
      const body = JSON.parse(init.body);
      if ("status" in body) statusWrites.push(body);
      return new Response("{}", { status: 500 });
    }
    return upstream(url, init);
  };
  try {
    const r = await approveTask();
    assert.equal(r.transitioned, true, "the Task transition stays valid");
    assert.equal(r.story_promotion.code, "STORY_READINESS_PROMOTION_FAILED");
    assert.deepEqual(statusWrites, [], "the Story status is never written without its predecessor");
    assert.equal(world.userstory.entity.status, S.prog);
    assert.equal(readinessComments().length, 0);
  } finally { globalThis.fetch = upstream; }
});

test("a manual Story Validation Handoff still works for a Story that was not auto-promoted", async () => {
  await storyInValidation();
  okr(await sttr("gpt", S.done, storyApproval({ handoff_comment_id: lastHandoff() })));
  assert.equal(world.userstory.entity.status, S.done);
});

// ============================ durable workflow continuations (Issue #335) =======================
import { foldContinuations, pendingContinuations } from "../dist/workflow/continuation.js";
const folded = () => [...foldContinuations().values()];

test("Claude hands a Task to GPT Validation with the notifier DISABLED: the GPT continuation is persisted anyway and stays pending", async () => {
  delete process.env.TAIGA_MCP_NOTIFY_COMMAND;
  await release();
  const r = okr(await tr("claude", T.val, handoff({ blueprint_comment_id: bpId() })));
  assert.equal(r.notification, "disabled");
  assert.equal(r.continuation.recorded, true);
  const [c] = pendingContinuations("gpt");
  assert.deepEqual([c.type, c.to, c.from, c.entity, c.state], ["TASK_MOVED_TO_GPT_VALIDATION", "gpt", "claude", "task", "pending"]);
  assert.equal(c.id, r.continuation.id);
});

test("Task Done persists one Claude continuation; the mechanical Story promotion persists one GPT continuation", async () => {
  await withStoryTask();
  const r = await approveTask();
  assert.deepEqual(pendingContinuations("claude").map((c) => c.type), ["TASK_RELEASED", "TASK_DONE"], "the release and the Done, each once");
  assert.deepEqual(pendingContinuations("gpt").filter((c) => c.type === "STORY_READY_FOR_VALIDATION").map((c) => c.source), [r.story_promotion.comment_id], "exactly one, tied to the readiness comment");
  assert.equal(r.story_promotion.continuation.recorded, true);
});

test("Workflow Request resolved while Claude is offline: the continuation survives, delivered stays open, handled closes it once", async () => {
  const opened = okr(await rq("claude", { blocking: false }));
  assert.equal(pendingContinuations("gpt").length, 1, "the open request is GPT work");
  const resolved = okr(await ans("gpt", opened.request_id));
  const c = pendingContinuations("claude").find((x) => x.type === "WORKFLOW_REQUEST_RESOLVED");
  assert.equal(c.request_id, opened.request_id);
  assert.equal(resolved.continuation.id, c.id);
  const del = okr(await call("claude", "taiga_continuation_ack", { id: c.id, ack: "delivered" }));
  assert.deepEqual([del.state, del.already], ["delivered", false]);
  assert.equal(pendingContinuations("claude").some((x) => x.id === c.id), true, "delivery never implies handled");
  const h1 = okr(await call("claude", "taiga_continuation_ack", { id: c.id, ack: "handled" }));
  const h2 = okr(await call("claude", "taiga_continuation_ack", { id: c.id, ack: "handled" }));
  assert.deepEqual([h1.state, h1.already, h2.already], ["handled", false, true]);
  assert.equal(pendingContinuations("claude").some((x) => x.id === c.id), false);
  assert.equal(folded().filter((x) => x.id === c.id).length, 1);
});

test("continuation tools: actor-scoped pending list, addressee-only ack, unknown id refused, identity required", async () => {
  const opened = okr(await rq("claude"));
  const mine = okr(await call("gpt", "taiga_continuations_pending", {}));
  assert.deepEqual([mine.actor, mine.count], ["gpt", 1]);
  assert.equal(okr(await call("claude", "taiga_continuations_pending", {})).count, 0, "Claude does not see GPT's work");
  reject(await call("claude", "taiga_continuations_pending", { actor: "gpt" }), "other actor", /only the PO/);
  assert.equal(okr(await call("po", "taiga_continuations_pending", { actor: "gpt" })).count, 1);
  assert.equal(okr(await call("gpt", "taiga_continuations_pending", { project: 999 })).count, 0, "project scope");
  const id = mine.continuations[0].id;
  assert.equal(opened.request_id, mine.continuations[0].request_id);
  reject(await call("claude", "taiga_continuation_ack", { id, ack: "handled" }), "wrong addressee", /addressed to gpt/);
  reject(await call("gpt", "taiga_continuation_ack", { id: "nope", ack: "handled" }), "unknown id", /no continuation/);
  reject(await call(null, "taiga_continuation_ack", { id, ack: "handled" }), "syntactic ack", /authenticated actor identity is required/);
});

test("duplicate emission and restart converge to one logical continuation", async () => {
  const { recordContinuation, continuationOf } = await import("../dist/workflow/continuation.js");
  const c = continuationOf("TASK_DONE", "claude", "gpt", "task", 7, 49, "cmt-1");
  assert.equal(recordContinuation(c).duplicate, false);
  assert.equal(recordContinuation({ ...c, created_at: "later" }).duplicate, true);
  appendFileSync(process.env.TAIGA_MCP_CONTINUATION_FILE, '{"op":"emit","id":"torn'); // a crash tail
  assert.equal(foldContinuations().size, 1, "a fresh fold (restart) still has exactly one, the torn line is skipped");
  assert.equal(pendingContinuations("claude")[0].state, "pending");
});

// ---- recovery of a lost continuation from authoritative Taiga state (Task 339 correction) ----
const brokenStore = () => { process.env.TAIGA_MCP_CONTINUATION_FILE = join(dir, "missing-dir", "continuations.jsonl"); };
const repairedStore = () => { process.env.TAIGA_MCP_CONTINUATION_FILE = join(dir, "continuations.jsonl"); };

test("recovery: the ledger append failed after Task -> GPT Validation persisted; once writable, pending read rebuilds exactly one GPT continuation and a later normal duplicate folds into it", async () => {
  delete process.env.TAIGA_MCP_NOTIFY_COMMAND;
  brokenStore();
  await release();
  const r = okr(await tr("claude", T.val, handoff({ blueprint_comment_id: bpId() })));
  assert.equal(r.continuation.recorded, false, "the append failed, the Task transition stayed valid");
  assert.equal(world.task.entity.status, T.val);
  repairedStore();
  assert.equal(foldContinuations().size, 0, "nothing recorded yet");
  const listed = okr(await call("gpt", "taiga_continuations_pending", { project: 49 }));
  assert.equal(listed.recovery.recovered >= 1, true);
  const mine = listed.continuations.filter((c) => c.type === "TASK_MOVED_TO_GPT_VALIDATION");
  assert.equal(mine.length, 1);
  assert.equal(mine[0].id, r.continuation.id, "recovered identity equals normal emission identity");
  const again = okr(await call("gpt", "taiga_continuations_pending", { project: 49 }));
  assert.equal(again.recovery.recovered, 0, "idempotent: nothing new on the second read");
  assert.equal(again.continuations.filter((c) => c.type === "TASK_MOVED_TO_GPT_VALIDATION").length, 1);
});

test("recovery: Request resolved while the append failed is rebuilt for the asker with its request id, and a handled one is never resurrected", async () => {
  const opened = okr(await rq("claude", { blocking: true }));
  world.task.entity.status = T.req; // Claude moved the card into Request (state is what recovery reads)
  brokenStore();
  const resolved = okr(await ans("gpt", opened.request_id));
  assert.equal(resolved.continuation.recorded, false);
  repairedStore();
  const listed = okr(await call("claude", "taiga_continuations_pending", { project: 49 }));
  const c = listed.continuations.find((x) => x.type === "WORKFLOW_REQUEST_RESOLVED");
  assert.equal(c.request_id, opened.request_id);
  assert.equal(c.id, resolved.continuation.id);
  okr(await call("claude", "taiga_continuation_ack", { id: c.id, ack: "handled" }));
  const after = okr(await call("claude", "taiga_continuations_pending", { project: 49 }));
  assert.equal(after.continuations.some((x) => x.id === c.id), false, "handled stays handled across a rebuild");
  assert.equal(foldContinuations().get(c.id).state, "handled");
});

test("recovery: a Taiga read failure is reported without hiding what the ledger already holds", async () => {
  delete process.env.TAIGA_MCP_NOTIFY_COMMAND;
  await release();
  okr(await tr("claude", T.val, handoff({ blueprint_comment_id: bpId() })));
  world.milestones = { not: "a list" };
  const listed = okr(await call("gpt", "taiga_continuations_pending", { project: 49 }));
  assert.equal(typeof listed.recovery.error, "string");
  assert.equal(listed.continuations.some((c) => c.type === "TASK_MOVED_TO_GPT_VALIDATION"), true);
});

test("recovery: Story readiness and Task Done lost with the ledger are rebuilt with the same ids; a Done Story's own Tasks stay history", async () => {
  sprintSetup(false);
  world.sprintRows.forEach((r) => { r.status = S.prog; }); // the mock serves ONE Story history for every id, so other rows must not look Done
  await withStoryTask();
  brokenStore();
  const r = await approveTask();
  assert.equal(r.story_promotion.continuation.recorded, false);
  repairedStore();
  const gpt = okr(await call("gpt", "taiga_continuations_pending", { project: 49 }));
  const ready = gpt.continuations.find((c) => c.type === "STORY_READY_FOR_VALIDATION");
  assert.equal(ready.id, r.story_promotion.continuation.id);
  const claude = okr(await call("claude", "taiga_continuations_pending", { project: 49 }));
  assert.equal(claude.continuations.filter((c) => c.type === "TASK_DONE").length, 1);
  okr(await sttr("gpt", S.done, storyApproval({ handoff_comment_id: lastReadiness() })));
  const afterDone = okr(await call("claude", "taiga_continuations_pending", { project: 49 }));
  assert.equal(afterDone.continuations.filter((c) => c.type === "STORY_DONE").length, 1, "the approved Story is Claude's merge work");
  assert.equal(afterDone.continuations.filter((c) => c.type === "TASK_DONE").length, 1, "the earlier Task Done is not duplicated");
});

// ============================ end-to-end no-stall proof (Story 337 / Issue 335) =======================
// Governed calls only, notifier DISABLED: correctness never depends on the Bridge. The consumer re-reads Taiga before every step.
const reread = async (role, id = 7) => payload(await call(role, "taiga_userstories_get", { id, format: "json" }));
const storyDoneWrites = () => requests.filter((r) => r.method === "PATCH" && /\/userstories\/7$/.test(r.path) && r.body?.status === S.done);

test("E2E: final child Done -> Story auto-promoted once -> GPT continuation -> GPT re-reads -> explicit approval is still required -> handled closes it", async () => {
  delete process.env.TAIGA_MCP_NOTIFY_COMMAND;
  await withStoryTask();
  const done = await approveTask();
  assert.equal(done.notification, "disabled", "no Bridge involved");
  assert.equal(done.story_promotion.promoted, true);
  assert.equal(world.userstory.entity.status, S.val, "promoted by the MCP, exactly once");
  assert.equal(readinessComments().length, 1);

  const ready = pendingContinuations("gpt").find((c) => c.type === "STORY_READY_FOR_VALIDATION");
  assert.ok(ready, "GPT has a durable obligation without any notification");
  const seen = await reread("gpt");
  assert.equal(seen.status, S.val, "GPT re-reads the authoritative Story state");
  assert.equal(world.userstory.entity.status, S.val, "reading and the continuation did NOT approve or close the Story");

  assert.equal(okr(await call("gpt", "taiga_continuation_ack", { id: ready.id, ack: "delivered" })).state, "delivered");
  assert.equal(pendingContinuations("gpt").some((c) => c.id === ready.id), true, "delivery never closes it");
  assert.equal(world.userstory.entity.status, S.val, "still waiting for the explicit approval");

  okr(await sttr("gpt", S.done, storyApproval({ handoff_comment_id: lastReadiness() }))); // the explicit cumulative approval
  assert.equal(world.userstory.entity.status, S.done);
  assert.equal(okr(await call("gpt", "taiga_continuation_ack", { id: ready.id, ack: "handled" })).state, "handled");
  assert.equal(pendingContinuations("gpt").some((c) => c.id === ready.id), false);
  assert.equal(pendingContinuations("claude").some((c) => c.type === "STORY_DONE"), true, "Claude's merge work after Done is durable too");
});

test("E2E: a Cancelled child among Done siblings gives readiness only; GPT still decides acceptance and nothing closes the Story", async () => {
  delete process.env.TAIGA_MCP_NOTIFY_COMMAND;
  await withStoryTask();
  world.storyTasks = [{ id: 1001, ref: 901, status: T.done }, { id: 1002, ref: 902, status: T.canc }];
  const r = okr(await tr("gpt", T.canc, poDecision({ instruction_reference: "PO, chat 2026-11-10: this Task is no longer needed" })));
  assert.equal(r.story_promotion.promoted, true);
  assert.match(readinessComments()[0].comment, /ref: 902; status: Cancelled/, "the Cancelled child stays visible to GPT");
  assert.equal(world.userstory.entity.status, S.val);
  assert.equal(storyDoneWrites().length, 0);
});

test("E2E: Request resolved while Claude is offline -> durable continuation -> authoritative re-read -> valid resume -> handled; replays and a ledger loss converge to the same ids", async () => {
  delete process.env.TAIGA_MCP_NOTIFY_COMMAND;
  await toRequest();
  assert.equal(world.task.entity.status, T.req);
  assert.equal(pendingContinuations("gpt").some((c) => c.type === "WORKFLOW_REQUEST_OPENED"), true, "GPT owes an answer");
  const answered = okr(await ans("gpt", "R-905-1")); // Claude is offline: nothing delivered to it
  const c = pendingContinuations("claude").find((x) => x.type === "WORKFLOW_REQUEST_RESOLVED");
  assert.equal(c.id, answered.continuation.id);

  for (let i = 0; i < 3; i++) await call("claude", "taiga_continuations_pending", { project: 49 }); // repeated reads, no duplicates
  assert.equal(foldContinuations().size, new Set([...foldContinuations().keys()]).size);
  assert.equal(pendingContinuations("claude").filter((x) => x.type === "WORKFLOW_REQUEST_RESOLVED").length, 1);

  const state = payload(await call("claude", "taiga_task_workflow_state", { id: 7 })); // Claude re-reads Taiga before acting
  assert.equal(state.request_status.in_request, true);
  assert.equal(world.task.entity.status, T.req, "the continuation alone moved nothing");
  okr(await tr("claude", T.prog, resume({ response_comment_id: answered.comment_id }))); // the allowed workflow step
  assert.equal(world.task.entity.status, T.prog);
  okr(await call("claude", "taiga_continuation_ack", { id: c.id, ack: "handled" }));
  assert.equal(pendingContinuations("claude").some((x) => x.id === c.id), false);

  const open = pendingContinuations("claude").map((x) => x.id).sort();
  rmSync(process.env.TAIGA_MCP_CONTINUATION_FILE); // total ledger loss
  const rebuilt = okr(await call("claude", "taiga_continuations_pending", { project: 49 }));
  assert.deepEqual(rebuilt.continuations.map((x) => x.id).sort(), open, "the open obligations come back with identical ids");
  assert.equal(rebuilt.continuations.some((x) => x.type === "WORKFLOW_REQUEST_RESOLVED"), false, "a finished Request is not rebuilt");
  assert.equal(okr(await call("claude", "taiga_continuations_pending", { project: 49 })).recovery.recovered, 0, "and a second read adds nothing");
});

// ---- handled evidence survives total ledger loss (Task 342, Issue 341) ----
const handledMarkers = (kind) => world[kind].comments.filter((c) => (c.comment.split("\n")[1] ?? "").startsWith("Schema: Continuation Handled "));
const lose = () => rmSync(process.env.TAIGA_MCP_CONTINUATION_FILE);
const ackAs = (role, id, ack) => call(role, "taiga_continuation_ack", { id, ack });
async function doneStory() { sprintSetup(false); world.sprintRows.forEach((r) => { r.status = S.prog; }); await withStoryTask(); return approveTask(); }

test("handled TASK_DONE: after total ledger loss it is not resurrected; the marker is one auditable comment and a repeated ack adds none", async () => {
  await doneStory();
  const id = pendingContinuations("claude").find((c) => c.type === "TASK_DONE").id;
  assert.equal(okr(await ackAs("claude", id, "handled")).state, "handled");
  assert.equal(handledMarkers("task").length, 1);
  assert.match(handledMarkers("task")[0].comment, new RegExp(`^Status unchanged\\nSchema: Continuation Handled 1\\.0\\.0\\nAuthor: Claude Code[\\s\\S]*Continuation: ${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.equal(okr(await ackAs("claude", id, "handled")).already, true);
  assert.equal(handledMarkers("task").length, 1, "idempotent: no duplicate evidence");
  const status = world.task.entity.status;
  lose();
  const after = okr(await call("claude", "taiga_continuations_pending", { project: 49 }));
  assert.equal(after.continuations.some((c) => c.type === "TASK_DONE"), false, "handled Done work is not rebuilt");
  assert.equal(world.task.entity.status, status, "the acknowledgement moved no card");
});

test("handled STORY_DONE is not resurrected after ledger loss, while an unhandled one is rebuilt exactly once", async () => {
  await doneStory();
  okr(await sttr("gpt", S.done, storyApproval({ handoff_comment_id: lastReadiness() })));
  const story = pendingContinuations("claude").find((c) => c.type === "STORY_DONE");
  lose();
  const rebuilt = okr(await call("claude", "taiga_continuations_pending", { project: 49 }));
  assert.deepEqual(rebuilt.continuations.filter((c) => c.type === "STORY_DONE").map((c) => c.id), [story.id], "outstanding Done work stays recoverable with the same id");
  assert.equal(okr(await call("claude", "taiga_continuations_pending", { project: 49 })).recovery.recovered, 0);
  okr(await ackAs("claude", story.id, "handled"));
  assert.equal(handledMarkers("userstory").length, 1);
  lose();
  const again = okr(await call("claude", "taiga_continuations_pending", { project: 49 }));
  assert.equal(again.continuations.some((c) => c.type === "STORY_DONE"), false, "now handled: gone for good");
});

test("a delivered-only ack leaves no handled evidence: after ledger loss it is rebuilt as pending, never as handled", async () => {
  await doneStory();
  const id = pendingContinuations("claude").find((c) => c.type === "TASK_DONE").id;
  okr(await ackAs("claude", id, "delivered"));
  assert.equal(handledMarkers("task").length, 0);
  lose();
  const rebuilt = okr(await call("claude", "taiga_continuations_pending", { project: 49 }));
  assert.equal(rebuilt.continuations.find((c) => c.id === id).state, "pending");
});

test("if the handled evidence cannot be written to Taiga nothing is acknowledged and a retry succeeds", async () => {
  await doneStory();
  const id = pendingContinuations("claude").find((c) => c.type === "TASK_DONE").id;
  const upstream = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => (init.method === "PATCH" && /\/tasks\/\d+$/.test(String(url)) && "comment" in JSON.parse(init.body) ? new Response("{}", { status: 500 }) : upstream(url, init));
  try { reject(await ackAs("claude", id, "handled"), "evidence write failed", /handled evidence could not be written/); } finally { globalThis.fetch = upstream; }
  assert.equal(foldContinuations().get(id).state, "pending", "the ledger was not touched");
  assert.equal(okr(await ackAs("claude", id, "handled")).state, "handled");
  assert.equal(handledMarkers("task").length, 1);
});

// Issue #311 / Task 312 (CI-safe, Issue #348 / Task 350): the GPT-first ownership rule is pinned in the TRACKED templates that route work between the agents.
// knowledge-base/ is an independent repository, absent from a clean checkout, so no test here reads it.
test("GPT-first execution ownership is carried by the Blueprint and Request templates, capability-based and without a new status", () => {
  const blueprint = readFileSync(join(templatesDir(), "implementation-blueprint-v1.0.0.md"), "utf8");
  assert.match(blueprint, /GPT-first ownership/); assert.match(blueprint, /GPT executes directly/);
  const request = readFileSync(join(templatesDir(), "workflow-request-v1.0.0.md"), "utf8");
  assert.match(request, /GPT-first ownership/); assert.match(request, /performs no equivalent side effect/);
});

// Task 381: Assigned is a projection of the authoritative owner, written with the status and verified; an unresolvable owner writes nothing.
const ACCOUNTS = { TAIGA_MCP_EXPECTED_ACCOUNT_GPT: "chatgpt", TAIGA_MCP_EXPECTED_ACCOUNT_CLAUDE: "claudecode", TAIGA_MCP_EXPECTED_ACCOUNT_PO: "po" };
const withAccounts = async (fn) => {
  Object.assign(process.env, ACCOUNTS);
  world.accounts = { gpt: "chatgpt", claude: "claudecode", po: "po" };
  world.users = [{ id: 71, username: "chatgpt", is_active: true }, { id: 72, username: "claudecode", is_active: true }, { id: 73, username: "po", is_active: true }];
  try { await fn(); } finally { for (const k of Object.keys(ACCOUNTS)) delete process.env[k]; }
};

test("Assigned follows the owner: In Progress -> ClaudeCode, GPT Validation -> ChatGPT, written with the status", async () => {
  await withAccounts(async () => {
    world.me = "chatgpt";
    await release();
    assert.equal(world.task.entity.assigned_to, 72, "In Progress is Claude-owned");
    assert.equal(writes().filter((w) => w.path === "/tasks/7" && w.body.status !== undefined).length, 1, "assignee rides the one status PATCH");
    world.me = "claudecode";
    okr(await tr("claude", T.val, handoff({ blueprint_comment_id: bpId() })));
    assert.equal(world.task.entity.assigned_to, 71, "GPT Validation is GPT-owned");
  });
});

test("an owner that is not an active project member fails closed: no comment, no status, no assignee", async () => {
  await withAccounts(async () => {
    world.users = world.users.filter((u) => u.username !== "claudecode");
    world.me = "chatgpt";
    const r = await tr("gpt", T.prog, blueprint());
    assert.equal(payload(r).code, "WORKFLOW_ASSIGNEE_UNRESOLVED");
    assert.equal(writes().length, 0, "nothing written");
    assert.equal(world.task.entity.status, T.todo);
    assert.equal(world.task.entity.assigned_to, undefined);
  });
});

test("without any expected account configured the projection is off (legacy behaviour)", async () => {
  await release();
  assert.equal(world.task.entity.assigned_to, undefined);
});

// Task 381 round 2: every ownership transition named by the acceptance is proven end to end, and the Story promotion verifies what it wrote.
test("Assigned: Task -> Human Decision assigns the PO", async () => {
  await withAccounts(async () => {
    world.me = "chatgpt";
    await release();
    world.me = "claudecode";
    okr(await tr("claude", T.human, hdr()));
    assert.equal(world.task.entity.assigned_to, 73, "Human Decision is PO-owned");
  });
});

test("Assigned: Request entry assigns GPT (the addressee), answering alone changes nothing, resume restores ClaudeCode", async () => {
  await withAccounts(async () => {
    world.me = "chatgpt";
    await release();
    world.me = "claudecode";
    okr(await tr("claude", T.req, reqArt()));
    assert.equal(world.task.entity.assigned_to, 71, "Request is addressed to GPT");
    world.me = "chatgpt";
    okr(await ans("gpt", "R-905-1"));
    assert.equal(world.task.entity.assigned_to, 71, "answering alone does not move the card or the assignee");
    world.me = "claudecode";
    okr(await tr("claude", T.prog, resume({ response_comment_id: responseId() })));
    assert.equal(world.task.entity.assigned_to, 72, "the resumed In Progress is Claude-owned again");
  });
});

test("mechanical Story promotion assigns GPT and verifies the persisted status and assignee", async () => {
  await withAccounts(async () => {
    await withStoryTask();
    world.me = "chatgpt";
    const r = await approveTask();
    assert.deepEqual([r.story_promotion.promoted, r.story_promotion.integrity_failure], [true, undefined]);
    assert.equal(world.userstory.entity.status, S.val);
    assert.equal(world.userstory.entity.assigned_to, 71, "the promoted Story shows GPT");
  });
});

test("a Story promotion whose assignee did not persist is reported as an integrity failure; the promotion itself stands", async () => {
  await withAccounts(async () => {
    await withStoryTask();
    delete world.userstory.entity.assigned_to; // Story start already projected GPT; the promotion write must be what is verified
    world.dropAssignee = true;
    world.me = "chatgpt";
    const r = await approveTask();
    assert.equal(r.story_promotion.promoted, true, "status stays authoritative");
    assert.match(r.story_promotion.integrity_failure, /not the projected owner/);
    assert.equal(world.userstory.entity.status, S.val, "nothing is rolled back");
  });
});

// Task 377: the governed write boundary's structural guard. A Story cannot enter In Progress without a child Task, and the refusal writes nothing.
test("a governed Story with zero child Tasks is refused before any comment or status write; with a child Task it starts", async () => {
  world.storyTasks = [];
  const r = await sttr("gpt", S.prog, storyStart());
  assert.equal(r.isError, true);
  const p = payload(r);
  assert.equal(p.code, "WORKFLOW_PRECONDITION_FAILED");
  assert.match(p.message, /without at least one child Task/);
  assert.equal(writes().length, 0, "no comment and no status write");
  assert.equal(world.userstory.entity.status, S.ready);
  world.storyTasks = [{ id: 1001, ref: 901, status: T.todo }];
  okr(await sttr("gpt", S.prog, storyStart()));
  assert.equal(world.userstory.entity.status, S.prog);
});

// Task 378: Request history is evidence, never state. Recovery follows the visible status only.
test("recovery: an old open Request comment on a Task that is visibly In Progress creates no Request obligation; the same comment on a Task in Request does", async () => {
  delete process.env.TAIGA_MCP_NOTIFY_COMMAND;
  const { rmSync: rm } = await import("node:fs");
  await toRequest(); // R-905-1 stays open (never answered)
  world.task.entity.status = T.prog; // a manual PO move out of Request, no resolving answer
  rm(process.env.TAIGA_MCP_CONTINUATION_FILE, { force: true }); // a lost ledger: recovery must rebuild from Taiga only
  await call("claude", "taiga_continuations_pending", { project: 49 });
  assert.equal(pendingContinuations("gpt").some((c) => c.type === "WORKFLOW_REQUEST_OPENED"), false, "the board says In Progress: no obligation");
  assert.equal(pendingContinuations("claude").some((c) => c.type === "WORKFLOW_REQUEST_OPENED"), false);
  world.task.entity.status = T.req; // the card visibly in Request again
  await call("claude", "taiga_continuations_pending", { project: 49 });
  assert.equal(pendingContinuations("gpt").some((c) => c.type === "WORKFLOW_REQUEST_OPENED"), true, "in Request, GPT owes an answer");
});

// Task 379: an agent cannot start out of order or a second active Task; the refusal is structured and writes nothing; the PO is not blocked.
test("a second active Task (In Progress, Request, GPT Validation or Human Decision) in the Sprint refuses a fresh start with the active Task and zero writes; once it is Done the same call succeeds", async () => {
  world.task.entity.milestone = 300;
  world.sprintTasks = [{ id: 99, ref: 800, status: T.prog, milestone: 300 }];
  const r = await tr("gpt", T.prog, blueprint());
  const p = payload(r);
  assert.equal(p.code, "WORKFLOW_START_REFUSED");
  assert.deepEqual([p.blocker.kind, p.blocker.ref, p.blocker.status], ["active_task", 800, "In Progress"]);
  assert.match(p.next_step, /wait until Task #800 is Done or Cancelled/);
  assert.equal(writes().length, 0, "refusal writes nothing");
  assert.equal(world.task.entity.status, T.todo);
  world.sprintTasks[0].status = T.val; // the other Task is in validation: it still counts as active
  assert.equal(payload(await tr("gpt", T.prog, blueprint())).code, "WORKFLOW_START_REFUSED");
  assert.equal(writes().length, 0);
  world.sprintTasks[0].status = T.done; // Taiga changed: the other Task is finished
  okr(await tr("gpt", T.prog, blueprint()));
  assert.equal(world.task.entity.status, T.prog, "fresh read honors the new board");
});

test("a Story below an unfinished Story is refused with that Story; after the Story above is Done (an explicit change in Taiga) it starts", async () => {
  world.userstory.entity.milestone = 300; world.userstory.entity.sprint_order = 2;
  world.sprintRows = [{ id: 50, ref: 5, version: 1, status: S.ready, milestone: 300, sprint_order: 1, is_blocked: false }];
  const p = payload(await sttr("gpt", S.prog, storyStart()));
  assert.equal(p.code, "WORKFLOW_START_REFUSED");
  assert.deepEqual([p.blocker.kind, p.blocker.ref, p.blocker.status], ["story_order", 5, "Ready"]);
  assert.equal(writes().length, 0);
  assert.equal(world.userstory.entity.status, S.ready, "nothing was reordered or started");
  world.sprintRows[0].status = S.done;
  okr(await sttr("gpt", S.prog, storyStart()));
  assert.equal(world.userstory.entity.status, S.prog);
});

test("the PO is not subject to the agent start rules (manual PO moves are a separate authority)", async () => {
  world.task.entity.milestone = 300;
  world.sprintTasks = [{ id: 99, ref: 800, status: T.prog, milestone: 300 }];
  okr(await tr("po", T.prog, blueprint()));
  assert.equal(world.task.entity.status, T.prog);
});
