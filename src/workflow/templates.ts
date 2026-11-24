import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Workflow artifact templates live as Markdown in <package>/workflow/templates, named `<name>-v<MAJOR>.<MINOR>.<PATCH>.md`.
// They are both the human contract and the field spec the validator/renderer reads. Versioning is manual: add a new file.
// A NEW artifact uses the highest version of its template; an EXISTING artifact is read against the version it declares.
// Anything malformed (bad file name, duplicate version, bad front matter or field line, missing template) fails closed.

export type Kind = "text" | "list" | "int" | "bool" | "id" | "enum" | "records" | "questions";
export interface Field {
  key: string; label: string; kind: Kind; description: string;
  values?: string[]; keys?: string[]; optKeys?: string[]; min?: number;
  optional?: boolean; header?: boolean; taskOnly?: boolean; allowEmpty?: boolean;
}
export type SemVer = [number, number, number];
export interface Template {
  name: string; version: string; semver: SemVer; type: string; mode?: string;
  title: string; display: string; intro: string; fields: Field[]; file: string; text: string;
}
export type TemplateSet = Template[];

export class TemplateError extends Error {
  constructor(message: string) { super(message); this.name = "TemplateError"; }
}

// template name -> artifact type (+ mode). Every one of these must exist at least once.
export const TEMPLATE_TYPES: Record<string, { type: string; mode?: string }> = {
  "implementation-blueprint": { type: "implementation_blueprint", mode: "initial" },
  "correction-blueprint": { type: "implementation_blueprint", mode: "correction" },
  "execution-handoff": { type: "execution_handoff" },
  "validation-approval": { type: "validation_approval" },
  "human-decision-request": { type: "human_decision_request" },
  "human-decision-resolution": { type: "human_decision_resolution" },
  "blocker-report": { type: "blocker_report" },
  "po-decision": { type: "po_decision" },
  "workflow-request": { type: "workflow_request" },
  "request-resume": { type: "request_resume" },
  "workflow-request-response": { type: "workflow_response" },
  "story-start": { type: "story_start" },
  "story-validation-handoff": { type: "story_validation_handoff" },
  "story-validation-approval": { type: "story_validation_approval" },
  "story-correction": { type: "story_correction" },
  "story-readiness-promotion": { type: "story_readiness_promotion" },
  "continuation-handled": { type: "continuation_handled" },
};

export const templatesDir = () =>
  process.env.TAIGA_MCP_TEMPLATES_DIR || join(dirname(fileURLToPath(import.meta.url)), "..", "..", "workflow", "templates");

const FILE_RE = /^([a-z][a-z0-9]*(?:-[a-z0-9]+)*)-v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)\.md$/;
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const FIELD_RE = /^- `([a-z][a-z0-9_]*)` \(([^)]*)\): (.+)$/;
const KINDS: Kind[] = ["text", "list", "int", "bool", "id", "enum", "records", "questions"];
const FLAGS = new Set(["optional", "header", "task-only", "allow-empty"]);

