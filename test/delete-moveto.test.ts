import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { TaigaClient } from "../dist/client.js";
import { registerStatusTools } from "../dist/tools/statuses.js";

// Issue #69 / Story #126: Taiga refuses to delete a severity, priority, issue type or issue status
// that is in use unless the replacement is passed as the moveTo query parameter. Mock data only.
const FAMILIES = [
  ["severities", "severities"],
  ["priorities", "priorities"],
  ["issue_types", "issue-types"],
  ["issue_statuses", "issue-statuses"],
];

const realFetch = globalThis.fetch;
const env = { TAIGA_URL: "http://taiga.invalid", TAIGA_USERNAME: "u", TAIGA_PASSWORD: "p" };
const saved = {};
let requests;

beforeEach(() => {
  for (const k of Object.keys(env)) { saved[k] = process.env[k]; process.env[k] = env[k]; }
  requests = [];
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).endsWith("/auth")) return new Response(JSON.stringify({ auth_token: "t", refresh: "r" }), { status: 200 });
    requests.push([init.method ?? "GET", String(url)]);
    return new Response(null, { status: 204 });
  };
});
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const k of Object.keys(env)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

function setup() {
  const reg = {};
  const server = { tool: (name, _d, schema, handler) => { reg[name] = { schema, handler }; } };
  registerStatusTools(server, new TaigaClient());
  return reg;
}

for (const [name, endpoint] of FAMILIES) {
  const tool = `taiga_${name}_delete`;

  test(`RED #69: ${tool} exposes an optional moveTo`, () => {
    const t = setup()[tool];
    assert.ok(t.schema.moveTo, "moveTo missing from schema");
    assert.equal(t.schema.moveTo.isOptional(), true);
  });

  test(`RED #69: ${tool} with moveTo sends it as the moveTo query parameter`, async () => {
    await setup()[tool].handler({ id: 9, moveTo: 5 }, {});
    assert.deepEqual(requests.map((r) => r[0]), ["DELETE"]);
    const url = new URL(requests[0][1]);
    assert.equal(url.pathname.endsWith(`/${endpoint}/9`), true, url.pathname);
    assert.equal(url.searchParams.get("moveTo"), "5");
  });

  test(`guard: ${tool} without moveTo still sends a bare DELETE`, async () => {
    await setup()[tool].handler({ id: 9 }, {});
    const url = new URL(requests[0][1]);
    assert.equal(requests[0][0], "DELETE");
    assert.equal(url.pathname.endsWith(`/${endpoint}/9`), true);
    assert.equal(url.search, "");
  });
}
