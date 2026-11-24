import type { ActorRole as PolicyRole } from "./actor.js";

// Actor-aware, state-aware transition policy. Status names (never numeric ids) carry the semantics, so the strict profile
// is capability-detected from the project's own status vocabulary and never hardcodes a project.

export type EntityKind = "task" | "userstory" | "epic";
export type ArtifactType =
  | "implementation_blueprint" | "execution_handoff" | "validation_approval"
  | "human_decision_request" | "blocker_report" | "po_decision" | "workflow_request" | "request_resume"
  | "story_start" | "story_validation_handoff" | "story_validation_approval" | "story_correction";
export type BlueprintMode = "initial" | "correction";

export const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

const TASK_NAMES = ["to do", "in progress", "gpt validation", "human decision", "done", "cancelled"];
const CARD_NAMES = ["in progress", "gpt validation", "done"];
// Story has its OWN strict vocabulary (Ready -> In Progress -> GPT Validation -> Done); Epic keeps the shared card names.
const STORY_NAMES = ["ready", "in progress", "gpt validation", "done"];
const STORY_ESCAPES = ["human decision", "cancelled"];
export const requiredStatusNames = (entity: EntityKind) => (entity === "task" ? TASK_NAMES : entity === "userstory" ? STORY_NAMES : CARD_NAMES);

export interface Vocabulary {
  strict: boolean;
  hasRequest: boolean;
  missing: string[];
  ambiguous: string[]; // every normalized name carried by more than one status
  broken: string[];    // the ambiguous names that have workflow meaning: a workflow integrity error
  idByName: Map<string, number>;
  nameById: Map<number, string>;
  displayById: Map<number, string>;
}

// The names that carry workflow meaning for an entity (the optional Task `Request` included). One definition, used by every consumer.
export const semanticStatusNames = (entity: EntityKind) => (entity === "task" ? [...TASK_NAMES, "request"] : entity === "userstory" ? [...STORY_NAMES, ...STORY_ESCAPES] : CARD_NAMES);

// ONE closure-semantics function: the SCOPE WORKFLOW meaning of a status (Done/Cancelled = ended, every other state = open).
// For a Task it is also the is_closed the MCP proves. For a User Story it is workflow semantics ONLY: it does not represent, write or validate the
// Taiga userstory.is_closed field, which this Taiga derives from the child Tasks and ignores writes to (Issue #243).
// Returns undefined when the entity has no governed closure semantics for that status (Epic, unknown names): callers then leave closure alone.
export function closureFor(entity: EntityKind, status: string): boolean | undefined {
  if (entity === "task") return TASK_NAMES.includes(status) || status === "request" ? status === "done" || status === "cancelled" : undefined;
  if (entity === "userstory") return STORY_NAMES.includes(status) || STORY_ESCAPES.includes(status) ? status === "done" || status === "cancelled" : undefined;
  return undefined;
}

export function vocabulary(entity: EntityKind, statuses: unknown): Vocabulary {
  const idsByName = new Map<string, Set<number>>();
  const nameById = new Map<number, string>();
  const displayById = new Map<number, string>();
  if (Array.isArray(statuses)) {
    for (const s of statuses as { id?: number; name?: string }[]) {
      if (typeof s?.id === "number" && typeof s?.name === "string") {
        const n = norm(s.name);
        (idsByName.get(n) ?? idsByName.set(n, new Set()).get(n)!).add(s.id);
        nameById.set(s.id, n); displayById.set(s.id, s.name.trim());
      }
    }
  }
  const ambiguous = [...idsByName].filter(([, ids]) => ids.size > 1).map(([n]) => n);
  // An ambiguous name never resolves to an id: no consumer can pick one silently. (`strict` still reflects that the names exist.)
  const idByName = new Map([...idsByName].filter(([, ids]) => ids.size === 1).map(([n, ids]) => [n, [...ids][0]] as [string, number]));
  const missing = requiredStatusNames(entity).filter((n) => !idsByName.has(n));
  const broken = semanticStatusNames(entity).filter((n) => ambiguous.includes(n));
  return { strict: missing.length === 0, hasRequest: idsByName.has("request"), missing, ambiguous, broken, idByName, nameById, displayById };
}

