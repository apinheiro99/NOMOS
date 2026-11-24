import { test } from "node:test";
import assert from "node:assert/strict";
import { safeDiagnostics, safeApiError, fatalMessage } from "../dist/errors.js";

const SECRET = "dummy-secret-token-abc123XYZ";

test("keeps the stable error code and field names, never values", () => {
  const d = safeDiagnostics(JSON.stringify({ _error_type: "taiga.exceptions.BadRequest", _error_message: SECRET, subject: [SECRET], version: [SECRET] }));
  assert.equal(d, "code=taiga.exceptions.BadRequest; fields=subject,version");
  assert.ok(!d.includes(SECRET));
});

test("non-JSON, array and empty bodies yield no diagnostics", () => {
  for (const body of [`<html>${SECRET}</html>`, `[{"a":"${SECRET}"}]`, "", "null", "42", `"${SECRET}"`]) {
    assert.equal(safeDiagnostics(body), "", body);
  }
});

test("unsafe keys and codes are dropped, field names are capped", () => {
  const long = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`f${i}`, 1]));
  const d = safeDiagnostics(JSON.stringify({ _error_type: `bad code ${SECRET} !`, [`key with spaces ${SECRET}`]: 1, ...long }));
  assert.ok(!d.includes(SECRET) && !d.includes("code="));
  assert.equal(d.split("=")[1].split(",").length, 10);
});

test("safeApiError carries the context and diagnostics only", () => {
  const e = safeApiError("Taiga API error 400 PATCH /tasks/1", JSON.stringify({ subject: [SECRET] }));
  assert.equal(e.message, "Taiga API error 400 PATCH /tasks/1 [fields=subject]");
  assert.equal(safeApiError("Taiga API error 500 GET /x", "<html>boom</html>").message, "Taiga API error 500 GET /x");
});

test("fatalMessage prints only the message, never the object or stack", () => {
  const err = new Error("Taiga API error 500 GET /x");
  err.stack = `stack with ${SECRET}`;
  err.cause = { body: SECRET };
  assert.equal(fatalMessage(err), "Taiga API error 500 GET /x");
  assert.equal(fatalMessage({ token: SECRET }), "unknown error");
  assert.equal(fatalMessage(SECRET), "unknown error");
});
