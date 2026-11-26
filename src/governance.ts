import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TaigaClient } from "./client.js";
import { postComment, signComment } from "./comment.js";
import type { WorkflowIdentity } from "./workflow/actor.js";
import { authorShape } from "./workflow/tools.js";
import { closureIntegrityFailure, resolveStatusRef, strictTransition } from "./workflow/transition.js";
import type { PolicyRuntime } from "./policy/runtime.js";
import { assertCataloged, guard, underGuard } from "./policy/pep.js";
import { moveClosedStoryToTail } from "./workflow/story-order.js";
import { closureFor, vocabulary, type EntityKind } from "./workflow/policy.js";
import { BASE, STATUS_BASE, text, violation } from "./workflow/result.js";
import { ensureEngineeringReview, keepCanonicalOrder } from "./workflow/engineering-review.js";
import { SECTIONS } from "./description-sections.js";
import type { ToolHandler, ToolRegister } from "./fields.js";

// Workflow governance is ONE global runtime switch for the whole MCP, ON by default. State lives in governance.json at
// the root of this MCP package (it travels with the MCP). The PO edits it by hand ({ "enabled": true|false }) or with the
// admin CLI (taiga-mcp-governance); the MCP only reads it, on every call, so an edit applies without a restart.
// Missing file or missing field = ON; an unreadable or malformed file at startup is an error, and later on it reads as ON.
// When ON, every Taiga project reached through this MCP follows governance; when OFF the MCP is globally free.

// Syntactic governance evidence only: the shared Taiga credentials cannot prove who wrote a comment.
const APPROVAL_FIRST_RE = /^(GPT )?Validation — APPROVED$/;
// Last line of an approval: `-- <author>`, whoever approved (GPT, Kimi, Claude, the PO); the legacy GPT signatures match too.
const APPROVAL_LAST_RE = /^-- \S.{0,59}$/;

export interface GovernanceState { enabled: boolean }

export function governanceFile(): string {
  return process.env.TAIGA_MCP_GOVERNANCE_FILE || join(dirname(fileURLToPath(import.meta.url)), "..", "governance.json");
}

// Live view of the switch: re-reads the file on every access, and any read problem after startup counts as ON.
export function loadGovernance(file = governanceFile()): GovernanceState {
  readGovernance(file);
  return {
    get enabled() {
      try { return readGovernance(file).enabled; } catch { return true; }
    },
  };
}

// The generic create/update/bulk tools are guarded here; Args names only the fields the guards read.
type Args = {
  id?: number; project?: number; project_id?: number; milestone?: number; kind?: string; container_id?: number;
  status?: unknown; status_id?: number; description?: unknown; is_blocked?: boolean; blocked_note?: unknown; is_closed?: boolean;
  taskboard_order?: unknown; bulk_tasks?: number[][];
};
type Stored = { project?: number; status?: number; is_blocked?: boolean; blocked_note?: unknown };
type GovHandler = ToolHandler<Args>;

