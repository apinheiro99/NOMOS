import type { TaigaClient } from "../client.js";
import { IDENTITY, IdentityIntegrityError, UUID_RE, uuidAttributeId, type IdentityKind } from "../identity.js";
import { renderArtifact, type RenderInput } from "./render.js";

// Canonical references inside governed artifacts. Agents write `Task #874`; the MCP persists `Task <uuid> (#874)`.
// This is the ONLY place that recognises, resolves and rewrites typed references, and `renderGovernedArtifact` is the ONLY way a governed
// artifact is rendered for persistence (the three writers: transition, request_create, request_answer). Untyped `#123` is never interpreted.

const WORD: Record<IdentityKind, string> = { task: "Task", issue: "Issue", userstory: "Story", epic: "Epic" };
// Natural variants (any case, plural, "User Story") -> kind. Output is always the singular canonical word.
const TYPE = "(User Stor(?:y|ies)|Stor(?:y|ies)|Tasks?|Issues?|Epics?)";
const kindOf = (w: string): IdentityKind => { const x = w.toLowerCase(); return x.startsWith("task") ? "task" : x.startsWith("issue") ? "issue" : x.startsWith("epic") ? "epic" : "userstory"; };
// One alternation, canonical construct FIRST so its inner `#ref` (or `Task #874`) is consumed with it and never re-read as a new reference.
//   1: type  2: uuid-like token  3: optional inner type word  4: ref   -> `Task <uuid> (#874)` / `Task <uuid> (Task #874)`
//   5: type  6: ref                                                    -> bare `Task #874`
//   7: ref                                                             -> untyped `#874`: typed by lookup, left alone if no such entity.
//      Coordinated refs (`Task #1 and #2`, `Task #1, #2`, `Task #1 / #2`, `Task #1/#2`) are NOT type-propagated: each bare `#N` is looked up on its own.
//      A `/` before `#N` is accepted only right after another `#N` (never in URLs such as `.../pull/#12`).
const REF = new RegExp(`(?<![\\w#])${TYPE} ([0-9A-Fa-f]{8}-[0-9A-Fa-f-]{4,}) \\((?:${TYPE} )?#(\\d+)\\)|(?<![\\w#])${TYPE} #(\\d+)(?!\\w)|(?<![\\w#&:.\\-]|(?<!#\\d+\\)?)/)#(\\d+)(?!\\w)`, "gi");
// Code is literal text, never interpreted: fenced blocks (``` or ~~~, an unclosed fence runs to the end), inline code spans and lines indented by 4 spaces or a tab.
const CODE = /(?:^|\n)[ ]{0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n[ ]{0,3}\1[`~]*[ \t]*(?=\n|$)|$)|(`+)(?!`)[\s\S]*?(?<!`)\2(?!`)|(?<![^\n])(?: {4}|\t)[^\n]*/g;
const codeRanges = (t: string): [number, number][] => [...t.matchAll(CODE)].map((m) => [m.index!, m.index! + m[0].length]);

export class RefError extends Error { constructor(readonly problems: string[]) { super(problems[0]); this.name = "RefError"; } }

export interface TypeResolver { (ref: number): Promise<IdentityKind | null> }  // which kind owns this number in the project; null = none
export interface RefResolver { (kind: IdentityKind, ref: number): Promise<string> }   // returns the entity's valid UUID or throws RefError

// Pure: rewrites every typed reference using `uuidOf` (already scoped to the artifact's project). Idempotent by construction.
export async function canonicalizeText(input: string, uuidOf: RefResolver, typeOf?: TypeResolver): Promise<string> {
  const found: { index: number; length: number; kind: IdentityKind; ref: number; given?: string; innerKind?: IdentityKind; raw: string; bare?: boolean }[] = [];
  const code = codeRanges(input);
  const untyped: { index: number; length: number; ref: number }[] = [];
  for (const m of input.matchAll(REF)) {
    const at = m.index!;
    if (code.some(([a, b]) => at >= a && at < b)) continue;
    if (m[1]) found.push({ index: at, length: m[0].length, kind: kindOf(m[1]), given: m[2], innerKind: m[3] ? kindOf(m[3]) : undefined, ref: Number(m[4]), raw: m[0] });
    else if (m[5]) found.push({ index: at, length: m[0].length, kind: kindOf(m[5]), ref: Number(m[6]), raw: m[0] });
    else if (typeOf) untyped.push({ index: at, length: m[0].length, ref: Number(m[7]) });
  }
  // Per-call dedup: each distinct (kind, ref) is resolved ONCE and reused for every occurrence. Local to this call, nothing persists.
  const seen = new Map<string, Promise<string>>();
  const once = (kind: IdentityKind, ref: number) => { const k = `${kind}:${ref}`; if (!seen.has(k)) seen.set(k, uuidOf(kind, ref)); return seen.get(k)!; };
  // Untyped `#N`: Taiga numbers Task/Story/Issue/Epic from ONE sequence per project, so a number names at most one entity. Not an entity -> plain text.
  const types = new Map<number, Promise<IdentityKind | null>>();
  for (const u of untyped) {
    if (!types.has(u.ref)) types.set(u.ref, typeOf!(u.ref));
    const kind = await types.get(u.ref)!;
    if (kind) found.push({ index: u.index, length: u.length, kind, ref: u.ref, raw: `#${u.ref}`, bare: true });
  }
  found.sort((a, b) => a.index - b.index);
  const problems: string[] = [];
  const out: { index: number; length: number; to: string }[] = [];
  for (const f of found) {
    const label = `${WORD[f.kind]} #${f.ref}`;
    if (f.innerKind && f.innerKind !== f.kind) { problems.push(`"${f.raw}": the type before the UUID (${WORD[f.kind]}) and inside the parentheses (${WORD[f.innerKind]}) disagree`); continue; }
    if (f.given !== undefined && !UUID_RE.test(f.given)) { problems.push(`"${f.raw}": "${f.given}" is not a valid UUIDv7`); continue; }
    let uuid: string;
    try { uuid = await once(f.kind, f.ref); } catch (e) { if (e instanceof RefError) { problems.push(...e.problems); continue; } throw e; }
    if (f.given !== undefined && f.given.toLowerCase() !== uuid.toLowerCase()) { problems.push(`"${f.raw}": ${label} has UUID ${uuid}, not ${f.given}`); continue; }
    out.push({ index: f.index, length: f.length, to: `${WORD[f.kind]} ${f.given ?? uuid} (#${f.ref})` });
  }
  if (problems.length) throw new RefError([...new Set(problems)]);
  let text = input;
  for (const o of out.reverse()) text = text.slice(0, o.index) + o.to + text.slice(o.index + o.length);
  return text;
}

// Resolver bound to one Taiga project. Fails closed: missing entity, missing/invalid UUID, duplicate attribute definitions.
export function projectResolver(client: TaigaClient, project: number): RefResolver {
  const load = async (kind: IdentityKind, ref: number): Promise<string> => {
    const label = `${WORD[kind]} #${ref}`;
    let ent: { id?: number; project?: number } | undefined;
    try { ent = (await client.get(`/${IDENTITY[kind].entities}/by_ref`, { ref, project })) as typeof ent; } catch { ent = undefined; }
    if (!ent || typeof ent.id !== "number") throw new RefError([`${label} does not exist in project ${project}`]);
    if (ent.project !== undefined && ent.project !== project) throw new RefError([`${label} resolved outside project ${project}`]);
    let attr: number | undefined;
    try { attr = await uuidAttributeId(client, kind, project, false); } catch (e) { if (e instanceof IdentityIntegrityError) throw new RefError([`${label}: ${e.message}`]); throw e; }
    if (attr === undefined) throw new RefError([`${label} has no UUID: project ${project} has no "UUID" attribute for ${kind}; run taiga_uuid_initialize_project first`]);
    const v = ((await client.get(`/${IDENTITY[kind].values}/${ent.id}`)) as { attributes_values?: Record<string, string> }).attributes_values?.[String(attr)];
    if (typeof v !== "string" || !UUID_RE.test(v)) throw new RefError([`${label} has no valid UUIDv7 yet; run taiga_uuid_initialize_project for project ${project}`]);
    return v.toLowerCase();
  };
  return load;
}

export function projectTypeResolver(client: TaigaClient, project: number): TypeResolver {
  return async (ref) => {
    const hits: IdentityKind[] = [];
    for (const kind of Object.keys(WORD) as IdentityKind[]) {
      try { const e = (await client.get(`/${IDENTITY[kind].entities}/by_ref`, { ref, project })) as { id?: number }; if (e && typeof e.id === "number") hits.push(kind); }
      catch (err) { if (!/API error 404\b/.test(String((err as Error)?.message))) throw err; } // only "not found" means "not an entity"; anything else fails closed
    }
    if (hits.length > 1) throw new RefError([`#${ref} matches more than one entity kind in project ${project} (${hits.join(", ")}); write the type explicitly`]);
    return hits[0] ?? null;
  };
}

export type Governed = { ok: true; text: string } | { ok: false; problems: string[] };

// The single render-for-persistence entry point: render, then canonicalize references within the artifact's project.
export async function renderGovernedArtifact(client: TaigaClient, project: number | undefined, inp: RenderInput): Promise<Governed> {
  const rendered = renderArtifact(inp);
  if (!REF_QUICK.test(rendered)) return { ok: true, text: rendered };
  const noProject: RefResolver = async () => { throw new RefError(["the artifact cites typed references but its project is unknown, so they cannot be canonicalized"]); };
  try { return { ok: true, text: project === undefined ? await canonicalizeText(rendered, noProject) : await canonicalizeText(rendered, projectResolver(client, project), projectTypeResolver(client, project)) }; }
  catch (e) { if (e instanceof RefError) return { ok: false, problems: e.problems }; throw e; }
}
const REF_QUICK = /#\d|[0-9A-Fa-f]{8}-/;
