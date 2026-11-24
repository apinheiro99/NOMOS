// Turns a TAP test log into a short CI evidence summary: validation-summary.json + validation-summary.md next to the log, and the markdown on stdout.
// Usage: node scripts/validation-summary.ts <tap-log> [out-dir]
// CI evidence only (asynchronous, never workflow authority): it reads the log the suite already wrote and never touches the suite itself.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

const [logPath, outDir = dirname(logPath ?? ".")] = process.argv.slice(2);
if (!logPath) { console.error("usage: validation-summary.ts <tap-log> [out-dir]"); process.exit(2); }

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
const text = existsSync(logPath) ? readFileSync(logPath, "utf8").replace(ANSI, "") : "";
const totals = { tests: 0, pass: 0, fail: 0, cancelled: 0, skipped: 0, todo: 0 };
let groups = 0;
for (const m of text.matchAll(/^# (tests|pass|fail|cancelled|skipped|todo) (\d+)\s*$/gm)) {
  totals[m[1]] += Number(m[2]);
  if (m[1] === "tests") groups++;
}
// One entry per "not ok" with what the TAP YAML block says about it (error text, failure type, location, expected/actual).
const lines = text.split("\n");
const failing = [];
for (let i = 0; i < lines.length; i++) {
  const m = lines[i].match(/^(\s*)not ok \d+ - (.+)$/);
  if (!m) continue;
  const entry = { name: m[2].trim() };
  const indent = m[1].length;
  for (let j = i + 1; j < lines.length && j < i + 80; j++) {
    const l = lines[j];
    if (/^\s*\.\.\.\s*$/.test(l)) break;
    if (/^\s*(not )?ok \d+ - /.test(l) && l.match(/^(\s*)/)[1].length <= indent) break;
    const kv = l.match(/^\s+(error|failureType|location|code|expected|actual|operator):\s*(.*)$/);
    if (!kv) continue;
    let v = kv[2].trim();
    if (v === "|-" || v === "|" || v === ">-") {
      // block scalar: following lines that are indented deeper than the key
      const keyIndent = l.match(/^(\s*)/)[1].length;
      const body = [];
      for (let k = j + 1; k < lines.length && (/^\s*$/.test(lines[k]) || lines[k].match(/^(\s*)/)[1].length > keyIndent); k++) if (lines[k].trim()) body.push(lines[k].trim());
      v = body.join(" | ");
    }
    entry[kv[1]] = v.replace(/^'(.*)'$/s, "$1").slice(0, 500);
  }
  failing.push(entry);
}
const env = process.env;
const summary = {
  sha: env.CI_COMMIT_SHA ?? null,
  ref: env.CI_COMMIT_REF_NAME ?? null,
  pipeline: env.CI_PIPELINE_ID ?? null,
  job: env.CI_JOB_ID ?? null,
  job_status: env.CI_JOB_STATUS ?? null,
  log_found: existsSync(logPath),
  test_runs: groups,
  totals,
  failing_tests: failing,
  note: "CI evidence only, never workflow authority.",
};

const md = [
  "# CI validation summary",
  "",
  `- SHA: \`${summary.sha ?? "unknown"}\` (${summary.ref ?? "unknown"}), pipeline ${summary.pipeline ?? "?"}, job status: ${summary.job_status ?? "?"}`,
  `- Test runs counted: ${groups}${summary.log_found ? "" : " (LOG NOT FOUND: the suite did not run or wrote no log)"}`,
  `- Tests: ${totals.tests} | pass: ${totals.pass} | fail: ${totals.fail} | skipped: ${totals.skipped} | cancelled: ${totals.cancelled} | todo: ${totals.todo}`,
  "",
  summary.failing_tests.length
    ? ["## Failing tests", ...summary.failing_tests.slice(0, 80).map((t) => [`- **${t.name}**`, t.failureType && `  - failure: ${t.failureType}`, t.error && `  - error: ${t.error}`, t.expected && `  - expected: ${t.expected}`, t.actual && `  - actual: ${t.actual}`, t.location && `  - at: ${t.location}`].filter(Boolean).join("\n"))].join("\n")
    : "## Failing tests\n\nNone found in the log.",
  "",
  `_${summary.note}_`,
  "",
].join("\n");

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "validation-summary.json"), JSON.stringify(summary, null, 2) + "\n");
writeFileSync(join(outDir, "validation-summary.md"), md);
console.log(md);
