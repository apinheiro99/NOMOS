import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { DEFAULTS, makeGit, tagResult, sandboxTag, redState, publish, fetchTags, beforeMerge, newestTag } from "../scripts/git-ci/lib.ts";

// Hermetic: a bare "origin" and a working clone in a temp dir. Result tags: green vYYYY.MM.NNNNNN, red vYYYY.MM.NNNNNN-fail.
const run = (cwd, ...a) => { const r = spawnSync("git", a, { cwd, encoding: "utf8" }); assert.equal(r.status, 0, `git ${a.join(" ")}: ${r.stderr}`); return r.stdout.trim(); };

function world() {
  const base = mkdtempSync(join(tmpdir(), "gitci-"));
  const origin = join(base, "origin.git"), dev = join(base, "dev");
  run(base, "init", "--bare", "-q", "-b", "main", origin);
  run(base, "clone", "-q", origin, dev);
  run(dev, "config", "user.email", "t@t"); run(dev, "config", "user.name", "t");
  run(dev, "checkout", "-q", "-b", "main");
  const commit = (n) => { writeFileSync(join(dev, `${n}.txt`), n); run(dev, "add", "."); run(dev, "commit", "-q", "-m", n); return run(dev, "rev-parse", "HEAD"); };
  const first = commit("a");
  run(dev, "push", "-q", "-u", "origin", "main");
  const git = makeGit(dev, process.env);
  const tag = (result, sha, iid, at = "2026-11-03T10:00:00Z") => tagResult(git, { result, sha, remote: "origin", pipelineIid: String(iid), pipelineCreatedAt: at });
  const remoteTags = () => run(origin, "tag", "--list").split("\n").filter(Boolean).sort();
  return { base, dev, origin, commit, first, git, cfg: DEFAULTS, tag, remoteTags };
}
const withWorld = (fn) => () => { const w = world(); try { fn(w); } finally { rmSync(w.base, { recursive: true, force: true }); } };

test("defaults: main/origin only", () => {
  assert.deepEqual(DEFAULTS, { branch: "main", remote: "origin" });
});

test("PASS creates vYYYY.MM.NNNNNN on the tested SHA and pushes it", withWorld((w) => {
  const r = w.tag("pass", w.first, 297);
  assert.equal(r.code, 0, r.lines.join("\n"));
  assert.deepEqual(w.remoteTags(), ["v2026.11.000297"]);
  assert.equal(run(w.dev, "rev-parse", "v2026.11.000297^{commit}"), w.first);
}));

test("FAIL creates vYYYY.MM.NNNNNN-fail", withWorld((w) => {
  assert.equal(w.tag("fail", w.first, 298).code, 0);
  assert.deepEqual(w.remoteTags(), ["v2026.11.000298-fail"]);
}));

test("month is zero-padded from the pipeline creation date", withWorld((w) => {
  assert.equal(w.tag("pass", w.first, 5, "2027-01-09T00:00:00Z").code, 0);
  assert.deepEqual(w.remoteTags(), ["v2027.01.000005"]);
}));

test("newest tag decides: PASS newest = green, FAIL newest = red", withWorld((w) => {
  w.tag("pass", w.first, 297);
  assert.equal(redState(w.git, w.cfg, "main").red, false);
  w.tag("fail", w.commit("b"), 298);
  const s = redState(w.git, w.cfg, "main");
  assert.equal(s.red, true);
  assert.equal(s.latest.name, "v2026.11.000298-fail");
}));

test("fail then a higher PASS is green; PASS then a higher FAIL is red", withWorld((w) => {
  w.tag("fail", w.first, 297);
  w.tag("pass", w.commit("b"), 298);
  assert.equal(redState(w.git, w.cfg, "main").red, false);
  w.tag("fail", w.commit("c"), 299);
  assert.equal(redState(w.git, w.cfg, "main").red, true);
}));

test("same pipeline with both tags locally (fail not pruned yet): green wins, whatever the order", withWorld((w) => {
  run(w.dev, "tag", "v2026.11.000297-fail", w.first); run(w.dev, "tag", "v2026.11.000297", w.first);
  const s = redState(w.git, w.cfg, "main");
  assert.equal(s.red, false);
  assert.equal(s.latest.name, "v2026.11.000297");
  assert.equal(newestTag([{ year: 2026, month: 11, pipelineIid: 5, failed: false, name: "g" }, { year: 2026, month: 11, pipelineIid: 5, failed: true, name: "f" }]).name, "g");
  assert.equal(newestTag([{ year: 2026, month: 11, pipelineIid: 5, failed: true, name: "f" }, { year: 2026, month: 11, pipelineIid: 5, failed: false, name: "g" }]).name, "g");
}));

