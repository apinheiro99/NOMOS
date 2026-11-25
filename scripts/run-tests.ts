// Runs one named group of the test suite. Groups are by area; "core" is everything the other groups do not claim,
// so a new test file is always run by exactly one CI job.
//   node scripts/run-tests.ts <workflow|tools|core>
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import process from "node:process";

const GROUPS: Record<string, RegExp> = {
  // the governed workflow: policy, actors, governance, merge authorization, closed REST path
  workflow: /^(workflow|governance|governance-cli|assignment|initial-assignment|account-binding|identity|merge-auth|start-rules|write-boundary|engineering-review|project-profile|project-module-flags|milestone-close-notification|git-ci|rest-closure|auth-keygen|policy-oracle|policy-parity)\.test\.ts$/,
  // the Taiga API tools: ordering, moves, links, promotion, comments
  tools: /^(.*-order|move-by-intent|delete-moveto|epic-link|epic-update-stale-version|issue-move-to-backlog|issue-promote|userstory-move-to-backlog|userstory-tasks|task-create-milestone|task-update-milestone|comment)\.test\.ts$/,
};

const group = process.argv[2] ?? "";
if (group !== "core" && !(group in GROUPS)) {
  console.error("usage: run-tests.ts <workflow|tools|core>");
  process.exit(2);
}
const claimed = (file: string) => Object.values(GROUPS).some((re) => re.test(file));
const files = readdirSync("test")
  .filter((f) => f.endsWith(".test.ts"))
  .filter((f) => (group === "core" ? !claimed(f) : GROUPS[group]!.test(f)))
  .map((f) => `test/${f}`);

console.log(`tests (${group}): ${files.length} files`);
const result = spawnSync("node", ["--test", "--test-timeout=120000", ...files], { stdio: "inherit" });
process.exit(result.status ?? 1);