export function parseSemVer(v: string): SemVer | null {
  const m = SEMVER_RE.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
export const compareSemVer = (a: SemVer, b: SemVer) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

// A label is the literal presentation chosen by the template: plain, `**bold**`, `# heading` or `# **heading bold**`. The renderer prints it
// as is. Only those two markings are understood (to recognise the legacy `## <plain label>` form); anything else is ordinary text.
export function plainLabel(label: string): string {
  const t = label.trim().replace(/^#+\s+/, "");
  const m = /^\*\*(.+)\*\*$/.exec(t);
  return (m ? m[1] : t).trim();
}

const labelOf = (key: string) => { const s = key.replace(/_/g, " "); return s[0].toUpperCase() + s.slice(1); };

function parseField(file: string, line: string): Field {
  const m = FIELD_RE.exec(line);
  if (!m) throw new TemplateError(`${file}: malformed field line: ${line}`);
  const [, key, params, description] = m;
  const parts = params.split(", ").map((p) => p.trim());
  const kind = parts[0] as Kind;
  if (!KINDS.includes(kind)) throw new TemplateError(`${file}: field ${key} has unknown kind "${parts[0]}"`);
  const f: Field = { key, label: labelOf(key), kind, description };
  for (const p of parts.slice(1)) {
    const eq = p.indexOf("=");
    const name = eq < 0 ? p : p.slice(0, eq);
    const val = eq < 0 ? "" : p.slice(eq + 1);
    if (eq < 0 && FLAGS.has(name)) {
      if (name === "optional") f.optional = true;
      else if (name === "header") f.header = true;
      else if (name === "task-only") f.taskOnly = true;
      else f.allowEmpty = true;
    } else if (name === "label" && val) f.label = val;
    else if (name === "min" && /^\d+$/.test(val)) f.min = Number(val);
    else if (name === "values" && val) f.values = val.split("|");
    else if (name === "keys" && val) f.keys = val.split("|");
    else if (name === "optional-keys" && val) f.optKeys = val.split("|");
    else throw new TemplateError(`${file}: field ${key} has unknown parameter "${p}"`);
  }
  if (kind === "enum" && !f.values) throw new TemplateError(`${file}: enum field ${key} needs values=`);
  if (kind === "records" && !f.keys) throw new TemplateError(`${file}: records field ${key} needs keys=`);
  return f;
}

function parseTemplate(file: string, name: string, version: string, semver: SemVer, text: string): Template {
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text.replace(/\r\n/g, "\n"));
  if (!m) throw new TemplateError(`${file}: missing front matter`);
  const fm = new Map<string, string>();
  for (const line of m[1].split("\n")) {
    const kv = /^([a-z]+): (.+)$/.exec(line);
    if (!kv) throw new TemplateError(`${file}: malformed front matter line: ${line}`);
    fm.set(kv[1], kv[2].trim());
  }
  const expect = TEMPLATE_TYPES[name];
  if (fm.get("type") !== expect.type || (fm.get("mode") ?? undefined) !== expect.mode) throw new TemplateError(`${file}: front matter type/mode must be ${expect.type}${expect.mode ? `/${expect.mode}` : ""}`);
  const title = fm.get("title");
  if (!title) throw new TemplateError(`${file}: front matter needs a title`);
  const body = m[2];
  const at = body.indexOf("\n## Fields\n");
  if (at < 0) throw new TemplateError(`${file}: missing "## Fields" section`);
  const fields = body.slice(at + "\n## Fields\n".length).split("\n").filter((l) => l.trim() !== "").map((l) => parseField(file, l));
  if (fields.length === 0) throw new TemplateError(`${file}: no fields`);
  const keys = fields.map((f) => f.key);
  if (new Set(keys).size !== keys.length) throw new TemplateError(`${file}: duplicate field key`);
  return { name, version, semver, type: expect.type, mode: expect.mode, title, display: fm.get("display") ?? title, intro: body.slice(0, at).trim(), fields, file, text };
}

export function loadTemplates(dir = templatesDir()): TemplateSet {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { throw new TemplateError(`workflow templates directory unreadable: ${dir}`); }
  const set: Template[] = [];
  for (const file of entries.sort()) {
    if (!statSync(join(dir, file)).isFile()) throw new TemplateError(`${file}: only template files are allowed in ${dir}`);
    const m = FILE_RE.exec(file);
    if (!m) throw new TemplateError(`${file}: invalid template file name (expected <name>-vMAJOR.MINOR.PATCH.md)`);
    const [, name, a, b, c] = m;
    if (!TEMPLATE_TYPES[name]) throw new TemplateError(`${file}: unknown template "${name}"`);
    const version = `${a}.${b}.${c}`;
    if (set.some((t) => t.name === name && t.version === version)) throw new TemplateError(`${file}: duplicate version ${version} of ${name}`);
    set.push(parseTemplate(file, name, version, [Number(a), Number(b), Number(c)], readFileSync(join(dir, file), "utf8")));
  }
  // A persisted artifact is matched to its template by the display name + version in its `Schema:` line: that pair must identify ONE template,
  // otherwise history could be read with the wrong contract.
  const pairs = new Set<string>();
  for (const t of set) { const k = `${t.display}\u0000${t.version}`; if (pairs.has(k)) throw new TemplateError(`${t.file}: display "${t.display}" ${t.version} is already used by another template; an artifact's Schema line must identify exactly one template`); pairs.add(k); }
  for (const name of Object.keys(TEMPLATE_TYPES)) if (!set.some((t) => t.name === name)) throw new TemplateError(`no version of template "${name}" exists in ${dir}`);
  return set;
}

export function latest(set: TemplateSet, name: string): Template {
  const all = set.filter((t) => t.name === name);
  if (all.length === 0) throw new TemplateError(`no version of template "${name}" exists`);
  return all.reduce((a, b) => (compareSemVer(b.semver, a.semver) > 0 ? b : a));
}
export const exact = (set: TemplateSet, name: string, version: string) => set.find((t) => t.name === name && t.version === version);
export const nameFor = (type: string, mode?: string) => Object.keys(TEMPLATE_TYPES).find((n) => TEMPLATE_TYPES[n].type === type && TEMPLATE_TYPES[n].mode === mode)!;
export const versions = (set: TemplateSet, name: string) => set.filter((t) => t.name === name).sort((a, b) => compareSemVer(b.semver, a.semver)).map((t) => t.version);

// Structured, machine-readable view of a template for agents composing an artifact (taiga_workflow_template). Purely derived from the
// parsed Markdown: the file stays the only contract and the raw Markdown is still returned next to this view.
const FORMAT: Record<Kind, string> = {
  text: "text", list: "list of non-empty items", int: "integer", bool: "boolean", id: "comment id (opaque string, exactly as workflow_state shows it)",
  enum: "one of the allowed values", records: "list of records", questions: "list of questions",
};
export const COMMON_HEADER = [
  "Movement (real Taiga status movement, `Status unchanged`, or for a Human Decision Resolution the INTENDED manual PO move `Human Decision → <next_status>`; nothing moved)",
  "Schema: <display name> <version>",
  "Author (authenticated actor)",
  "Model (declared telemetry, `Unknown` when absent)",
  "Effort (Low|Medium|High|Unknown)",
] as const;

export function describeTemplate(t: Template) {
  const fields = t.fields.map((f) => ({
    key: f.key, required: !f.optional, kind: f.kind, format: FORMAT[f.kind], label: f.label, description: f.description,
    ...(f.values ? { allowed_values: f.values } : {}),
    ...(f.keys ? { record_keys: f.keys } : {}),
    ...(f.optKeys ? { optional_record_keys: f.optKeys } : {}),
    ...(f.min !== undefined ? { min_items: f.min } : {}),
    ...(f.allowEmpty ? { allow_empty: true } : {}),
    placement: f.header ? "header" : "body",
    ...(f.taskOnly ? { task_only: true } : {}),
  }));
  return {
    artifact: { type: t.type, ...(t.mode ? { mode: t.mode } : {}), title: t.title, display: t.display },
    purpose: t.intro.split("\n\n")[0],
    common_header: COMMON_HEADER,
    required_fields: fields.filter((f) => f.required).map((f) => f.key),
    optional_fields: fields.filter((f) => !f.required).map((f) => f.key),
    fields,
  };
}
