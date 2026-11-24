import { applicableFields } from "./artifacts.js";
import { AUTHOR_LABEL, normalizeEffort, normalizeModel, type ActorRole, type CallMeta } from "./actor.js";
import type { EntityKind } from "./policy.js";
import type { Field, Template } from "./templates.js";

// Canonical Markdown owned by the MCP, driven by the template. The presentation of every body field is exactly its template `label`.
// Common header of every governed artifact (envelope, not template fields):
//   <From> → <To>   (or `Status unchanged`)
//   Schema: <Display name> <version>
//   Author: <authenticated role>        Model: <declared or Unknown>        Effort: <Low|Medium|High|Unknown>
//   then the artifact-specific metadata. Model and Effort are self-declared telemetry and never authority.

const one = (v: unknown) => String(v).trim().replace(/\r?\n/g, "\n  ");
function body(f: Field, v: unknown): string {
  switch (f.kind) {
    case "list": return (v as string[]).length === 0 ? "None." : (v as string[]).map((x) => `- ${one(x)}`).join("\n");
    case "records": return (v as Record<string, unknown>[]).map((row) => `- ${Object.entries(row).map(([k, x]) => `${k}: ${one(x)}`).join("; ")}`).join("\n");
    case "bool": return v ? "yes" : "no";
    case "questions": return (v as { question: string }[]).length === 0 ? "None." : (v as { question: string }[]).map((q) => `- ${one(q.question)} (implementation-local)`).join("\n");
    default: return one(v);
  }
}

export interface RenderInput {
  template: Template; entity: EntityKind; artifact: Record<string, unknown>;
  author: ActorRole;                                  // authenticated actor role, never taken from the payload
  transition: { from: string; to: string } | null;     // real movement in Taiga, or null = `Status unchanged`
  // Human Decision Resolution only: the movement the PO is AUTHORIZED to perform manually next. Rendered in the same `<from> → <to>` form
  // as a real transition, but nothing moved: the Task keeps its real status. Ignored when `transition` is set.
  intendedMovement?: { from: string; to: string };
  meta?: CallMeta;                                    // Model / Effort declared by the agent on the call
  round?: number;                                     // blueprints only
  preLines?: string[];                                // MCP-owned `Key: value` lines right after the common header (requests: Request)
  postLines?: string[];                               // after the template header fields (requests: Blueprint)
}

export function renderArtifact(inp: RenderInput): string {
  const t = inp.template;
  const fields = applicableFields(t, inp.entity);
  const lines = [
    inp.transition ? `${inp.transition.from} → ${inp.transition.to}` : inp.intendedMovement ? `${inp.intendedMovement.from} → ${inp.intendedMovement.to}` : "Status unchanged",
    `Schema: ${t.display} ${t.version}`,
    `Author: ${AUTHOR_LABEL[inp.author]}`,
    `Model: ${normalizeModel(inp.meta?.model)}`,
    `Effort: ${normalizeEffort(inp.meta?.effort)}`,
  ];
  if (t.type === "implementation_blueprint") lines.push(`Mode: ${t.mode}`, `Round: ${inp.round ?? 1}`);
  lines.push(...(inp.preLines ?? []));
  for (const f of fields) if (f.header && inp.artifact[f.key] !== undefined) lines.push(`${f.label}: ${body(f, inp.artifact[f.key])}`);
  lines.push(...(inp.postLines ?? []));
  for (const f of fields) if (!f.header && inp.artifact[f.key] !== undefined) lines.push("", f.label, body(f, inp.artifact[f.key]));
  return lines.join("\n");
}