// A missing file means ON; an unreadable or malformed one fails closed (startup error).
function readGovernance(file: string): GovernanceState {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { enabled: true };
    throw new Error(`governance file unreadable: ${file}`, { cause: e });
  }
  let parsed: { enabled?: unknown } | null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`governance file is not valid JSON: ${file}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`governance file must be a JSON object: ${file}`);
  }
  if (parsed.enabled !== undefined && typeof parsed.enabled !== "boolean") {
    throw new Error(`governance file "enabled" must be true or false: ${file}`);
  }
  return { enabled: parsed.enabled !== false };
}

export function descriptionSections(text: string): string[] {
  const found: string[] = [];
  let fenced = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; continue; }
    if (fenced) continue;
    const m = /^\*\*(.+)\*\*\s*$/.exec(line);
    if (m) found.push(m[1]);
  }
  return found;
}

// Tells the caller how to fix a refused status change, so no separate evidence comment is posted first.
const STATUS_HINT = "status changes in a governed project must go through taiga_workflow_transition: pass the evidence text as its `comment` parameter, which becomes the card's only comment (do not post a separate comment first)";
const UPDATE_NOTE = " In a governed project the status field cannot be used here: change status with taiga_workflow_transition and put the evidence in its `comment`.";

// Bulk tools can also set or move a status (creation in a chosen status, taskboard column drop): same rule as the generic update.
const BULK_CREATE = /^taiga_(epics|userstories|tasks)_bulk_create$/;
const STATUS_BULK_NOTE = " In a governed project `status_id` is refused: new items start in their default status and move only through taiga_workflow_transition.";

function guardBulkStatus(client: TaigaClient, state: GovernanceState, name: string, handler: GovHandler): GovHandler {
  return async (args, extra) => {
    if (!state.enabled || args.status_id === undefined) return handler(args, extra);
    if (BULK_CREATE.test(name)) return violation([STATUS_HINT]);
    const moved: number[] = [];
    for (const row of Array.isArray(args.bulk_tasks) ? args.bulk_tasks : []) {
      const task = (await client.get(`/tasks/${row[0]}`)) as { status?: number };
      if (task.status !== args.status_id) moved.push(row[0]);
    }
    return moved.length ? violation([`${STATUS_HINT}; Tasks ${moved.join(", ")} would be moved to status ${args.status_id}`]) : handler(args, extra);
  };
}

// Governed Task precedence has ONE operation: taiga_move kind="task" (taskboard_order is the only Task position; it verifies the visible order).
// The low-level order fields and tools stay available for non-governed projects; the canonical move calls the Taiga API itself, never these tools.
const ORDER_HINT = 'Task precedence in a governed workflow project has one operation: taiga_move with kind "task" (before_id/after_id or direction); raw taskboard_order writes and the bulk order tool are not allowed';
const ORDER_NOTE = " In a governed project this low-level order path is refused: use taiga_move with kind \"task\".";

async function strictTaskProject(client: TaigaClient, project: number | undefined): Promise<boolean> {
  return project !== undefined && vocabulary("task", await client.get("/task-statuses", { project })).strict;
}

function guardTaskOrder(client: TaigaClient, state: GovernanceState, handler: GovHandler): GovHandler {
  return async (args, extra) =>
    state.enabled && (await strictTaskProject(client, args.project_id)) ? violation([ORDER_HINT]) : handler(args, extra);
}

// Sprint Engineering Review (Issue #250): in a governed project a new Sprint gets its FINAL review Story, and every Story change in a Sprint keeps it last.
// The review step runs AFTER the tool persisted its change; if it fails the call is reported as a failure, never as a clean success.
const sprintOf = (name: string, args: Args, res: { id?: number; milestone?: number } & { milestone?: number }[]): number | undefined =>
  name === "taiga_milestones_create" ? res?.id
  : name === "taiga_userstories_create" ? args.milestone ?? res?.milestone
  : name === "taiga_userstories_update" ? res?.milestone
  : name === "taiga_userstories_bulk_update_sprint_order" ? res?.[0]?.milestone
  : name === "taiga_move" && args.kind === "story_in_sprint" ? args.container_id
  : undefined;

function withSprintReview(client: TaigaClient, state: GovernanceState, name: string, handler: GovHandler): GovHandler {
  if (!/^taiga_(milestones_create|userstories_(create|update|bulk_update_sprint_order)|move)$/.test(name)) return handler;
  return async (args, extra) => {
    const result = await handler(args, extra);
    if (!state.enabled || result?.isError) return result;
    let parsed: Parameters<typeof sprintOf>[2];
    try { parsed = JSON.parse(result.content?.[0]?.text as string); } catch { return result; }
    const sprint = sprintOf(name, args, parsed);
    if (sprint === undefined) return result;
    try {
      const { project } = (await client.get(`/milestones/${sprint}`)) as { project?: number };
      if (project === undefined || !vocabulary("userstory", await client.get("/userstory-statuses", { project })).strict) return result;
      if (name === "taiga_milestones_create") return text({ ...parsed, engineering_review: await ensureEngineeringReview(client, sprint) });
      const order = await keepCanonicalOrder(client, sprint);
      return order.moved ? text({ ...parsed, engineering_review: { reordered: true } }) : result;
    } catch (e) {
      return text({ code: "ENGINEERING_REVIEW_FAILED", message: `${(e as Error).message}. The requested change IS persisted, but the Sprint's FINAL review Story could not be ensured/kept in canonical order: this is NOT a clean success.`, persisted: parsed }, true);
    }
  };
}

