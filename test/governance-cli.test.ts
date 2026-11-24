import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const cli = new URL("../dist/governance-cli.js", import.meta.url).pathname;
const run = (file, ...args) => spawnSync(process.execPath, [cli, ...args], { env: { ...process.env, TAIGA_MCP_GOVERNANCE_FILE: file }, encoding: "utf8" });

test("CLI is one global switch: off/on/status write and report a single boolean", () => {
  const dir = mkdtempSync(join(tmpdir(), "govcli-"));
  const file = join(dir, "g", "governance.json");
  try {
    assert.deepEqual(JSON.parse(run(file, "status").stdout), { enabled: true }, "missing file = ON");
    assert.equal(run(file, "off").status, 0);
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { enabled: false });
    assert.deepEqual(JSON.parse(run(file, "status").stdout), { enabled: false });
    assert.equal(run(file, "on").status, 0);
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { enabled: true });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("CLI takes no --project and rejects other input; a corrupt file is left untouched", () => {
  const dir = mkdtempSync(join(tmpdir(), "govcli-"));
  const file = join(dir, "governance.json");
  try {
    assert.equal(run(file, "on", "--project", "49").status, 2);
    assert.equal(run(file, "toggle").status, 2);
    writeFileSync(file, "{not json");
    assert.equal(run(file, "off").status, 1);
    assert.equal(readFileSync(file, "utf8"), "{not json");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