// Single fail-closed message for a project whose workflow statuses are ambiguous; null when the vocabulary is sound.
export const integrityMessage = (entity: EntityKind, vocab: Vocabulary): string | null =>
  vocab.broken.length ? `ambiguous status names in this project's ${entity} workflow: ${vocab.broken.join(", ")}; the workflow cannot resolve them and fails closed` : null;

export interface Pair { from: string; to: string; roles: PolicyRole[]; artifact: ArtifactType; mode?: BlueprintMode }

const TASK_PAIRS: Pair[] = [
  { from: "to do", to: "in progress", roles: ["gpt", "po"], artifact: "implementation_blueprint", mode: "initial" },
  { from: "gpt validation", to: "in progress", roles: ["gpt", "po"], artifact: "implementation_blueprint", mode: "correction" },
  { from: "in progress", to: "gpt validation", roles: ["claude"], artifact: "execution_handoff" },
  // Optional `Request` status is a workflow-closed state (strictly limited transitions; is_closed stays false): Claude stops and asks GPT; only Claude resumes, citing the resolving answer. The only exits
  // are explicit: In Progress (resume), Human Decision (GPT/PO escalates to the PO) and Cancelled (explicit PO exception).
  { from: "in progress", to: "request", roles: ["claude"], artifact: "workflow_request" },
  { from: "request", to: "in progress", roles: ["claude"], artifact: "request_resume" },
  { from: "request", to: "human decision", roles: ["gpt", "po"], artifact: "human_decision_request" },
  { from: "gpt validation", to: "done", roles: ["gpt", "po"], artifact: "validation_approval" },
  { from: "gpt validation", to: "human decision", roles: ["gpt"], artifact: "human_decision_request" },
  { from: "to do", to: "human decision", roles: ["gpt"], artifact: "human_decision_request" },
  { from: "in progress", to: "human decision", roles: ["claude"], artifact: "human_decision_request" },
  { from: "in progress", to: "to do", roles: ["claude", "gpt"], artifact: "blocker_report" },
  // PO 2026-11-19: GPT may return a card from GPT Validation to To Do (blocked, with the Blocker Report) when another Task must finish first.
  { from: "gpt validation", to: "to do", roles: ["gpt"], artifact: "blocker_report" },
  { from: "*", to: "cancelled", roles: ["gpt", "po"], artifact: "po_decision" },
];
// Story/Epic parity: only the ownership hand-offs that have a defined artifact are typed; the other moves stay on the
// generic commented path.
const CARD_PAIRS: Pair[] = [
  { from: "in progress", to: "gpt validation", roles: ["claude"], artifact: "execution_handoff" },
  { from: "gpt validation", to: "done", roles: ["gpt", "po"], artifact: "validation_approval" },
];
const CARD_GOVERNED_TARGETS = new Set(["gpt validation", "done"]);

// Story lifecycle. Starting, promoting to validation, returning and approving are aggregate orchestration decisions owned by GPT/PO;
// Claude executes the child Tasks and never decides Story progression. Human Decision / Cancelled stay on the commented path.
const STORY_PAIRS: Pair[] = [
  { from: "ready", to: "in progress", roles: ["gpt", "po"], artifact: "story_start" },
  { from: "in progress", to: "gpt validation", roles: ["gpt", "po"], artifact: "story_validation_handoff" },
  { from: "gpt validation", to: "in progress", roles: ["gpt", "po"], artifact: "story_correction" },
  { from: "gpt validation", to: "done", roles: ["gpt", "po"], artifact: "story_validation_approval" },
];
const STORY_GOVERNED_TARGETS = new Set(["in progress", "gpt validation", "done"]);

export const pairsFor = (entity: EntityKind) => (entity === "task" ? TASK_PAIRS : entity === "userstory" ? STORY_PAIRS : CARD_PAIRS);
const matches = (p: Pair, from: string, to: string) => (p.from === "*" || p.from === from) && p.to === to;

export type Resolution =
  | { kind: "typed"; artifact: ArtifactType; mode?: BlueprintMode; override: boolean }
  | { kind: "legacy" }
  | { kind: "denied"; reason: string };