// Issue -> Sprint hygiene at the promotion boundary: the source Issue is known here, so a missing Sprint association is surfaced with the result.
function withPromoteHygiene(client: TaigaClient, state: GovernanceState, name: string, handler: GovHandler): GovHandler {
  if (name !== "taiga_issues_promote_to_userstory") return handler;
  return async (args, extra) => {
    const result = await handler(args, extra);
    if (!state.enabled || result?.isError) return result;
    const issue = (await client.get(`/issues/${args.id}`)) as { milestone?: number | null };
    if (issue.milestone != null) return result;
    return text({ ...JSON.parse(result.content?.[0]?.text as string), sprint_hygiene: { issue: args.id, finding: "issue_without_sprint", reminder: "The source Issue has no Sprint: associate it with the Sprint that will hold the generated Story." } });
  };
}

const TASK_COMMENT = /^taiga_task_comment_(create|delete)$/;
const COMMENT_NOTE = " In a Task of a project with the strict workflow vocabulary, free comments are disabled while governance is ON: ownership evidence is written by taiga_workflow_transition artifacts and taiga_workflow_request_* tools. Only the authenticated PO may add a maintenance comment or delete one.";

// Free Task comments are an alternate path around the typed hand-off, so they are closed under governance.
// Allowed: governance OFF, a project without the workflow vocabulary, or an authenticated PO/admin (maintenance).
function guardTaskComment(client: TaigaClient, state: GovernanceState, identity: WorkflowIdentity, op: "create" | "delete", handler: GovHandler): GovHandler {
  return async (args, extra) => {
    if (!state.enabled) return handler(args, extra);
    const task = (await client.get(`/tasks/${args.id}`)) as { project?: number };
    const vocab = vocabulary("task", task.project === undefined ? undefined : await client.get("/task-statuses", { project: task.project }));
    if (!vocab.strict) return handler(args, extra);
    if (identity.actor?.role === "po") return handler(args, extra);
    return violation([`free Task comments (${op}) are disabled in a governed workflow project: use taiga_workflow_transition for hand-offs and taiga_workflow_request_create/answer for questions${op === "delete" ? "; handoff and validation evidence is append-only (supersede it with a new artifact)" : ""}`]);
  };
}

// After a Task enters execution its contract (description) is not rewritten by agents; the PO/admin may amend it.
async function descriptionLock(client: TaigaClient, stored: Stored | undefined, identity: WorkflowIdentity): Promise<string[]> {
  if (!stored || identity.actor?.role === "po") return [];
  const vocab = vocabulary("task", stored.project === undefined ? undefined : await client.get("/task-statuses", { project: stored.project }));
  if (!vocab.strict) return [];
  const status = vocab.nameById.get(stored.status as number);
  const locked = status === "in progress" || status === "gpt validation" || status === "request";
  if (identity.actor?.role === "claude" || (locked && identity.mode === "syntactic") || (locked && identity.actor?.role === "gpt")) {
    return [`the Task description is the execution contract and cannot be changed by ${identity.actor?.role ?? "an unauthenticated caller"} while the Task is "${status}": return it to a non-execution status first, or ask the PO to amend it`];
  }
  return [];
}

