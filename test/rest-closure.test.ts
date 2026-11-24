import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkRequest } from "../scripts/taiga-rest.ts";

// The REST bypass closure: the sanctioned helper cannot mutate governed fields, and the Claude-side deny rules cover the credential paths.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

test("helper: reads are free; ordering, Epic links and attachments are the only writes", () => {
  assert.equal(checkRequest("GET", "/tasks/5"), null);
  assert.equal(checkRequest("GET", "/history/task/5"), null);
  assert.equal(checkRequest("PATCH", "/tasks/5", { version: 3, taskboard_order: 7 }), null);
  assert.equal(checkRequest("PATCH", "/userstories/9", { version: 1, sprint_order: 10 }), null);
  assert.equal(checkRequest("POST", "/epics/4/related_userstories", { epic: 4, user_story: 9 }), null);
  assert.equal(checkRequest("DELETE", "/epics/4/related_userstories/22"), null);
});

test("helper: it cannot change status, comments, text or flags, delete, create, or reach the auth/history-delete endpoints", () => {
  for (const body of [{ status: 2 }, { version: 1, status: 2 }, { comment: "x", version: 1 }, { description: "d", version: 1 }, { subject: "s" }, { is_blocked: true }, { blocked_note: "n" }, { version: 1, taskboard_order: 1, status: 5 }, { assigned_to: 3 }, { milestone: 2 }, {}, { version: 3 }]) {
    assert.ok(checkRequest("PATCH", "/tasks/5", body), `PATCH ${JSON.stringify(body)} must be refused`);
  }
  for (const [m, p, b] of [
    ["DELETE", "/tasks/5"], ["DELETE", "/history/task/5/delete_comment"], ["POST", "/history/task/5/delete_comment"], ["POST", "/tasks", { project: 1, subject: "s", status: 2 }],
    ["POST", "/tasks/bulk_create", {}], ["POST", "/auth", {}], ["GET", "/auth"], ["PUT", "/tasks/5", {}], ["PATCH", "/tasks", { order: 1 }], ["PATCH", "/tasks/5/extra", { order: 1 }],
    ["PATCH", "/tasks/5?x=1", { order: 1 }], ["PATCH", "/../admin", { order: 1 }], ["PATCH", "/task-statuses/5", { order: 1 }], ["POST", "/epics/4/related_userstories", { epic: 4, user_story: 9, status: 1 }], ["DELETE", "/epics/4/related_userstories"],
  ]) assert.ok(checkRequest(m, p, b), `${m} ${p} must be refused`);
});

test("helper CLI: a refused write fails before any network call and says why; no credentials are needed to be refused", () => {
  const run = (...args) => spawnSync(process.execPath, [join(ROOT, "scripts", "taiga-rest.ts"), ...args], { encoding: "utf8", env: { PATH: process.env.PATH, TAIGA_URL: "http://127.0.0.1:1", TAIGA_USERNAME: "u", TAIGA_PASSWORD: "p" } });
  for (const args of [["patch", "/tasks/5", '{"status":2}'], ["patch", "/tasks/5", '{"comment":"x","version":1}'], ["delete", "/tasks/5"], ["post", "/tasks", '{"project":1}']]) {
    const r = run(...args);
    assert.equal(r.status, 1, args.join(" "));
    assert.match(r.stderr, /refused|usage/, args.join(" "));
    assert.ok(!/ECONNREFUSED|fetch failed/.test(r.stderr), "refused before touching the network");
  }
});

// Claude Code Bash rules: `*` is a wildcard. Emulate it to check the rules cover the ways to reach the credentials.
const rules = JSON.parse(readFileSync(join(ROOT, "ops", "rest-closure", "claude-deny-rules.json"), "utf8")).permissions.deny;
const re = (pat) => new RegExp(`^${pat.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
const denied = (tool, arg) => rules.filter((r) => r.startsWith(`${tool}(`)).some((r) => re(r.slice(tool.length + 1, -1)).test(arg));

test("deny rules: the credential file, the Taiga API, TAIGA_* variables and /proc environ are out of the tool surface; the sanctioned helper is not", () => {
  for (const cmd of [
    "cat ~/.config/taiga-mcp/env", '. "$HOME/.config/taiga-mcp/env"', "set -a; source /home/dev/.config/taiga-mcp/env", "grep PASSWORD /home/dev/.config/taiga-mcp/env", "cut -d= -f1 ~/.config/taiga-mcp/env",
    "curl -s -X PATCH http://192.168.1.95:9000/api/v1/tasks/5 -d '{\"status\":2}'", "curl http://192.168.1.95:9000/api/v1/auth", "echo $TAIGA_PASSWORD", "env | grep TAIGA_USERNAME",
    "cat /proc/1321263/environ | tr '\\0' '\\n'", "ps eww -p 1321263", "printenv | grep TAIGA",
  ]) assert.ok(denied("Bash", cmd), `must be denied: ${cmd}`);
  for (const p of ["/home/dev/.config/taiga-mcp/env", "/proc/1321263/environ"]) assert.ok(denied("Read", `/${p.replace(/^\//, "")}`) || rules.some((r) => r.startsWith("Read(") && re(r.slice(5, -1).replace(/^\/\//, "/")).test(p)), `Read must be denied: ${p}`);
  assert.ok(rules.some((r) => r.startsWith("Edit(")), "the credential file cannot be edited either");
  for (const ok of ["node /scope/taiga-mcp/scripts/taiga-rest.ts get /task-statuses?project=47", "node /scope/taiga-mcp/scripts/taiga-rest.ts patch /tasks/5 '{\"version\":1,\"taskboard_order\":3}'", "git status"]) assert.ok(!denied("Bash", ok), `must stay allowed: ${ok}`);
});
