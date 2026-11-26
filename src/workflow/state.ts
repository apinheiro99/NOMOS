import { applicableFields } from "./artifacts.js";
import { ROLE_OF_AUTHOR } from "./actor.js";
import { TEMPLATE_TYPES, exact, plainLabel, type Template, type TemplateSet } from "./templates.js";

// Read model over the append-only Task history. It owns no state: everything is derived from the comments the MCP rendered.
// An existing artifact is read against the template version it DECLARES (`Schema: <name>/<version>`), never the newest.

export interface HistoryItem { id?: string; comment?: string; created_at?: string; delete_comment_date?: string | null }
export interface Rec { id: string; comment: string; created_at?: string }

export class UnsupportedArtifactError extends Error {
  constructor(public commentId: string, public schema: string) { super(`comment ${commentId} declares ${schema}, which has no template file`); this.name = "UnsupportedArtifactError"; }
}

export function orderedComments(history: HistoryItem[]): Rec[] {
  const withComment = history.filter((h) => typeof h.comment === "string" && h.comment.trim() !== "" && !h.delete_comment_date && h.id !== undefined);
  const dated = withComment.every((h) => h.created_at);
  const list = dated ? [...withComment].sort((a, b) => Date.parse(a.created_at!) - Date.parse(b.created_at!)) : withComment;
  return list.map((h) => ({ id: String(h.id), comment: h.comment!, created_at: h.created_at }));
}

export interface Parsed {
  id: string; created_at?: string;
  kind: string; mode?: string; schema: string; model: string | null; author?: string; effort?: string | null;
  round?: number; validationRound?: number; supersedes?: string;
  blueprintId?: string; handoffId?: string;
  requestId?: string; taskRef?: number; from?: string; to?: string; requestType?: string; blocking?: boolean; resolved?: boolean;
  question?: string; contextEvidence?: string[];
  /** An artifact that moved the card: normalized status it came from (undefined for `Status unchanged` and for a legacy envelope). Human Decision Resolution: the request it resolves and its destination. */
  movedFrom?: string; decisionRequestId?: string; nextStatus?: string; nextOwner?: string;
  /** Continuation Handled evidence: the exact continuation id that was handled. */
  continuationId?: string;
  /** Execution Handoff: the work branch the hand-off declares (undefined when none). */
  branch?: string;
}

// Section starts are recognised from the labels the template DECLARES for its body fields (exact line), plus the legacy form
// `## <plain label>` that older comments used. The field key is the identity; the label is only presentation.
function labelIndex(tpl: Template): Map<string, string> {
  const idx = new Map<string, string>();
  for (const f of tpl.fields) {
    if (f.header) continue;
    idx.set(f.label.trim(), f.key);
    idx.set(`## ${plainLabel(f.label)}`, f.key);
  }
  return idx;
}
const sectionsOf = (lines: string[], idx: Map<string, string>) => {
  const out = new Map<string, string[]>();
  let cur: string[] | null = null;
  for (const line of lines) {
    const key = idx.get(line.trim());
    if (key !== undefined) { cur = []; out.set(key, cur); } else if (cur) cur.push(line);
  }
  return out;
};

const knownOrNull = (v: string | undefined) => (v === undefined || v === "Unknown" ? null : v);

