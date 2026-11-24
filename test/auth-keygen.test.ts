import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function runKeygen(cwd: string) {
  const r = spawnSync("node", [join(root, "scripts/auth-keygen.ts")], { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.split("\n");
  assert.equal(lines.pop(), "", "output ends with a single newline");
  assert.equal(lines.length, 3);
  const [priv, pub, id] = lines;
  assert.ok(priv.startsWith("Private Key: ") && pub.startsWith("Public Key: ") && id.startsWith("Key ID: "));
  return { priv: priv.slice(13), pub: pub.slice(12), id: id.slice(8) };
}

test("keygen prints three lines, DER keys sign/verify, Key ID is sha256 of public DER, no files", () => {
  const cwd = mkdtempSync(join(tmpdir(), "keygen-"));
  try {
    const a = runKeygen(cwd);
    const b = runKeygen(cwd);
    assert.notEqual(a.priv, b.priv);
    assert.notEqual(a.pub, b.pub);
    assert.match(a.id, /^[0-9a-f]{64}$/);

    const privateKey = createPrivateKey({ key: Buffer.from(a.priv, "base64"), format: "der", type: "pkcs8" });
    const publicKey = createPublicKey({ key: Buffer.from(a.pub, "base64"), format: "der", type: "spki" });
    const msg = Buffer.from("merge-authorization");
    const sig = sign(null, msg, privateKey);
    assert.equal(verify(null, msg, publicKey, sig), true);
    assert.equal(verify(null, Buffer.from("tampered"), publicKey, sig), false);
    assert.equal(createHash("sha256").update(Buffer.from(a.pub, "base64")).digest("hex"), a.id);

    assert.deepEqual(readdirSync(cwd), [], "keygen creates no files");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test(".env.example carries the empty private-key placeholder and .env is ignored", () => {
  const example = readFileSync(join(root, ".env.example"), "utf8").split("\n");
  assert.ok(example.includes("TAIGA_MCP_MERGE_AUTH_PRIVATE_KEY_B64="));
  assert.ok(readFileSync(join(root, ".gitignore"), "utf8").split("\n").includes(".env"));
});
