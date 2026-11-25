import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { verifyRelease } from "../../scripts/release.ts";
import { greenTag } from "../../scripts/git-ci/publish-github.ts";
import { scanText } from "../../scripts/public-surface.ts";

const manifestFor = (bytes: string, sha = createHash("sha256").update(bytes).digest("hex")) => ({
  buildId: "v2026.11.000001",
  repositoryCommit: "a".repeat(40),
  artifact: { name: "taiga-mcp-v2026.11.000001.tgz", sha256: sha },
});

function releaseDir(bytes: string, manifest: object) {
  const dir = mkdtempSync(path.join(tmpdir(), "taiga-release-"));
  writeFileSync(path.join(dir, "taiga-mcp-v2026.11.000001.tgz"), bytes);
  writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest));
  return dir;
}

test("release: a manifest that matches its artifact verifies", () => {
  assert.deepEqual(verifyRelease(releaseDir("payload", manifestFor("payload"))), []);
});

test("release: a tampered artifact and a missing manifest are refused", () => {
  assert.deepEqual(verifyRelease(releaseDir("tampered", manifestFor("payload"))), ["the artifact does not match its sha256"]);
  assert.deepEqual(verifyRelease(mkdtempSync(path.join(tmpdir(), "taiga-release-"))), ["manifest.json is missing"]);
});

test("publish: the green tag grammar is vYYYY.MM.NNNNNN from the pipeline creation time and iid", () => {
  assert.equal(greenTag("2026-11-24T18:00:00Z", "13"), "v2026.11.000013");
});

test("public surface: private addresses, secrets and key blocks are flagged; placeholders are not", () => {
  const categories = (text: string) => scanText(text).map((h) => h.category);
  assert.deepEqual(categories("TAIGA_URL=http://192." + "168.1.5:9000"), ["private-network-address"]);
  assert.deepEqual(categories("TAIGA_PASSWORD=" + "hunter2hunter2"), ["secret-assignment"]);
  assert.deepEqual(categories("-----BEGIN PRIVATE" + " KEY-----"), ["private-key-block"]);
  assert.deepEqual(categories("TAIGA_URL=https://taiga.example.com\nTAIGA_PASSWORD=<your-password>"), []);
});

// F0 audit #3: real git repositories, no mocks. The "GitLab" and "GitHub" remotes are local bare repos.
test("publish: an older pipeline can never overwrite a newer publication", async () => {
  const { publish } = await import("../../scripts/git-ci/publish-github.ts");
  const { execFileSync } = await import("node:child_process");
  const { writeFileSync, mkdirSync } = await import("node:fs");
  const root = mkdtempSync(path.join(tmpdir(), "taiga-publish-"));
  const run = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();
  const [gitlab, github, work, priv] = ["gitlab.git", "github.git", "work", "private"].map((n) => path.join(root, n));
  run(root, "init", "-q", "--bare", gitlab); run(root, "init", "-q", "--bare", github); run(root, "init", "-q", "-b", "main", work);
  run(work, "remote", "add", "origin", gitlab);
  const commit = (n: string) => { writeFileSync(path.join(work, "f"), n); run(work, "add", "."); run(work, "commit", "-q", "-m", n); return run(work, "rev-parse", "HEAD"); };
  const [older, newer] = [commit("one"), commit("two")];
  run(work, "tag", "v2026.11.000001", older); run(work, "tag", "v2026.11.000002", newer); run(work, "push", "-q", "origin", "main", "--tags");
  mkdirSync(path.join(priv, "credentials", "github"), { recursive: true }); mkdirSync(path.join(priv, "config"), { recursive: true });
  writeFileSync(path.join(priv, "credentials", "github", "taiga-mcp"), "unused");
  writeFileSync(path.join(priv, "config", "github.env"), `TAIGA_GITHUB_OWNER=x\nTAIGA_GITHUB_REPOSITORY=${github}\n`);
  const git = (args: string[], env?: NodeJS.ProcessEnv) => execFileSync("git", args, { cwd: work, encoding: "utf8", env: { ...process.env, ...env } }).trim();
  const env = (sha: string, iid: string) => ({ CI_COMMIT_SHA: sha, CI_PIPELINE_IID: iid, CI_PIPELINE_CREATED_AT: "2026-11-25T00:00:00Z", TAIGA_PRIVATE_PATH: priv });
  assert.deepEqual(publish(env(newer, "2"), git), { tag: "v2026.11.000002" });
  assert.throws(() => publish(env(older, "1"), git), /git push/);
  assert.equal(run(github, "rev-parse", "refs/heads/main"), newer);
});