const FAMILY = /^taiga_(epics|userstories|tasks)_(create|update)$/;
const PATH: Record<string, string> = { epics: "epics", userstories: "userstories", tasks: "tasks" };
const CLOSURE_ENTITY: Record<string, EntityKind | undefined> = { userstories: "userstory", tasks: "task" };
const CLOSURE_PROBLEM = "is_closed cannot be set directly in a governed workflow project: status is authoritative and closure is derived from it; change status with taiga_workflow_transition";

// Direct closure mutation would let an item be closed while its status is still open (the hybrid state). It is refused for Stories and Tasks
// of a project that exposes the strict vocabulary; non-strict projects and Epics keep their legacy behaviour.
async function closureBypass(client: TaigaClient, family: string, verb: string, args: Args, stored: Stored | undefined): Promise<string[]> {
  const entity = CLOSURE_ENTITY[family];
  if (!entity || args.is_closed === undefined) return [];
  const project = verb === "update" ? stored?.project : args.project;
  if (project === undefined) return [];
  const vocab = vocabulary(entity, await client.get(`/${STATUS_BASE[entity]}`, { project }));
  return vocab.strict ? [CLOSURE_PROBLEM] : [];
}

// Wraps the generic Epic/Story/Task create/update tools: a governed project is validated before the handler runs.
export function addGovernance(server: McpServer, client: TaigaClient, state: GovernanceState, identity: WorkflowIdentity = { mode: "syntactic", actor: null }, runtime?: PolicyRuntime): void {
  const bound = server.tool.bind(server) as unknown as ToolRegister<Args>;
  // The PEP is the outermost layer: it decides before any guard or handler, so a refusal changes nothing.
  const register: ToolRegister<Args> = (name, description, schema, handler) => {
    if (!runtime) return bound(name, description, schema, handler);
    assertCataloged(name);
    return bound(name, description, schema, async (args, extra) => {
      const g = await guard(name, args as Record<string, unknown>, client, runtime, identity.actor?.role ?? null);
      return "refusal" in g ? violation([g.refusal]) : underGuard(g, () => handler(args, extra));
    });
  };
  (server as unknown as { tool: ToolRegister<Args> }).tool = (name, description, schema, rawHandler) => {
    const handler = withPromoteHygiene(client, state, name, withSprintReview(client, state, name, rawHandler));
    if (name === "taiga_tasks_bulk_update_taskboard_order") {
      return register(name, description + ORDER_NOTE, schema, guardTaskOrder(client, state, guardBulkStatus(client, state, name, handler)));
    }
    if (BULK_CREATE.test(name)) {
      return register(name, description + STATUS_BULK_NOTE, schema, guardBulkStatus(client, state, name, handler));
    }
    const cm = TASK_COMMENT.exec(name);
    if (cm) return register(name, description + COMMENT_NOTE, schema, guardTaskComment(client, state, identity, cm[1] as "create" | "delete", handler));
    const m = FAMILY.exec(name);
    if (!m) return register(name, description, schema, handler);
    const [, family, verb] = m;
    const wrapped: GovHandler = async (args, extra) => {
      if (!state.enabled) return handler(args, extra);
      const stored: Stored | undefined = verb === "update" ? (await client.get(`/${PATH[family]}/${args.id}`)) as Stored : undefined;
      const problems: string[] = [];
      if (typeof args.description === "string") {
        const found = descriptionSections(args.description);
        if (found.join("\n") !== SECTIONS.join("\n")) {
          problems.push(`description must be exactly these top-level sections, in order: ${SECTIONS.map((s) => `**${s}**`).join(", ")}`);
        }
      }
      const blocked = args.is_blocked ?? (verb === "update" ? stored?.is_blocked : false);
      if (blocked === true) {
        const note = args.blocked_note ?? (verb === "update" ? stored?.blocked_note : "");
        if (typeof note !== "string" || note.trim() === "") problems.push("is_blocked=true needs a non-empty blocked_note");
      }
      if (args.status !== undefined) problems.push(STATUS_HINT);
      problems.push(...(await closureBypass(client, family, verb, args, stored)));
      if (family === "tasks" && verb === "update" && args.taskboard_order !== undefined && (await strictTaskProject(client, stored?.project))) problems.push(ORDER_HINT);
      if (family === "tasks" && verb === "update" && typeof args.description === "string") problems.push(...(await descriptionLock(client, stored, identity)));
      return problems.length ? violation(problems) : handler(args, extra);
    };
    return register(name, verb === "update" ? description + UPDATE_NOTE : description, schema, wrapped);
  };
}

