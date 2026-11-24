import { test } from "node:test";
import assert from "node:assert/strict";
import { projectFields } from "../dist/fields.js";

const task = { id: 7, ref: 3, version: 4, subject: "s", description: "d", status: 1, comment: "" };

test("keeps requested fields plus id, ref and version", () => {
  assert.deepEqual(projectFields(task, "subject"), { id: 7, ref: 3, version: 4, subject: "s" });
});

test("projects every item of a list", () => {
  assert.deepEqual(projectFields([task, { ...task, id: 8 }], "status"), [
    { id: 7, ref: 3, version: 4, status: 1 },
    { id: 8, ref: 3, version: 4, status: 1 },
  ]);
});

test("no fields means the value is returned untouched", () => {
  assert.equal(projectFields(task, undefined), task);
  assert.equal(projectFields(task, ""), task);
});

test("accepts spaces in the comma list and ignores unknown names", () => {
  assert.deepEqual(projectFields(task, " subject , nope "), { id: 7, ref: 3, version: 4, subject: "s" });
});

import { applyFields } from "../dist/fields.js";

test("applyFields returns an error result untouched", () => {
  const err = { isError: true, content: [{ type: "text", text: "Taiga API error 400 POST /x: {}" }] };
  assert.equal(applyFields(err, "subject"), err);
});

test("applyFields returns the result untouched when content is missing or not JSON", () => {
  const noContent = { content: [] };
  const notJson = { content: [{ type: "text", text: "not json" }] };
  assert.equal(applyFields(noContent, "subject"), noContent);
  assert.equal(applyFields(notJson, "subject"), notJson);
  assert.equal(applyFields({}, "subject").constructor, Object);
});

test("applyFields projects a valid JSON result and keeps other result keys", () => {
  const res = { content: [{ type: "text", text: JSON.stringify({ id: 1, ref: 2, version: 3, subject: "s", description: "d" }) }] };
  const out = applyFields(res, "subject");
  assert.deepEqual(JSON.parse(out.content[0].text), { id: 1, ref: 2, version: 3, subject: "s" });
});

test("applyFields without fields returns the result as is", () => {
  const res = { content: [{ type: "text", text: "{}" }] };
  assert.equal(applyFields(res, undefined), res);
});