export function resolveTransition(entity: EntityKind, role: PolicyRole | null, from: string, to: string): Resolution {
  if (from === to) return { kind: "denied", reason: `the card is already in "${to}"` };
  const governed = entity === "task" || (entity === "userstory" ? STORY_GOVERNED_TARGETS : CARD_GOVERNED_TARGETS).has(to);
  if (!governed) return { kind: "legacy" };
  const candidates = pairsFor(entity).filter((p) => matches(p, from, to));
  if (entity === "task" && (from === "request" || to === "request")) {
    // Agents see a closed state: only the modelled pairs, no wildcard in or out. The authenticated PO is the exception: a manual move is authoritative, so it may enter or leave Request with a PO Decision.
    if (from === "request" && to === "cancelled") return role === "po" ? { kind: "typed", artifact: "po_decision", override: false } : { kind: "denied", reason: `"request" -> "cancelled" is an explicit PO exception (caller is ${role ?? "unknown"})` };
    const ok = role ? candidates.find((p) => p.from !== "*" && p.roles.includes(role)) : undefined;
    if (ok) return { kind: "typed", artifact: ok.artifact, mode: ok.mode, override: false };
    if (role === "po") return { kind: "typed", artifact: "po_decision", override: true };
    return { kind: "denied", reason: candidates.length && candidates[0].from !== "*" ? `"${from}" -> "${to}" is reserved for ${candidates[0].roles.join("/")} (caller is ${role ?? "unknown"})` : `"${from}" -> "${to}" is not allowed: Request is a closed state (exits: In Progress via request_resume, Human Decision, Cancelled by the PO) and is entered only from In Progress by Claude` };
  }
  if (role) {
    const ok = candidates.find((p) => p.roles.includes(role));
    if (ok) return { kind: "typed", artifact: ok.artifact, mode: ok.mode, override: false };
    // The PO may override any transition, leaving a structured Decision so the history stays explainable.
    if (role === "po") return { kind: "typed", artifact: "po_decision", override: true };
  }
  if (candidates.length) return { kind: "denied", reason: `"${from}" -> "${to}" is reserved for ${candidates[0].roles.join("/")}${role ? ` (caller is ${role})` : " (caller identity is unknown or has no workflow authority)"}` };
  return { kind: "denied", reason: `no transition "${from}" -> "${to}" exists for ${role ?? "an unrecognized caller"}; only the PO can override with a PO Decision` };
}

// Who owns a card in a given status (Guide 3 ownership protocol).
export function ownerRole(status: string): PolicyRole | null {
  switch (status) {
    case "to do": case "gpt validation": case "request": return "gpt";
    case "in progress": return "claude";
    case "human decision": return "po";
    default: return null;
  }
}

// A resolved Human Decision never releases execution: whatever status the Task entered from, the PO's manual move goes to GPT Validation
// (owner gpt), where GPT reconciles the decision with the contract. The fixed pair lives in the resolution template (enum values); this is
// only the status the state model compares against to tell a compliant resolution from a legacy (v1.0.0) one.
export const DECISION_RESUME_STATUS = "gpt validation";

export interface ActionRow { action: string; target: string; artifact?: ArtifactType; mode?: BlueprintMode; override?: boolean; allowed: boolean; why?: string }

const TARGETS: Record<EntityKind, string[]> = {
  task: ["to do", "in progress", "request", "gpt validation", "human decision", "done", "cancelled"],
  userstory: ["ready", "in progress", "gpt validation", "human decision", "done", "cancelled"],
  epic: ["gpt validation", "done"],
};

// Deterministic read model. It is DERIVED from resolveTransition for every target, so it can never advertise an action the policy
// refuses (or hide one it allows). `names` limits the targets to the statuses the project really has (Request is optional).
export function actionsFor(entity: EntityKind, role: PolicyRole | null, current: string, names?: Iterable<string>): { allowed: ActionRow[]; denied: ActionRow[] } {
  const have = names ? new Set(names) : null;
  const allowed: ActionRow[] = [];
  const denied: ActionRow[] = [];
  for (const target of TARGETS[entity]) {
    if (target === current || (have && !have.has(target))) continue;
    const r = resolveTransition(entity, role, current, target);
    if (r.kind === "typed") allowed.push({ action: "workflow_transition", target, artifact: r.artifact, mode: r.mode, override: r.override, allowed: true });
    else if (r.kind === "denied") denied.push({ action: "workflow_transition", target, allowed: false, why: r.reason });
  }
  return { allowed, denied };
}