test("no tags = unknown = not red", withWorld((w) => {
  const s = redState(w.git, w.cfg, "main");
  assert.equal(s.red, false);
  assert.equal(s.latest, null);
}));

test("old-scheme tags (v2.3.x, ci-fail/*) and sandbox tags are ignored", withWorld((w) => {
  run(w.dev, "tag", "v2.3.9", w.first); run(w.dev, "tag", "ci-fail/aaaaaaaaaaaa", w.first); run(w.dev, "tag", "ci-selftest-v2026.11.000900-fail", w.first);
  assert.equal(redState(w.git, w.cfg, "main").latest, null);
}));

test("retry: a PASS of the same pipeline replaces its -fail tag (local and remote)", withWorld((w) => {
  assert.equal(w.tag("fail", w.first, 297).code, 0);
  const r = w.tag("pass", w.first, 297);
  assert.equal(r.code, 0, r.lines.join("\n"));
  assert.deepEqual(w.remoteTags(), ["v2026.11.000297"]);
  assert.equal(run(w.dev, "tag", "--list", "v2026.11.000297*"), "v2026.11.000297");
  assert.equal(redState(w.git, w.cfg, "main").red, false);
}));

test("symmetric: a FAIL of a pipeline that had a PASS keeps exactly one tag", withWorld((w) => {
  w.tag("pass", w.first, 297);
  assert.equal(w.tag("fail", w.first, 297).code, 0);
  assert.deepEqual(w.remoteTags(), ["v2026.11.000297-fail"]);
}));

test("idempotent: same PASS or FAIL twice creates nothing new and succeeds", withWorld((w) => {
  assert.equal(w.tag("pass", w.first, 297).code, 0);
  const again = w.tag("pass", w.first, 297);
  assert.equal(again.code, 0); assert.equal(again.status, "exists");
  w.tag("fail", w.first, 300);
  assert.equal(w.tag("fail", w.first, 300).status, "exists");
  assert.deepEqual(w.remoteTags(), ["v2026.11.000297", "v2026.11.000300-fail"]);
}));

test("conflict: the same pipeline identity on a different SHA is refused and nothing moves", withWorld((w) => {
  w.tag("pass", w.first, 297);
  const other = w.commit("b");
  const r = w.tag("pass", other, 297);
  assert.equal(r.code, 1);
  assert.match(r.lines.join("\n"), /conflito/);
  assert.equal(w.tag("fail", other, 297).code, 1);
  assert.equal(run(w.origin, "rev-list", "-n1", "v2026.11.000297"), w.first);
  assert.deepEqual(w.remoteTags(), ["v2026.11.000297"]);
}));

test("numeric order: IID 100 is newer than 99", withWorld((w) => {
  w.tag("fail", w.first, 100, "2026-11-03T10:00:00Z");
  w.tag("pass", w.commit("b"), 99, "2026-11-03T09:00:00Z");
  assert.equal(redState(w.git, w.cfg, "main").latest.name, "v2026.11.000100-fail");
}));

test("numeric order: month and year roll over (2026.12.500 < 2027.01.501)", withWorld((w) => {
  w.tag("pass", w.first, 500, "2026-12-31T23:00:00Z");
  w.tag("fail", w.commit("b"), 501, "2027-01-01T01:00:00Z");
  assert.equal(redState(w.git, w.cfg, "main").latest.name, "v2027.01.000501-fail");
  assert.equal(redState(w.git, w.cfg, "main").red, true);
}));

test("a retry keeps its original month: identity comes from the creation date, not from today", withWorld((w) => {
  w.tag("fail", w.first, 297, "2026-10-31T23:59:00Z");
  w.tag("pass", w.first, 297, "2026-10-31T23:59:00Z");
  assert.deepEqual(w.remoteTags(), ["v2026.10.000297"]);
}));

test("invalid pipeline data is refused", withWorld((w) => {
  assert.equal(w.tag("pass", w.first, "0").code, 1);
  assert.equal(w.tag("pass", w.first, 5, "yesterday").code, 1);
  assert.equal(tagResult(w.git, { result: "pass", sha: "abc", remote: "origin", pipelineIid: "5", pipelineCreatedAt: "2026-11-03T00:00:00Z" }).code, 1);
}));

test("sandbox: real path, never read as a result, and deleted afterwards", withWorld((w) => {
  const r = sandboxTag(w.git, { result: "fail", sha: w.first, remote: "origin", pipelineIid: "7", pipelineCreatedAt: "2026-11-03T10:00:00Z" });
  assert.equal(r.code, 0, r.lines.join("\n"));
  assert.deepEqual(w.remoteTags(), []);
  assert.equal(redState(w.git, w.cfg, "main").latest, null);
}));

