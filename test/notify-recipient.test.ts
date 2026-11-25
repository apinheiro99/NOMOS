import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { noticeForTransition } from "../dist/workflow/notify.js";
import { announce, pendingContinuations } from "../dist/workflow/continuation.js";

// F3.3: a notice states its recipient. Same actor = no Bridge dispatch, but the continuation (the local obligation) is still recorded.
test("the recipient is the other party by default, and the one the policy names when given", () => {
  assert.equal(noticeForTransition("gpt", "to do", "in progress", 7, "In Progress")?.to, "claude");
  assert.equal(noticeForTransition("claude", "in progress", "gpt validation", 7, "GPT Validation")?.to, "gpt");
  assert.equal(noticeForTransition("gpt", "to do", "in progress", 7, "In Progress", undefined, "task", 49, "gpt")?.to, "gpt");
});

test("GPT acting for itself: no Bridge command runs, the continuation is recorded and TASK_DONE stays pending", async () => {
  const dir = mkdtempSync(join(tmpdir(), "notify-"));
  try {
    const marker = join(dir, "ran");
    const script = join(dir, "notifier.cjs");
    writeFileSync(script, `require("fs").writeFileSync(${JSON.stringify(marker)}, "x")`); // the real notifier receives --type/--task flags, so it must be a script
    process.env.TAIGA_MCP_CONTINUATION_FILE = join(dir, "c.jsonl"); // the continuation store reads the process environment
    const env = { ...process.env, TAIGA_MCP_NOTIFY_COMMAND: JSON.stringify(["node", script]) };
    const notice = noticeForTransition("gpt", "gpt validation", "done", 7, "Done", undefined, "task", 49, "gpt")!;
    const out = await announce(notice, "c1", env);
    assert.equal(out.notification, "skipped");
    assert.equal(existsSync(marker), false, "the notifier was not started");
    assert.deepEqual(pendingContinuations("gpt", 49, env.TAIGA_MCP_CONTINUATION_FILE).map((c) => [c.type, c.to, c.from]), [["TASK_DONE", "gpt", "gpt"]]);
    // The usual case still dispatches, to the other party.
    const usual = await announce(noticeForTransition("gpt", "to do", "in progress", 8, "In Progress", undefined, "task", 49)!, "c2", env);
    assert.equal(usual.notification, "sent");
    assert.equal(readFileSync(marker, "utf8"), "x");
    assert.equal(pendingContinuations("claude", 49, env.TAIGA_MCP_CONTINUATION_FILE).length, 1);
  } finally {
    delete process.env.TAIGA_MCP_CONTINUATION_FILE;
    rmSync(dir, { recursive: true, force: true });
  }
});