// A governed move inside a Sprint needs a comment that explains the work: form checks only, the MCP cannot judge meaning.
export const MIN_TRANSITION_COMMENT = 60;
const GENERIC = /^(moved?|movido|done|ok|okay|updated?|atualizado|feito|pronto|concluido|concluído|in progress|em andamento|started|iniciado|closed|fechado|fixed|test(ed)?|testado)[\s.!-]*$/i;

export function transitionCommentProblems(comment: string): string[] {
  const t = comment.trim();
  const problems: string[] = [];
  if (t.length < MIN_TRANSITION_COMMENT) problems.push(`a transition comment inside a Sprint must explain what was done: at least ${MIN_TRANSITION_COMMENT} characters`);
  else if (GENERIC.test(t)) problems.push("a transition comment must not be a generic word like 'moved' or 'done'");
  return problems;
}

export const REMINDER_FORWARD = "Reminder: does this transition's comment record what was done and how? If something is missing, add a follow-up comment.";
export const REMINDER_BACK = "Reminder: this moved backwards. Does the comment say exactly why it came back, with the findings and what is needed to pass? If not, add a follow-up comment.";


interface HistoryItem { comment?: string; created_at?: string }

const lastLine = (s: string) => s.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).at(-1);
const isApproval = (comment: string) =>
  APPROVAL_FIRST_RE.test(comment.split(/\r?\n/)[0].trim()) && APPROVAL_LAST_RE.test(lastLine(comment) ?? "");

function latestComment(history: HistoryItem[]): string | undefined {
  const withComment = history.filter((h) => typeof h.comment === "string" && h.comment.trim() !== "");
  if (withComment.length === 0) return undefined;
  const dated = withComment.filter((h) => h.created_at);
  const pick = dated.length === withComment.length
    ? dated.reduce((a, b) => (Date.parse(b.created_at!) >= Date.parse(a.created_at!) ? b : a))
    : withComment[withComment.length - 1];
  return pick.comment;
}