// Only a first line + `Schema:` line that match a template of the declared version count; anything else is plain history.
export function parseArtifact(rec: Rec, set: TemplateSet): Parsed | null {
  const lines = rec.comment.split(/\r?\n/);
  const second = lines[1]?.trim() ?? "";
  const first = lines[0]?.trim();
  let tpl: Template | undefined;
  const legacy = /^Schema: ([a-z][a-z0-9-]*)\/(\d+\.\d+\.\d+)$/.exec(second);
  if (legacy) {
    // pre-2026-11-01 envelope: title line, `Schema: name/version`
    if (!TEMPLATE_TYPES[legacy[1]]) return null;
    tpl = exact(set, legacy[1], legacy[2]);
    if (!tpl) throw new UnsupportedArtifactError(rec.id, `${legacy[1]}/${legacy[2]}`);
    if (first !== tpl.title && !(tpl.type === "workflow_request" && first.startsWith(`${tpl.title} — `))) return null;
  } else {
    // current envelope: `<From> → <To>` or `Status unchanged`, then `Schema: <Display name> <version>`
    const cur = /^Schema: (.+) (\d+\.\d+\.\d+)$/.exec(second);
    if (!cur || !/^(Status unchanged|.+ → .+)$/.test(first ?? "")) return null;
    const named = set.filter((t) => t.display === cur[1]);
    if (named.length === 0) return null;
    tpl = named.find((t) => t.version === cur[2]);
    if (!tpl) throw new UnsupportedArtifactError(rec.id, `${cur[1]} ${cur[2]}`);
  }
  const head = new Map<string, string>();
  const rest = lines.slice(2);
  const labels = labelIndex(tpl);
  for (const line of rest) {
    if (line.trim() === "" || labels.has(line.trim())) break;
    const kv = /^([A-Za-z ]+): (.+)$/.exec(line);
    if (kv) head.set(kv[1], kv[2].trim());
  }
  const p: Parsed = { id: rec.id, created_at: rec.created_at, kind: tpl.type, mode: tpl.mode, schema: `${tpl.name}/${tpl.version}`, model: knownOrNull(head.get("Model")), author: head.get("Author"), effort: knownOrNull(head.get("Effort")) };
  const fieldLabel = (key: string) => applicableFields(tpl, "task").find((f) => f.key === key)?.label;
  const get = (key: string) => { const l = fieldLabel(key); return l ? head.get(l) : undefined; };
  if (p.kind === "implementation_blueprint") {
    p.round = Number(head.get("Round")) || 1;
    p.validationRound = p.mode === "correction" ? Number(get("validation_round")) || undefined : 0;
    p.supersedes = get("supersedes_blueprint_comment_id");
  }
  if (p.kind === "execution_handoff" || p.kind === "validation_approval") p.blueprintId = get("blueprint_comment_id");
  if (p.kind === "validation_approval" || p.kind === "story_validation_approval" || p.kind === "story_correction") p.handoffId = get("handoff_comment_id");
  if (p.kind === "workflow_request") {
    p.requestId = head.get("Request"); p.taskRef = Number(head.get("Task")?.replace(/^#/, "")) || undefined;
    p.from = head.get("From") ?? (head.get("Author") ? ROLE_OF_AUTHOR[head.get("Author")!] : undefined); p.to = get("to_actor"); p.blueprintId = head.get("Blueprint");
    p.requestType = get("request_type"); p.blocking = get("blocking") === "yes";
    const s = sectionsOf(rest, labels);
    p.question = s.get("question")?.join("\n").trim();
    p.contextEvidence = (s.get("context_evidence") ?? []).filter((l) => l.startsWith("- ")).map((l) => l.slice(2));
  }
  if (p.kind === "execution_handoff") p.branch = sectionsOf(rest, labels).get("branch")?.join("\n").trim() || undefined;
  if (p.kind === "workflow_response") { p.requestId = get("request_id"); p.resolved = get("resolved") === "yes"; }
  if (p.kind === "request_resume") p.requestId = get("request_id");
  if (p.kind === "continuation_handled") p.continuationId = get("continuation_id");
  { const m = / → /.exec(first ?? ""); if (m) p.movedFrom = first!.slice(0, m.index).trim().toLowerCase().replace(/\s+/g, " "); }
  if (p.kind === "human_decision_resolution") { p.decisionRequestId = get("decision_request_comment_id"); p.nextStatus = get("next_status"); p.nextOwner = get("next_owner"); }
  return p;
}

export interface Analysis {
  all: Parsed[];
  blueprint?: Parsed; handoff?: Parsed; approval?: Parsed;
  /** Story-level artifacts (a Story has no Blueprint): the latest readiness predecessor (manual handoff OR the MCP's mechanical readiness promotion) and the latest correction. */
  storyHandoff?: Parsed; storyCorrection?: Parsed;
  /** Human Decision rounds, derived from the artifacts only: the latest request and the resolution (if any) that cites it. */
  decisionRequest?: Parsed; decisionResolution?: Parsed;
  /** Ids of continuations proven handled by an internal Continuation Handled comment on this card. */
  handledContinuations: Set<string>;
  requests: (Parsed & { status: "open" | "resolved" })[];
  openRequests: (Parsed & { status: "open" | "resolved" })[];
  validationRound: number;
  ids: Set<string>;
  /** Telemetry coverage only (never a gate): how many structured artifacts recorded the producer's model. */
  modelCoverage: { known: number; unknown: number };
}

export function analyse(history: HistoryItem[], set: TemplateSet): Analysis {
  const recs = orderedComments(history);
  const all = recs.map((r) => parseArtifact(r, set)).filter((p): p is Parsed => p !== null);
  const last = (k: string) => [...all].reverse().find((p) => p.kind === k);
  const resolved = new Set(all.filter((p) => p.kind === "workflow_response" && p.resolved).map((p) => p.requestId));
  const requests = all.filter((p) => p.kind === "workflow_request").map((q) => ({ ...q, status: (resolved.has(q.requestId) ? "resolved" : "open") as "open" | "resolved" }));
  const blueprint = last("implementation_blueprint");
  const decisionRequest = last("human_decision_request");
  const decisionResolution = decisionRequest ? [...all].reverse().find((p) => p.kind === "human_decision_resolution" && p.decisionRequestId === decisionRequest.id) : undefined;
  return {
    decisionRequest, decisionResolution,
    all, blueprint, handoff: last("execution_handoff"), approval: last("validation_approval"),
    storyHandoff: [...all].reverse().find((p) => p.kind === "story_validation_handoff" || p.kind === "story_readiness_promotion"), storyCorrection: last("story_correction"),
    handledContinuations: new Set(all.filter((p) => p.kind === "continuation_handled" && p.continuationId).map((p) => p.continuationId!)),
    requests, openRequests: requests.filter((q) => q.status === "open"),
    validationRound: blueprint?.validationRound ?? 0,
    ids: new Set(recs.map((r) => r.id)),
    modelCoverage: { known: all.filter((p) => p.model).length, unknown: all.filter((p) => !p.model).length },
  };
}
