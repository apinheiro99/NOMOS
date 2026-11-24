import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeResponse } from "../dist/sanitize.js";

test("removes *_html keys at any depth, keeps the rest", () => {
  const input = { id: 1, description: "a", description_html: "<p>a</p>", tasks: [{ blocked_note: "", blocked_note_html: "", ref: 2 }] };
  assert.deepEqual(sanitizeResponse(input), { id: 1, description: "a", tasks: [{ blocked_note: "", ref: 2 }] });
});

test("passes primitives and null through", () => {
  assert.equal(sanitizeResponse(null), null);
  assert.equal(sanitizeResponse("x_html"), "x_html");
});

test("never exposes us_order at any depth; taskboard_order stays", () => {
  assert.deepEqual(sanitizeResponse([{ id: 1, us_order: 3, taskboard_order: 2, nested: { us_order: 9, ok: true } }]), [{ id: 1, taskboard_order: 2, nested: { ok: true } }]);
});

test("never exposes Story kanban_order or backlog_order; sprint_order stays; keep opts a key back in", () => {
  const row = { id: 1, sprint_order: 2, kanban_order: 3, backlog_order: 4 };
  assert.deepEqual(sanitizeResponse([row]), [{ id: 1, sprint_order: 2 }]);
  assert.deepEqual(sanitizeResponse([row], ["backlog_order"]), [{ id: 1, sprint_order: 2, backlog_order: 4 }]);
});