test("fetchTags drops a local -fail tag that a passing retry removed on the remote", withWorld((w) => {
  const sibling = join(w.base, "sibling");
  run(w.base, "clone", "-q", w.origin, sibling);
  w.tag("fail", w.first, 297);
  run(w.dev, "tag", "local-only", w.first);
  assert.equal(fetchTags(w.git, "origin"), null);
  assert.equal(redState(w.git, w.cfg, "main").red, true);
  // the CI (another clone) turns the pipeline green
  assert.equal(tagResult(makeGit(sibling, process.env), { result: "pass", sha: w.first, remote: "origin", pipelineIid: "297", pipelineCreatedAt: "2026-11-03T10:00:00Z" }).code, 0);
  assert.equal(fetchTags(w.git, "origin"), null);
  assert.equal(run(w.dev, "tag", "--list", "v2026.11.000297*"), "v2026.11.000297");
  assert.equal(run(w.dev, "tag", "--list", "local-only"), "local-only", "pruning must not touch unrelated local tags");
  assert.equal(redState(w.git, w.cfg, "main").red, false);
}));

test("pre-merge hook: blocks on a red newest tag, passes once green", withWorld((w) => {
  w.tag("fail", w.first, 297);
  const blocked = beforeMerge(w.git, w.cfg, {});
  assert.equal(blocked.code, 1);
  assert.match(blocked.lines.join("\n"), /CI RED: main está em v2026\.11\.000297-fail\./);
  assert.equal(beforeMerge(w.git, w.cfg, { SCOPE_CI_FIX_MERGE: "1" }).code, 0);
  w.tag("pass", w.commit("b"), 298);
  assert.equal(beforeMerge(w.git, w.cfg, {}).code, 0);
}));

test("publish is a no-op when equal and pushes when strictly ahead", withWorld((w) => {
  const eq = publish(w.git, w.cfg);
  assert.equal(eq.code, 0, eq.lines.join("\n"));
  const c = w.commit("ahead");
  const p = publish(w.git, w.cfg);
  assert.equal(p.code, 0, p.lines.join("\n"));
  assert.equal(run(w.origin, "rev-parse", "refs/heads/main"), c);
}));

test("redState makes a constant number of git calls whatever the tag count (1500 tags)", withWorld((w) => {
  const lines = [];
  for (let i = 1; i <= 1500; i++) lines.push(`create refs/tags/v2026.${String((i % 12) + 1).padStart(2, "0")}.${i}${i % 7 === 0 ? "-fail" : ""} ${w.first}`);
  const r = spawnSync("git", ["update-ref", "--stdin"], { cwd: w.dev, input: lines.join("\n") + "\n", encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  let calls = 0;
  const counting = (args) => { calls += 1; return w.git(args); };
  const s = redState(counting, w.cfg, "main");
  assert.equal(calls, 2, `${calls} git calls for 1500 tags (expected rev-parse + one for-each-ref)`);
  // newest by (year, month, iid): month 12 holds i%12==11 -> greatest i with that month is 1499 (1499%12==11)
  assert.equal(s.latest.name, "v2026.12.1499");
  assert.equal(s.red, false);
}));

test("post-merge always publishes: the old SCOPE_GIT_CI_NO_PUBLISH switch no longer exists", withWorld((w) => {
  const sha = w.commit("b");
  const cli = join(process.cwd(), "scripts/git-ci/cli.ts");
  const r = spawnSync("node", [cli, "post-merge", "0"], { cwd: w.dev, encoding: "utf8", env: { ...process.env, SCOPE_GIT_CI_NO_PUBLISH: "1" } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(run(w.origin, "rev-parse", "main"), sha);
}));

test("publish refuses a branch that is behind or diverged from the remote (origin/main is refreshed first)", withWorld((w) => {
  const sibling = join(w.base, "sibling");
  run(w.base, "clone", "-q", w.origin, sibling);
  run(sibling, "config", "user.email", "t@t"); run(sibling, "config", "user.name", "t");
  writeFileSync(join(sibling, "s.txt"), "s"); run(sibling, "add", "."); run(sibling, "commit", "-q", "-m", "s"); run(sibling, "push", "-q", "origin", "main");
  const behind = publish(w.git, w.cfg);
  assert.equal(behind.code, 1);
  assert.match(behind.lines.join("\n"), /ATRÁS/);
  w.commit("local");
  const diverged = publish(w.git, w.cfg);
  assert.equal(diverged.code, 1);
  assert.match(diverged.lines.join("\n"), /DIVERGIRAM/);
}));
