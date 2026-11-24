import type { EntityKind } from "./policy.js";
import type { Field, Template } from "./templates.js";

// Deterministic shape validation against a loaded template (never the technical quality of the content).

const isText = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";
const UNRESOLVED = /\b(unknown|tbd|to be (determined|investigated)|needs? (further )?investigation|investigate)\b/i;
const ROUTINE = /\b(re-?start|migrat\w*|cut-?over|health[- ]check|focused tests?|local git|commit)\b/i;

export const applicableFields = (t: Template, entity: EntityKind): Field[] => t.fields.filter((f) => !(f.taskOnly && entity !== "task"));

interface Sink { messages: string[]; missing: string[]; invalid: string[] }

function checkField(f: Field, v: unknown, sink: Sink): void {
  const where = f.key;
  const problems = { push: (m: string) => { sink.messages.push(m); sink.invalid.push(f.key); } };
  if (v === undefined || v === null) { if (!f.optional) { sink.messages.push(`${where} is required: ${f.description}`); sink.missing.push(f.key); } return; }
  switch (f.kind) {
    case "text": if (!isText(v)) problems.push(`${where} must be a non-empty string`); break;
    case "id": if (!(isText(v) || (typeof v === "number" && Number.isFinite(v)))) problems.push(`${where} must be a comment id`); break;
    case "int": if (!Number.isInteger(v) || (v as number) < 1) problems.push(`${where} must be an integer >= 1`); break;
    case "bool": if (typeof v !== "boolean") problems.push(`${where} must be true or false`); break;
    case "enum": if (!f.values!.includes(v as string)) problems.push(`${where} must be one of: ${f.values!.join(", ")}`); break;
    case "list": {
      const min = f.allowEmpty ? 0 : (f.min ?? 1);
      if (!Array.isArray(v) || v.length < min || v.some((x) => !isText(x))) problems.push(`${where} must be an array of ${min === 0 ? "" : `at least ${min} `}non-empty string(s)${f.allowEmpty ? "" : ' (write "None." when nothing applies)'}`);
      break;
    }
    case "records": {
      if (!Array.isArray(v) || v.length < 1) { problems.push(`${where} must be a non-empty array of objects`); break; }
      const allowed = new Set([...f.keys!, ...(f.optKeys ?? [])]);
      v.forEach((row, i) => {
        if (!row || typeof row !== "object" || Array.isArray(row)) { problems.push(`${where}[${i}] must be an object`); return; }
        const rec = row as Record<string, unknown>;
        for (const k of f.keys!) if (!isText(rec[k])) problems.push(`${where}[${i}].${k} must be a non-empty string`);
        for (const k of Object.keys(rec)) if (!allowed.has(k)) problems.push(`${where}[${i}] has unknown field ${k}`);
        for (const k of f.optKeys ?? []) if (rec[k] !== undefined && !isText(rec[k])) problems.push(`${where}[${i}].${k} must be a non-empty string when given`);
      });
      break;
    }
    case "questions": {
      if (!Array.isArray(v)) { problems.push(`${where} must be an array (empty when nothing is open)`); break; }
      v.forEach((q, i) => {
        const ok = q && typeof q === "object" && isText((q as any).question) && (q as any).classification === "implementation_local";
        if (!ok) problems.push(`${where}[${i}] is not allowed: an executable Blueprint carries no open question unless it is {question, classification: "implementation_local"}; GPT must resolve architectural questions before release`);
      });
      break;
    }
  }
}

export interface ValidationInput { template: Template; entity: EntityKind; artifact: Record<string, unknown>; actorIsPo: boolean }

export interface ValidationResult { messages: string[]; missing: string[]; invalid: string[] }

export function validateArtifact({ template, entity, artifact: a, actorIsPo }: ValidationInput): ValidationResult {
  const sink: Sink = { messages: [], missing: [], invalid: [] };
  const problems = { push: (m: string, field?: string) => { sink.messages.push(m); if (field) sink.invalid.push(field); } };
  const fields = applicableFields(template, entity);
  if (a.type !== template.type) problems.push(`artifact.type must be "${template.type}" for this transition`, "type");
  if (a.version !== undefined && a.version !== template.version) problems.push(`artifact.version "${String(a.version)}" is not the version to use: new artifacts use the highest available (${template.version}); omit it or pass "${template.version}"`, "version");
  const isBlueprint = template.type === "implementation_blueprint";
  if (isBlueprint && a.mode !== template.mode) problems.push(`artifact.mode must be "${template.mode}" for this transition`, "mode");
  const known = new Set(["type", "version", ...(isBlueprint ? ["mode"] : []), ...fields.map((f) => f.key)]);
  for (const k of Object.keys(a)) if (!known.has(k)) problems.push(`unknown artifact field ${k}`, k);
  for (const f of fields) checkField(f, a[f.key], sink);
  if (isBlueprint) {
    if (typeof a.problem_model === "string" && UNRESOLVED.test(a.problem_model)) problems.push("problem_model must state the established problem; an unresolved root cause means the Task is not ready for execution", "problem_model");
    if (Array.isArray(a.findings)) (a.findings as any[]).forEach((f, i) => { if (typeof f?.root_cause === "string" && UNRESOLVED.test(f.root_cause)) problems.push(`findings[${i}].root_cause must be established by GPT, not delegated`, "findings"); });
  }
  if (template.type === "human_decision_request") {
    if (a.blocked === true && !isText(a.blocked_note)) { sink.messages.push("blocked_note is required when blocked=true"); sink.missing.push("blocked_note"); }
    const text = [a.decision_needed, ...(Array.isArray(a.options) ? a.options : [])].filter((x) => typeof x === "string").join("\n");
    if (ROUTINE.test(text)) problems.push("this looks like a routine execution operation (migration, restart, health check, focused tests, local git) that the approved contract already authorizes; Human Decision is only for a genuine unresolved PO choice", "decision_needed");
  }
  if (template.type === "po_decision" && !actorIsPo && !isText(a.instruction_reference)) { sink.messages.push("instruction_reference (the explicit PO instruction) is required unless the PO signs the decision"); sink.missing.push("instruction_reference"); }
  return sink;
}
