import { test } from "node:test";
import assert from "node:assert/strict";
import { registerIssueTools } from "../dist/tools/issues.js";

// Issue #22 / Story #154: no native Issue -> User Story promotion tool. Mock data only.
function setup() {
  const reg = {};
  const server = { tool: (name, _d, schema, handler) => { reg[name] = { schema, handler }; } };
  const posts = [];
  const story = { id: 900, ref: 55, project: 48, generated_from_issue: 7, origin_issue: { id: 7, ref: 22 } };
  const gets = [];
  const stored = {};
  // Verified live on project 48: promote answers 200 with the generated story REFS, e.g. [197].
  const client = {
    post: async (path, body) => { posts.push([path, body]); return [55]; },
    // identity traffic (UUID attribute of the generated story) is answered but not recorded: it is covered in identity.test.ts
    get: async (path, params) => {
      if (path === "/userstory-custom-attributes") return [{ id: 1, name: "UUID" }];
      if (path === "/userstories/custom-attributes-values/900") return { version: 1, attributes_values: { ...stored } };
      gets.push([path, params]); return story;
    },
    patch: async (_p, b) => { Object.assign(stored, b.attributes_values); return {}; },
  };
  registerIssueTools(server, client);
  return { reg, posts, gets, story };
}

test("#22: taiga_issues_promote_to_userstory is registered", () => {
  const { reg } = setup();
  assert.ok(reg["taiga_issues_promote_to_userstory"], "tool missing");
});

test("#22: promote posts to the verified endpoint and returns the generated Story (resolved from the returned ref) with its origin link", async () => {
  const { reg, posts, gets, story } = setup();
  const tool = reg["taiga_issues_promote_to_userstory"];
  assert.ok(tool, "tool missing");
  const res = await tool.handler({ id: 7, project_id: 48 }, {});
  assert.deepEqual(posts, [["/issues/7/promote_to_user_story", { project_id: 48 }]]);
  assert.deepEqual(gets, [["/userstories/by_ref", { ref: 55, project: 48 }]]);
  const out = JSON.parse(res.content[0].text);
  assert.equal(out.identity, "complete"); assert.match(out.uuid, /^[0-9a-f-]{36}$/);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- rest-omit
  const { uuid, identity, ...rest } = out;
  assert.deepEqual(rest, story);
});

test("#22: the schema requires the Issue id and the target project", () => {
  const tool = setup().reg["taiga_issues_promote_to_userstory"];
  assert.ok(tool, "tool missing");
  assert.deepEqual(Object.keys(tool.schema).sort(), ["id", "project_id"]);
});
