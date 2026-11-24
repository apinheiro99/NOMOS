// scripts/git-ci/cli.ts — the only entry point of the publish + CI-feedback mechanism. Hooks, npm scripts and GitLab CI call this.
//   node cli.ts post-merge [squash]    after ANY merge: warn (local tags, no fetch) if the integration branch is red (never blocks); on the
//                                      integration branch also publishes it (always; there is no switch to turn this off)
//   node cli.ts pre-merge-commit       before a merge commit: blocks a merge INTO the integration branch while a red is known
//   node cli.ts publish                push the integration branch iff strictly ahead of the remote (node scripts/git-ci/cli.ts publish)
//   node cli.ts tag --result pass|fail --sha <sha> --pipeline-iid <iid> --pipeline-created-at <iso> [--sandbox]   CI only: record the result as
//                                      vYYYY.MM.NNNNNN[-fail] on <sha> (--sandbox: test namespace, deleted right after)
//   node cli.ts selftest --sha <sha> [--pipeline-iid <iid>]   CI only: prove the tag path (create + delete its own ci-selftest/* tag)
//   node cli.ts status [--check]       print the known CI state of the integration branch (--check: exit 1 when red)
//   node cli.ts install                point core.hooksPath at .githooks and make the hooks executable
import { chmodSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { DEFAULTS, sandboxTag, selfTest, afterMerge, beforeMerge, branchRef, loadConfig, makeGit, publish, redState, tagResult, toplevel, redMessage, redact } from './lib.ts';

const say = (lines: string[]) => { for (const l of lines) console.error(l); };
const arg = (argv: string[], name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };

export function main(argv: string[], cwd = process.cwd(), env: NodeJS.ProcessEnv = process.env): number {
  const [cmd, ...rest] = argv;
  const root = toplevel(cwd);
  const cfg = loadConfig(root);
  const git = makeGit(root, env);
  // Re-entrancy guard: every git we spawn carries SCOPE_GIT_CI_ACTIVE, so a hook can never start this mechanism again.
  const nested = env.SCOPE_GIT_CI_ACTIVE === '1';
  switch (cmd) {
    case 'post-merge': {
      if (nested) return 0;
      const o = afterMerge(git, cfg); say(o.lines);
      const squash = rest[0] === '1';
      const onBranch = git(['symbolic-ref', '--quiet', '--short', 'HEAD']).out === cfg.branch;
      if (onBranch && !squash) {
        const p = publish(git, cfg); say(p.lines);
        if (p.code !== 0) console.error(`git-ci: o merge está feito localmente, mas a publicação NÃO ocorreu. Resolva e rode: node scripts/git-ci/cli.ts publish`);
      }
      return 0;   // post-merge can never undo the merge; failures are reported above, loudly, not swallowed
    }
    case 'pre-merge-commit': {
      if (nested) return 0;
      const o = beforeMerge(git, cfg, env); say(o.lines); return o.code;
    }
    case 'publish': {
      const p = publish(git, cfg); say(p.lines); return p.code;
    }
    case 'tag': {
      const result = arg(rest, '--result'); const sha = arg(rest, '--sha');
      const pipelineIid = arg(rest, '--pipeline-iid'); const pipelineCreatedAt = arg(rest, '--pipeline-created-at');
      if ((result !== 'pass' && result !== 'fail') || !sha || !pipelineIid || !pipelineCreatedAt) { console.error('usage: tag --result pass|fail --sha <40-hex> --pipeline-iid <iid> --pipeline-created-at <iso>'); return 2; }
      const o = { result: result as 'pass' | 'fail', sha, remote: env.GIT_CI_PUSH_URL || cfg.remote, pipelineIid, pipelineCreatedAt };
      const t = rest.includes('--sandbox') ? sandboxTag(git, o) : tagResult(git, o);
      say(t.lines.map(redact)); return t.code;
    }
    case 'selftest': {
      const sha = arg(rest, '--sha');
      if (!sha) { console.error('usage: selftest --sha <40-hex> [--pipeline-iid <iid>]'); return 2; }
      const t = selfTest(git, { sha, remote: env.GIT_CI_PUSH_URL || cfg.remote, pipeline: arg(rest, '--pipeline-iid') });
      say(t.lines.map(redact)); return t.code;
    }
    case 'status': {
      const ref = branchRef(git, cfg);
      if (!ref) { console.log(`${cfg.branch}: no such branch here; CI state unknown`); return 0; }
      const s = redState(git, cfg, ref);
      console.log(JSON.stringify({ branch: cfg.branch, sha: s.sha, red: s.red, latest_ci_tag: s.latest?.name ?? null, pipeline_iid: s.latest?.pipelineIid ?? null, pipeline_date: s.latest ? `${s.latest.year}-${String(s.latest.month).padStart(2, '0')}` : null }, null, 2));
      if (s.red) console.error(redMessage(cfg, s));
      return s.red && rest.includes('--check') ? 1 : 0;
    }
    case 'install': {
      const dir = join(root, '.githooks');
      if (!existsSync(dir)) { console.error('no .githooks directory'); return 1; }
      for (const f of readdirSync(dir)) chmodSync(join(dir, f), 0o755);
      const r = git(['config', 'core.hooksPath', '.githooks']);
      console.log(r.code === 0 ? 'core.hooksPath = .githooks' : r.err); return r.code;
    }
    default: console.error('usage: cli.ts post-merge|pre-merge-commit|publish|tag|status|install'); return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  try { process.exitCode = main(argv); } catch (e) {
    console.error(`git-ci: ERRO: ${redact((e as Error).message)}`);
    // A broken tool must not block unrelated merges: only a merge INTO the default integration branch fails closed.
    const onBranch = spawnSync('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
    process.exitCode = argv[0] === 'pre-merge-commit' ? (onBranch === DEFAULTS.branch ? 1 : 0) : argv[0] === 'post-merge' ? 0 : 1;
  }
}
