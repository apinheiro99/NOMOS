// The one release builder: packs the compiled server into a tarball and writes a manifest that binds it to a build id and a commit.
//   node scripts/release.ts build --build-id <vYYYY.MM.NNNNNN> [--repository-commit <sha>] --out <dir>
//   node scripts/release.ts verify --out <dir>
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const REPO = path.resolve(import.meta.dirname, "..");
const MANIFEST = "manifest.json";
const BUILD_ID = /^v\d{4}\.\d{2}\.\d{6}$/;
const COMMIT = /^[0-9a-f]{40}$/;

const sha256 = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");

/** Writes `<out>/taiga-mcp-<buildId>.tgz` and `<out>/manifest.json`. Requires `dist/` to be built already. */
export function build({ buildId, repositoryCommit, out }: { buildId: string; repositoryCommit: string; out: string }) {
  if (!BUILD_ID.test(buildId)) throw new Error(`release: build id ${buildId} is not vYYYY.MM.NNNNNN`);
  if (!COMMIT.test(repositoryCommit)) throw new Error("release: --repository-commit must be a full 40-hex sha");
  if (existsSync(out) && readdirSync(out).length > 0) throw new Error(`release: --out ${out} must be absent or empty`);
  mkdirSync(out, { recursive: true });
  const [pack] = JSON.parse(execFileSync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", out], { cwd: REPO, encoding: "utf8" }));
  const name = `taiga-mcp-${buildId}.tgz`;
  renameSync(path.join(out, pack.filename), path.join(out, name));
  const manifest = { buildId, repositoryCommit, artifact: { name, sha256: sha256(path.join(out, name)) } };
  writeFileSync(path.join(out, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
}

/** Returns what is wrong with a release directory (empty list = every artifact matches its manifest). */
export function verifyRelease(out: string): string[] {
  const file = path.join(out, MANIFEST);
  if (!existsSync(file)) return [`${MANIFEST} is missing`];
  const m = JSON.parse(readFileSync(file, "utf8"));
  const problems: string[] = [];
  if (!BUILD_ID.test(String(m.buildId))) problems.push("buildId is malformed");
  if (!COMMIT.test(String(m.repositoryCommit))) problems.push("repositoryCommit is malformed");
  const artifact = path.join(out, String(m.artifact?.name ?? ""));
  if (!m.artifact?.name || !existsSync(artifact)) problems.push("the artifact named by the manifest is missing");
  else if (sha256(artifact) !== m.artifact.sha256) problems.push("the artifact does not match its sha256");
  return problems;
}

function option(args: string[], name: string) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

if (import.meta.main) {
  const [command, ...args] = process.argv.slice(2);
  try {
    const outArg = option(args, "--out");
    if (outArg === undefined) throw new Error("release: --out <dir> is required");
    const out = path.resolve(outArg);
    if (command === "build") {
      const buildId = option(args, "--build-id") ?? "";
      const repositoryCommit = option(args, "--repository-commit") ?? execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO, encoding: "utf8" }).trim();
      build({ buildId, repositoryCommit, out });
      console.log(`release: ${buildId} written to ${out}`);
    } else if (command === "verify") {
      const problems = verifyRelease(out);
      if (problems.length > 0) throw new Error(`release: verification failed:\n  ${problems.join("\n  ")}`);
      console.log("release: verified, the artifact matches the manifest");
    } else {
      throw new Error("usage: node scripts/release.ts build --build-id <id> [--repository-commit <sha>] --out <dir> | verify --out <dir>");
    }
  } catch (error) {
    console.error((error as Error).message);
    process.exit(2);
  }
}
