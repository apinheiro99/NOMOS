// Package-content proof: `npm pack --dry-run` may list only the compiled server, the workflow templates and npm's own metadata,
// and every file the manifest names as an entry point (main, bin) must be in that pack list.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import process from "node:process";

const manifest = JSON.parse(readFileSync("package.json", "utf8"));
const [pack] = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { encoding: "utf8" }));
const files: string[] = pack.files.map((f: { path: string }) => f.path);

const allowed = (p: string) => p.startsWith("dist/") || p.startsWith("workflow/templates/") || ["package.json", "README.md", "LICENSE"].includes(p);
const entryPoints = [manifest.main, ...Object.values(manifest.bin ?? {})].map((p) => String(p).replace(/^\.\//, ""));

let failed = false;
for (const file of files.filter((f) => !allowed(f))) {
  console.error(`package-contents: unexpected file ${file}`);
  failed = true;
}
for (const entry of entryPoints.filter((e) => !files.includes(e))) {
  console.error(`package-contents: ${entry} is named by package.json but is not in the packed files`);
  failed = true;
}
if (failed) process.exit(1);
console.log(`package-contents: ${files.length} files, only intended artifacts, every entry point packed`);