export function registerGovernanceTools(server: McpServer, client: TaigaClient, state: GovernanceState, identity: WorkflowIdentity = { mode: "syntactic", actor: null }, runtime?: PolicyRuntime): void {
  server.tool(
    "taiga_governance_status",
    "Read-only: whether workflow governance is ON for this whole MCP (ON by default). It is changed only by the local admin CLI, never through the MCP.",
    {},
    async () => text({ enabled: state.enabled }),
  );

  server.tool(
    "taiga_workflow_transition",
    "Change a Task, User Story or Epic status. Generic path: `comment` is required and is the place for the evidence: it is the card's one comment for this move, so do NOT post a separate comment first. It is posted verbatim (record what was done and how; when moving backwards, say exactly why it came back) and proven persisted in history before the status changes. STRICT WORKFLOW PROJECTS (status vocabulary To Do / In Progress / GPT Validation / Human Decision / Done / Cancelled for Tasks): every Task transition is an ownership transfer checked against an actor/state matrix and takes a typed `artifact` INSTEAD of `comment`: To Do->In Progress and GPT Validation->In Progress (GPT/PO) need an implementation_blueprint (mode initial / correction); In Progress->GPT Validation (Claude) needs an execution_handoff; GPT Validation->Done (GPT/PO) needs a validation_approval; ->Human Decision needs a human_decision_request; In Progress->To Do needs a blocker_report; ->Cancelled and every PO override need a po_decision. User Stories (strict vocabulary Ready / In Progress / GPT Validation / Done) are GPT/PO-owned and typed: Ready->In Progress story_start; In Progress->GPT Validation story_validation_handoff (every child Task must be Done or Cancelled, checked at call time; normally the MCP promotes the Story itself when the last child Task becomes terminal); GPT Validation->In Progress story_correction; GPT Validation->Done story_validation_approval (cites the latest Story handoff). Status is authoritative and is_closed is derived and written with it. Epic parity covers ->GPT Validation (execution_handoff) and ->Done (validation_approval). The MCP validates the fields, renders the one canonical comment, proves it persisted, then moves the status; a rejection mutates nothing. Call taiga_task_workflow_state to see what the caller may do. "+(identity.actor ? "The actor is authenticated by the transport; there is no `author` field." : "`author` is required and is only a signature (identity is syntactic, not authenticated).")+"",
    {
      entity: z.enum(["task", "userstory", "epic"]),
      id: z.number().describe("Task, User Story or Epic ID"),
      status: z.union([z.string(), z.number()]).describe("Target status NAME inside the item's project, e.g. \"In Progress\", \"GPT Validation\", \"Request\", \"Done\" (resolved to the project's real id at runtime; an unknown or ambiguous name is refused). A numeric id is still accepted but never needed."),
      ...authorShape(identity),
      comment: z.string().optional().describe("Generic path only: new comment (the `-- <author>` signature is appended). Required when governance is ON and the item is in a Sprint (>=60 chars, not generic); optional when OFF. Not accepted for typed ownership transitions"),
      artifact: z.record(z.string(), z.unknown()).optional().describe("Typed workflow artifact {type, version: \"1.0.0\", ...fields} for a strict-workflow ownership transition"),
      merge_context: z.record(z.string(), z.unknown()).optional().describe("Only with the approval that moves a Task or Story to Done: {repository, source_branch, target_branch, source_sha, target_sha}. After the Done is persisted and re-read the MCP returns an Ed25519 `merge_authorization` envelope for exactly these coordinates (needs TAIGA_MCP_MERGE_AUTH_PRIVATE_KEY_B64; invalid context or key is refused before any mutation)"),
      model: z.string().optional().describe("Optional telemetry: the model producing this artifact, only when you know it with confidence. Never invent it; absent or invalid is recorded as Unknown. It never affects authorization"),
      effort: z.string().optional().describe("Optional telemetry: the reasoning effort in use, only when known: Low, Medium, High or Unknown. Absent or invalid is recorded as Unknown. It never affects authorization"),
    },
    async ({ entity, id, status: statusRef, comment: rawComment, author: givenAuthor, artifact, merge_context, model, effort }: { entity: "task" | "userstory" | "epic"; id: number; status: number | string; comment?: string; author?: string; artifact?: Record<string, unknown>; merge_context?: Record<string, unknown>; model?: string; effort?: string }) => {
      const author = (identity.actor?.display ?? givenAuthor) as string;
      const hasComment = rawComment !== undefined && rawComment.trim() !== "";
      const comment = hasComment ? signComment(rawComment!, author) : undefined;
      const base = BASE[entity];
      const governed = state.enabled;
      const named = await resolveStatusRef(client, entity, ((await client.get(`/${base}/${id}`)) as { project?: number }).project, statusRef);
      if ("error" in named) return violation([named.error]);
      const status = named.id;
      // OFF = unrestricted: a status change goes through with or without a comment.
      if (!governed && !hasComment) {
        const cur = (await client.get(`/${base}/${id}`)) as { version: number };
        return text({ transitioned: true, entity, id, status, comment_persisted: false, updated: await client.patch(`/${base}/${id}`, { status, version: cur.version }) });
      }
      const item = (await client.get(`/${base}/${id}`)) as { milestone?: number | null; status?: number; version?: number; project?: number };
      if (governed) {
        const typed = await strictTransition(client, identity, { entity, id, status, author, comment: rawComment, artifact, mergeContext: merge_context, model, effort }, item, undefined, runtime);
        if (typed) return typed;
      } else if (artifact !== undefined) {
        // Governance OFF is globally free: the legacy comment path applies.
      }
      const inSprint = item.milestone != null;
      if (governed && inSprint) {
        const problems = hasComment ? transitionCommentProblems(rawComment!) : ["a transition inside a Sprint needs a comment explaining what was done"];
        if (problems.length) return violation(problems);
      }
      if (!hasComment) return violation(["a transition needs a non-empty comment"]);
      const history = (await client.get(`/history/${entity}/${id}`)) as HistoryItem[];
      if (latestComment(history) === comment) return violation(["the comment must be NEW, not the latest existing comment"]);
      if (governed && entity === "task") {
        const target = (await client.get(`/task-statuses/${status}`)) as { is_closed?: boolean };
        if (target.is_closed && !history.some((h) => typeof h.comment === "string" && isApproval(h.comment))) {
          return violation(["closing a Task needs a prior comment whose first line is `Validation — APPROVED` and whose last line is a signature `-- <author>` (syntactic evidence only)"]);
        }
      }
      await postComment(client, entity, id, rawComment!, author);
      const after = (await client.get(`/history/${entity}/${id}`)) as HistoryItem[];
      if (!after.some((h) => h.comment === comment)) {
        return text({ code: "comment_not_persisted", message: "The comment is not in the history; the status was NOT changed." }, true);
      }
      const current = (await client.get(`/${base}/${id}`)) as { version: number };
      // Status is the only Story lifecycle authority in a strict project; userstory.is_closed/finish_date are upstream metadata derived from the
      // child Tasks (writes to them are ignored), so they are neither written nor proven (Issue #243).
      let storyName = "";
      if (governed && entity === "userstory" && item.project !== undefined) {
        const vocab = vocabulary("userstory", await client.get(`/${STATUS_BASE.userstory}`, { project: item.project }));
        storyName = vocab.strict ? vocab.nameById.get(status) ?? "" : "";
      }
      const updated = await client.patch(`/${base}/${id}`, { status, version: current.version });
      if (storyName) {
        const failure = await closureIntegrityFailure(client, "userstory", id, status, storyName);
        if (failure) return text({ code: "WORKFLOW_INTEGRITY_FAILURE", message: `${failure}. The comment is persisted and the status write was attempted: this is NOT a successful transition.` }, true);
      }
      // Backwards = lower status order in Taiga, never decided by name.
      const sbase = STATUS_BASE[entity];
      const [from, to] = (await Promise.all([item.status, status].map((sid) => client.get(`/${sbase}/${sid}`)))) as { order?: number }[];
      const back = typeof from?.order === "number" && typeof to?.order === "number" && to.order < from.order;
      // A governed Story reports the SCOPE workflow meaning of its status, never the physical userstory.is_closed.
      const closed = storyName ? closureFor("userstory", storyName) === true : (to as { is_closed?: boolean })?.is_closed === true;
      // A cancelled governed Story is closed history like a Done one: it sinks to the tail. The cancellation is already persisted, so a failure is reported, never retried.
      const queueReorder = storyName === "cancelled" ? await moveClosedStoryToTail(client, id).catch((e: Error) => ({ ok: false, code: "STORY_QUEUE_REORDER_FAILED", message: e.message, note: "The Story Cancelled transition IS persisted; do not retry it. Fix the Sprint order with taiga_move." })) : undefined;
      return text({ transitioned: true, entity, id, status, closed, comment_persisted: true, evidence: "syntactic", reminder: back ? REMINDER_BACK : REMINDER_FORWARD, ...(queueReorder ? { queue_reorder: queueReorder } : {}), updated });
    },
  );
}
