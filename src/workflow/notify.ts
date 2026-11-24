import { execFile } from "node:child_process";
import type { ActorRole } from "./actor.js";

// Optional, best-effort notification after a workflow event is ALREADY persisted in Taiga. The Bridge only points the other agent
// at the Task/Request (typed, tiny, no payload); Taiga stays the authority and a failure here never undoes a transition.
// Enabled by TAIGA_MCP_NOTIFY_COMMAND: a JSON array, e.g. ["node","/scope/claude-bridge/probe/ctl.ts","notify"].
// The MCP appends: --type T --task <ref> | --story <ref> --project <id> | --sprint <id> --project <id> --from gpt|claude [--request R-n-m] [--status "<name>"].

export type NoticeType =
  | "TASK_RELEASED" | "TASK_MOVED_TO_GPT_VALIDATION" | "TASK_RETURNED_TO_IN_PROGRESS" | "TASK_MOVED_TO_HUMAN_DECISION" | "TASK_DONE" | "STORY_DONE" | "SPRINT_CLOSED"
  | "WORKFLOW_REQUEST_OPENED" | "WORKFLOW_REQUEST_ANSWERED" | "WORKFLOW_REQUEST_RESOLVED";
export type Party = "gpt" | "claude";
// Exactly one of taskRef / storyRef identifies the entity the pointer is about; every notice carries the owning projectId, because Taiga refs are project-scoped.
export interface Notice { type: NoticeType; taskRef?: number; storyRef?: number; sprintId?: number; projectId?: number; from: Party; requestId?: string; status?: string }
export type NotifyOutcome = "sent" | "failed" | "disabled" | "skipped";

const NOTIFY_TIMEOUT_MS = 5000;
// Signed merge authorization hand-off. Opt-in (the notify command must be known to accept it), completion notices only, and over STDIN as
// {"authorization": <envelope>}: never argv (process list) and never in a log. Taiga stays the authority; the notifier only carries bytes.
export const AUTH_STDIN_ENV = "TAIGA_MCP_NOTIFY_AUTH_STDIN";
export const authorizationTravels = (n: Notice | null, authorization: unknown, env: NodeJS.ProcessEnv = process.env): boolean =>
  n !== null && authorization !== undefined && (n.type === "TASK_DONE" || n.type === "STORY_DONE" || n.type === "SPRINT_CLOSED") && env[AUTH_STDIN_ENV] === "1";
const isParty = (r: ActorRole | null | undefined): r is Party => r === "gpt" || r === "claude";

// Which transition produces which notice. Cancel, blocker and PO overrides have no Bridge notice (the PO is not a Bridge party).
export function noticeForTransition(role: ActorRole | null, from: string, to: string, taskRef: number | undefined, statusName: string, requestId?: string, entity: "task" | "userstory" = "task", projectId?: number): Notice | null {
  if (!isParty(role) || taskRef === undefined) return null;
  // A Story only notifies its approved completion; every other Story move (start, handoff, correction) stays silent.
  if (entity === "userstory") return from === "gpt validation" && to === "done" ? { type: "STORY_DONE", storyRef: taskRef, projectId, from: role, status: statusName } : null;
  const base = { taskRef, projectId, from: role, status: statusName };
  if (to === "request" && requestId) return { type: "WORKFLOW_REQUEST_OPENED", taskRef, projectId, from: role, requestId };
  if (to === "in progress" && from === "to do") return { type: "TASK_RELEASED", ...base };
  if (to === "in progress" && from === "gpt validation") return { type: "TASK_RETURNED_TO_IN_PROGRESS", ...base };
  if (to === "gpt validation") return { type: "TASK_MOVED_TO_GPT_VALIDATION", ...base };
  if (to === "human decision") return { type: "TASK_MOVED_TO_HUMAN_DECISION", ...base };
  if (to === "done") return { type: "TASK_DONE", ...base };
  return null;
}

function command(env: NodeJS.ProcessEnv): string[] | null | "invalid" {
  const raw = env.TAIGA_MCP_NOTIFY_COMMAND;
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "string" && x !== "") ? v : "invalid";
  } catch { return "invalid"; }
}

function entityArgs(n: Notice): string[] {
  const project = n.projectId !== undefined ? ["--project", String(n.projectId)] : [];
  if (n.sprintId !== undefined) return ["--sprint", String(n.sprintId), ...project];
  if (n.storyRef !== undefined) return ["--story", String(n.storyRef), ...project];
  return ["--task", String(n.taskRef), ...project];
}

// Never throws and never waits longer than the timeout. The child gets a clean environment (no Taiga credentials).
export async function emitNotice(n: Notice | null, env: NodeJS.ProcessEnv = process.env, authorization?: unknown): Promise<NotifyOutcome> {
  const cmd = command(env);
  if (cmd === null) return "disabled";
  if (cmd === "invalid") return "failed";
  if (n === null) return "skipped";
  const args = [...cmd.slice(1), "--type", n.type, ...entityArgs(n), "--from", n.from, ...(n.requestId ? ["--request", n.requestId] : []), ...(n.status ? ["--status", n.status] : [])];
  const clean: NodeJS.ProcessEnv = { PATH: env.PATH, HOME: env.HOME, LANG: env.LANG };
  for (const [k, v] of Object.entries(env)) if (k.startsWith("CLAUDE_BRIDGE_")) clean[k] = v;
  return new Promise((resolve) => {
    try {
      const child = execFile(cmd[0], args, { env: clean, timeout: NOTIFY_TIMEOUT_MS, windowsHide: true }, (err) => resolve(err ? "failed" : "sent"));
      child.stdin?.on("error", () => {}); // a notifier that exits without reading stdin must not break the delivery result
      child.stdin?.end(authorizationTravels(n, authorization, env) ? JSON.stringify({ authorization }) : undefined); // always closed, so a stdin-reading notifier never waits
    } catch { resolve("failed"); }
  });
}
