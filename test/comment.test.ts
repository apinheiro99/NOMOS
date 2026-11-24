import { test } from "node:test";
import assert from "node:assert/strict";
import { postComment, signComment } from "../dist/comment.js";

function fakeClient(version) {
  const calls = [];
  return {
    calls,
    get: async (path) => { calls.push(["get", path]); return { id: 5, version }; },
    patch: async (path, body) => { calls.push(["patch", path, body]); return { id: 5, version: version + 1 }; },
  };
}

test("sends the current entity version, not a hardcoded one", async () => {
  const c = fakeClient(9);
  await postComment(c, "userstory", 5, "hello", "Andre");
  assert.deepEqual(c.calls, [
    ["get", "/userstories/5"],
    ["patch", "/userstories/5", { comment: "hello\n\n-- Andre", version: 9 }],
  ]);
});

test("maps every entity type to its endpoint", async () => {
  for (const [type, path] of [["task", "/tasks/5"], ["issue", "/issues/5"], ["wiki", "/wiki/5"]]) {
    const c = fakeClient(2);
    await postComment(c, type, 5, "x", "Andre");
    assert.equal(c.calls[1][1], path);
  }
});

test("signComment appends the author as the last line, once", () => {
  assert.equal(signComment("text\n", "GPT (GPT-6)"), "text\n\n-- GPT (GPT-6)");
  assert.equal(signComment("text\n\n-- Kimi", "Kimi"), "text\n\n-- Kimi");
});

test("signComment refuses a missing, multi-line or oversized author", () => {
  for (const a of ["", "  ", "a\nb", "x".repeat(61)]) assert.throws(() => signComment("t", a), /author is required/);
});
