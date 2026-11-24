import { createHash, timingSafeEqual } from "node:crypto";

// Who is calling. Two modes, never confused:
// - "syntactic": nothing configured; `author` is only a signature a caller types (never proof of identity).
// - "authenticated": the transport knows the actor. Both agents reach this MCP as a stdio child process spawned by their own
//   launcher (Claude Code via ~/.local/bin/taiga-mcp.sh, ChatGPT via its tunnel-client profile), so the simplest reliable
//   identity is one fixed actor per process: TAIGA_MCP_ACTOR=gpt|claude|po. For the HTTP transport, a static bearer token per
//   actor (TAIGA_MCP_GPT_TOKEN / TAIGA_MCP_CLAUDE_TOKEN / TAIGA_MCP_PO_TOKEN) resolves the same actors.
// The MCP, not the agent, chooses the signature. Authority depends only on role + authenticated identity, never on a model name or effort.

export type ActorRole = "gpt" | "claude" | "po";
export interface ActorContext { role: ActorRole; display: string; authenticated: true }
export interface WorkflowIdentity { mode: "syntactic" | "authenticated"; actor: ActorContext | null }

export const ACTOR_DISPLAY: Record<ActorRole, string> = {
  gpt: "GPT",
  claude: "Claude Code",
  po: "Andre",
};
const ROLES = Object.keys(ACTOR_DISPLAY) as ActorRole[];
export const MIN_TOKEN_LENGTH = 16;

export interface ActorConfig { tokens: Map<ActorRole, string>; stdioActor: ActorRole | null }

// Telemetry (Model / Effort) is declared by the agent on each call, never by the launcher. It is self-declared metadata:
// it never takes part in authorization, the matrix, validation or fail-closed. Absent or invalid = "Unknown" (never an error,
// never a guess, never silently truncated into a possibly false value).
export const UNKNOWN = "Unknown";
export const EFFORTS = ["Low", "Medium", "High"] as const;
export function normalizeModel(raw: unknown): string {
  if (typeof raw !== "string") return UNKNOWN;
  const m = raw.normalize("NFC").trim();
  return /^[\p{L}\p{N} ._:+()\/-]{1,60}$/u.test(m) && m.toLowerCase() !== "unknown" ? m : UNKNOWN;
}
export function normalizeEffort(raw: unknown): string {
  if (typeof raw !== "string") return UNKNOWN;
  const e = raw.trim().toLowerCase();
  return EFFORTS.find((x) => x.toLowerCase() === e) ?? UNKNOWN;
}
export interface CallMeta { model?: unknown; effort?: unknown }
// Header label of the authenticated actor (artifacts only; legacy comments keep their own signature).
export const AUTHOR_LABEL: Record<ActorRole, string> = { gpt: "GPT", claude: "Claude Code", po: "PO" };
export const ROLE_OF_AUTHOR: Record<string, ActorRole> = { GPT: "gpt", "Claude Code": "claude", PO: "po" };

export function loadActorConfig(env: NodeJS.ProcessEnv = process.env): ActorConfig {
  const tokens = new Map<ActorRole, string>();
  for (const role of ROLES) {
    const name = `TAIGA_MCP_${role.toUpperCase()}_TOKEN`;
    const token = env[name];
    if (token === undefined || token === "") continue;
    if (token.length < MIN_TOKEN_LENGTH) throw new Error(`${name} must be at least ${MIN_TOKEN_LENGTH} characters`);
    tokens.set(role, token);
  }
  if (new Set(tokens.values()).size !== tokens.size) throw new Error("actor tokens must be distinct");
  const raw = env.TAIGA_MCP_ACTOR?.trim().toLowerCase();
  if (raw && !ROLES.includes(raw as ActorRole)) throw new Error(`TAIGA_MCP_ACTOR must be one of ${ROLES.join(", ")}`);
  return { tokens, stdioActor: (raw as ActorRole) || null };
}

export const actorFor = (role: ActorRole): ActorContext => ({ role, display: ACTOR_DISPLAY[role], authenticated: true });

// HTTP: constant-time comparison over fixed-length digests; the token is never echoed or logged.
export function actorFromAuthorization(config: ActorConfig, header: string | undefined): ActorContext | null {
  const m = /^Bearer\s+(\S+)$/i.exec(header ?? "");
  if (!m) return null;
  const given = createHash("sha256").update(m[1]).digest();
  let found: ActorRole | null = null;
  for (const [role, token] of config.tokens) if (timingSafeEqual(given, createHash("sha256").update(token).digest())) found = role;
  return found ? actorFor(found) : null;
}

export function identityFromEnv(env: NodeJS.ProcessEnv = process.env): WorkflowIdentity {
  const { stdioActor } = loadActorConfig(env);
  return stdioActor ? { mode: "authenticated", actor: actorFor(stdioActor) } : { mode: "syntactic", actor: null };
}

// Syntactic mode only: best-effort role from the typed signature. Unknown signatures get no workflow authority.
export function roleFromAuthor(author: string): ActorRole | null {
  const t = author.trim().toLowerCase();
  if (/^gpt\b/.test(t)) return "gpt";
  if (/^claude\b/.test(t)) return "claude";
  if (/^(andr[eé]|po|product owner)\b/.test(t)) return "po";
  return null;
}

export const callerRole = (identity: WorkflowIdentity, author?: string): ActorRole | null =>
  identity.actor ? identity.actor.role : author ? roleFromAuthor(author) : null;
