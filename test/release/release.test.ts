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
