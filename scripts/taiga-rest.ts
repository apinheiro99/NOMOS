#!/usr/bin/env node
// The ONLY sanctioned REST helper for agents. It exists because a few Taiga operations have no MCP tool (ordering, Epic links,
// attachments). It reads the Taiga credentials itself and never prints them, so the agent's shell never needs them.
// Reads are free. Writes are an ALLOW-LIST of non-governed operations: ordering fields, Epic<->Story links and attachments.
// Status, comments, descriptions, blocked flags, deletes and anything else are refused: workflow mutations go through the Taiga MCP.
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const ORDER_KEYS = new Set(["version", "taskboard_order", "sprint_order", "kanban_order", "backlog_order", "epic_order", "order"]);
const PATCH_PATH = /^\/(tasks|userstories|issues|epics|milestones)\/\d+$/;
const LINK_PATH = /^\/epics\/\d+\/related_userstories(\/\d+)?$/;
const ATTACH_KINDS = new Set(["tasks", "userstories", "issues", "epics"]);

// Returns null when the request is allowed, otherwise the reason it is refused.
export function checkRequest(method, path, body) {
  const m = String(method).toUpperCase();
  if (typeof path !== "string" || !path.startsWith("/") || path.includes("..") || /[\s\\]/.test(path)) return "invalid path";
  if (m === "GET") return path.startsWith("/auth") ? "the auth endpoint is not readable through the helper" : null;
  if (path.split("?")[0] !== path) return "write paths take no query string";
  if (m === "PATCH") {
    if (!PATCH_PATH.test(path)) return `PATCH is only allowed on a single card (${PATCH_PATH})`;
    const keys = Object.keys(body ?? {});
    if (keys.length === 0 || !keys.every((k) => ORDER_KEYS.has(k))) return `PATCH may only carry ordering fields (${[...ORDER_KEYS].join(", ")}); status, comments, text and flags go through the Taiga MCP`;
    if (keys.every((k) => k === "version")) return "nothing to change";
    return null;
  }
  if (m === "POST" || m === "DELETE") {
    if (!LINK_PATH.test(path)) return `${m} is only allowed for Epic <-> Story links`;
    if (m === "DELETE" && !/\/\d+$/.test(path)) return "DELETE needs the link id";
    const keys = Object.keys(body ?? {});
    if (m === "POST" && !keys.every((k) => ["epic", "user_story"].includes(k))) return "an Epic link carries only epic and user_story";
    return null;
  }
  return `method ${m} is not allowed`;
}

function loadEnv() {
  if (process.env.TAIGA_URL && process.env.TAIGA_USERNAME && process.env.TAIGA_PASSWORD) return;
  const file = process.env.TAIGA_MCP_ENV_FILE || join(homedir(), ".config", "taiga-mcp", "env");
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = /^\s*(?:export\s+)?([A-Z_]+)=(.*)$/.exec(line);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
async function api(method, path, body, form) {
  loadEnv();
  const base = `${process.env.TAIGA_URL.replace(/\/+$/, "")}/api/v1`;
  const auth = await (await fetch(`${base}/auth`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "normal", username: process.env.TAIGA_USERNAME, password: process.env.TAIGA_PASSWORD }) })).json();
  if (!auth.auth_token) throw new Error("login failed");
  const headers = { authorization: `Bearer ${auth.auth_token}`, ...(form ? {} : body ? { "content-type": "application/json" } : {}) };
  const res = await fetch(`${base}${path}`, { method, headers, body: form ?? (body ? JSON.stringify(body) : undefined) });
  const t = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} ${t.slice(0, 200)}`);
  return t ? JSON.parse(t) : null;
}

async function main(argv) {
  const [cmd, a, b, c, d] = argv;
  if (cmd === "get" && a) {
    const why = checkRequest("GET", a.split("?")[0]);
    if (why) throw new Error(why);
    return console.log(JSON.stringify(await api("GET", a)));
  }
  if ((cmd === "patch" || cmd === "post" || cmd === "delete") && a) {
    const body = b ? JSON.parse(b) : undefined;
    const why = checkRequest(cmd, a, body);
    if (why) throw new Error(`refused: ${why}`);
    return console.log(JSON.stringify(await api(cmd.toUpperCase(), a, body)));
  }
  if (cmd === "attach" && ATTACH_KINDS.has(a) && /^\d+$/.test(b ?? "") && /^\d+$/.test(c ?? "") && d) {
    const form = new FormData();
    form.set("project", b); form.set("object_id", c);
    form.set("attached_file", new Blob([readFileSync(d)]), d.split("/").pop());
    return console.log(JSON.stringify(await api("POST", `/${a}/attachments`, undefined, form)));
  }
  throw new Error("usage: taiga-rest.ts get <path> | patch <path> '<json: ordering fields only>' | post|delete <epic link path> '<json>' | attach <tasks|userstories|issues|epics> <project> <object_id> <file>");
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) main(process.argv.slice(2)).catch((e) => { console.error(e.message); process.exit(1); });
