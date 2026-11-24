import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { TaigaClient } from "../dist/client.js";

// Dummy secret-like values only; none of these are real credentials.
const SECRET = "dummy-secret-token-abc123XYZ";
const LEAKY_BODY = JSON.stringify({
  _error_message: "boom",
  debug: { authorization: `Bearer ${SECRET}`, password: SECRET, stack: `at /srv/taiga/${SECRET}.py` },
});

const realFetch = globalThis.fetch;
const env = { TAIGA_URL: "http://taiga.invalid", TAIGA_USERNAME: "u", TAIGA_PASSWORD: "p" };
const saved = {};

beforeEach(() => {
  for (const k of Object.keys(env)) { saved[k] = process.env[k]; process.env[k] = env[k]; }
});
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const k of Object.keys(env)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

// Auth succeeds; every other request answers with `status` and the leaky body.
function stubFetch(status) {
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/auth")) {
      return new Response(JSON.stringify({ auth_token: "t", refresh: "r" }), { status: 200 });
    }
    return new Response(LEAKY_BODY, { status });
  };
}

async function failure(call) {
  try { await call(); } catch (e) { return e; }
  assert.fail("expected the request to throw");
}

for (const status of [400, 403, 404, 500]) {
  test(`upstream ${status} keeps the HTTP status observable in the error`, async () => {
    stubFetch(status);
    const err = await failure(() => new TaigaClient().get("/tasks/1"));
    assert.match(err.message, new RegExp(String(status)));
  });

  test(`upstream ${status} body with secret-like content does not leak into the error message`, async () => {
    stubFetch(status);
    const err = await failure(() => new TaigaClient().get("/tasks/1"));
    assert.ok(!err.message.includes(SECRET), `leaked secret-like value: ${err.message}`);
    assert.ok(!/Bearer|password|authorization/i.test(err.message), `leaked sensitive keys: ${err.message}`);
  });
}

test("write requests do not leak the upstream body either", async () => {
  stubFetch(500);
  const err = await failure(() => new TaigaClient().patch("/tasks/1", { subject: "x" }));
  assert.match(err.message, /500/);
  assert.ok(!err.message.includes(SECRET), `leaked secret-like value: ${err.message}`);
});

test("auth failure body does not leak into the login error", async () => {
  globalThis.fetch = async () => new Response(LEAKY_BODY, { status: 403 });
  const err = await failure(() => new TaigaClient().get("/tasks/1"));
  assert.match(err.message, /403/);
  assert.ok(!err.message.includes(SECRET), `leaked secret-like value: ${err.message}`);
});
