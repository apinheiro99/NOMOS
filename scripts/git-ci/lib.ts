// scripts/git-ci/lib.ts — publish + CI-feedback mechanism, Git and tags only (no daemon, no database, no webhook).
//
//   merge -> versioned hooks -> check -> publish main -> GitLab CI -> result tag
//
// The CI result of a pipeline is ONE tag on the exact SHA that was tested, named after the GitLab pipeline (project-scoped IID):
//   green  -> vYYYY.MM.NNNNNN
//   red    -> vYYYY.MM.NNNNNN-fail
//   cancel -> nothing
// YYYY.MM is the month the pipeline was CREATED (CI_PIPELINE_CREATED_AT), so a retry keeps the identity. A pipeline has exactly one
// tag, its CURRENT state: a retry that passes replaces the -fail tag. The known CI state is the tag with the greatest
// (year, month, IID): "-fail" = red, otherwise green. No tags at all = unknown = not red. No ancestry is ever consulted.
// This module is dependency-free so the whole directory can be copied into another project (see docs/ci-publish-feedback.md).
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface Config {
  /** The integration branch whose CI result gates merges and which gets published. */
  branch: string;
  remote: string;
}
export const DEFAULTS: Config = { branch: 'main', remote: 'origin' };
export const CONFIG_FILE = '.git-ci.json';

export function loadConfig(root: string): Config {
  const f = join(root, CONFIG_FILE);
  const raw: Record<string, unknown> = existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : {};
  const c = { ...DEFAULTS, ...raw } as Config;
  for (const k of ['branch', 'remote'] as const) if (typeof c[k] !== 'string' || !c[k]) throw new Error(`${CONFIG_FILE}: "${k}" must be a non-empty string`);
  return c;
}

// ── git runner (never a shell; credentials in URLs are redacted from anything we print) ───────────────────────────────
export const redact = (s: string) => s.replace(/(\/\/)[^/@\s]+@/g, '$1***@');
export interface Run { code: number; out: string; err: string }
export type Git = (args: string[]) => Run;
export function makeGit(cwd: string, env: NodeJS.ProcessEnv = process.env): Git {
  return (args) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...env, GIT_TERMINAL_PROMPT: '0', SCOPE_GIT_CI_ACTIVE: '1' } });
    return { code: r.status ?? 1, out: (r.stdout ?? '').trim(), err: redact((r.stderr ?? '').trim() || (r.error?.message ?? '')) };
  };
}

export function toplevel(cwd: string): string {
  const r = makeGit(cwd)(['rev-parse', '--show-toplevel']);
  if (r.code !== 0) throw new Error('not inside a Git repository');
  return r.out;
}
const must = (r: Run, what: string) => { if (r.code !== 0) throw new Error(`${what}: ${r.err || `git exited ${r.code}`}`); return r.out; };

// ── tags ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
export interface CiTag { name: string; sha: string; year: number; month: number; pipelineIid: number; failed: boolean }

/** Sandbox tags (selftest) live under this prefix, so the real parser (anchored on `v`) never reads them. */
export const SANDBOX_PREFIX = 'ci-selftest-';

const tagRe = (prefix: string) => new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}v(\\d{4})\\.(\\d{1,2})\\.(\\d+)(-fail)?$`);

/** All CI result tags with the commit they point at (annotated tags are dereferenced): ONE git call. */
export function listCiTags(git: Git, prefix = ''): CiTag[] {
  const out = must(git(['for-each-ref', '--format=%(refname:strip=2)%09%(objectname)%09%(*objectname)', 'refs/tags']), 'cannot list tags');
  const re = tagRe(prefix);
  const tags: CiTag[] = [];
  for (const line of out.split('\n').filter(Boolean)) {
    const [name, obj, deref] = line.split('\t');
    const m = re.exec(name);
    if (m) tags.push({ name, sha: deref || obj, year: Number(m[1]), month: Number(m[2]), pipelineIid: Number(m[3]), failed: m[4] === '-fail' });
  }
  return tags;
}

/** Numeric order of pipelines: year, month, IID (never string order: 99 < 100). */
export const compareTags = (a: CiTag, b: CiTag) => a.year - b.year || a.month - b.month || a.pipelineIid - b.pipelineIid;
export const sameIdentity = (a: CiTag, b: CiTag) => compareTags(a, b) === 0;

/**
 * The newest tag is a plain max over the list; listing order is irrelevant. Same pipeline identity with both a green and a -fail tag
 * (a local clone that has not pruned the -fail yet after a passing retry): the green wins, explicitly.
 */
export const newestTag = (tags: CiTag[]): CiTag | null =>
  tags.reduce<CiTag | null>((m, t) => {
    if (m === null) return t;
    const c = compareTags(t, m);
    return c > 0 || (c === 0 && m.failed && !t.failed) ? t : m;
  }, null);

/** true / false; any other git failure (unknown object, ...) is an error, never "no". */
export function isAncestor(git: Git, a: string, b: string): boolean {
  const r = git(['merge-base', '--is-ancestor', a, b]);
  if (r.code === 0) return true;
  if (r.code === 1) return false;
  throw new Error(`cannot compare ${a.slice(0, 12)} with ${b.slice(0, 12)}: ${r.err}`);
}

export interface RedState { red: boolean; ref: string; sha: string; latest: CiTag | null }

/**
 * Is the known CI state of the project red? The newest result tag (greatest year, month, IID) decides: "-fail" = red.
 * No tags at all = unknown = NOT red (the CI is asynchronous and never blocks by absence of news).
 * Two git calls whatever the number of tags: rev-parse of the ref, and one for-each-ref.
 */
export function redState(git: Git, cfg: Config, ref: string): RedState {
  const sha = must(git(['rev-parse', '--verify', `${ref}^{commit}`]), `unknown ref ${ref}`);
  const latest = newestTag(listCiTags(git));
  return { red: latest?.failed === true, ref, sha, latest };
}

export const redMessage = (cfg: Config, s: RedState) => `CI RED: ${cfg.branch} está em ${s.latest?.name}.`;

/** Best-effort `git fetch --tags`; returns an explicit reason on failure (callers decide whether that blocks). */
export const FAIL_REFSPEC = 'refs/tags/v*-fail:refs/tags/v*-fail';
export function fetchTags(git: Git, remote: string): string | null {
  // The extra refspec + --prune drops local -fail tags that a passing retry removed on the remote (and only those).
  const r = git(['fetch', '--tags', '--prune', '--quiet', remote, FAIL_REFSPEC]);
  return r.code === 0 ? null : `git fetch --tags ${remote} failed: ${r.err || `exit ${r.code}`}`;
}

/** The ref that stands for "the integration branch" for warnings: the local branch, else the remote-tracking one. */
export function branchRef(git: Git, cfg: Config): string | null {
  for (const ref of [`refs/heads/${cfg.branch}`, `refs/remotes/${cfg.remote}/${cfg.branch}`]) if (git(['rev-parse', '--verify', '--quiet', ref]).code === 0) return ref;
  return null;
}

export const currentBranch = (git: Git): string | null => { const r = git(['symbolic-ref', '--quiet', '--short', 'HEAD']); return r.code === 0 ? r.out : null; };

// ── hook behaviours ─────────────────────────────────────────────────────────────────────────────────────────────────────
export interface Outcome { code: number; lines: string[] }

/** post-merge, ANY merge: warn loudly when the integration branch is known red, from the LOCAL tags (a 60 s systemd timer keeps them fresh;
 *  this hook does not fetch). Never blocks. */
export function afterMerge(git: Git, cfg: Config): Outcome {
  const lines: string[] = [];
  const ref = branchRef(git, cfg);
  if (!ref) return { code: 0, lines };
  try {
    const s = redState(git, cfg, ref);
    if (s.red) lines.push('', '!!! ' + redMessage(cfg, s), '');
  } catch (e) { lines.push(`git-ci: AVISO: não foi possível avaliar o CI de ${cfg.branch}: ${(e as Error).message}`); }
  return { code: 0, lines };
}

export const FIX_MERGE_ENV = 'SCOPE_CI_FIX_MERGE';

/** pre-merge-commit: only a merge INTO the integration branch can be blocked, and only by a KNOWN red (the newest result tag is -fail). */
export function beforeMerge(git: Git, cfg: Config, env: NodeJS.ProcessEnv = process.env): Outcome {
  if (currentBranch(git) !== cfg.branch) return { code: 0, lines: [] };
  const lines: string[] = [];
  const f = fetchTags(git, cfg.remote);
  if (f) lines.push(`git-ci: AVISO: ${f}; decidindo com as tags locais.`);
  let s: RedState;
  try { s = redState(git, cfg, 'HEAD'); } catch (e) { return { code: 1, lines: [...lines, `git-ci: ERRO: não foi possível avaliar o CI de ${cfg.branch}: ${(e as Error).message}`, 'Merge abortado (falha fechada).'] }; }
  if (!s.red) return { code: 0, lines };
  if (env[FIX_MERGE_ENV] === '1') return { code: 0, lines: [...lines, `git-ci: ${redMessage(cfg, s)}`, `git-ci: ${FIX_MERGE_ENV}=1: este merge foi declarado como a CORREÇÃO do vermelho; permitido.`] };
  return { code: 1, lines: [...lines, '', 'ERRO: ' + redMessage(cfg, s),
    `O ${cfg.branch} conhecido está VERMELHO e precisa ser corrigido antes de integrar outra Story.`,
    `Se este merge É a correção, repita com ${FIX_MERGE_ENV}=1 git merge ...`, 'Merge abortado.'] };
}

// ── publish ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
export type PublishStatus = 'pushed' | 'up-to-date' | 'refused' | 'error';
export interface PublishResult { status: PublishStatus; code: number; lines: string[] }

/** One in-progress operation (merge, rebase, cherry-pick, revert, bisect) or unmerged path makes the repo "not safe". */
export function unsafeState(git: Git): string | null {
  const dir = git(['rev-parse', '--absolute-git-dir']).out;
  for (const [file, what] of [['MERGE_HEAD', 'a merge'], ['rebase-merge', 'a rebase'], ['rebase-apply', 'a rebase/am'], ['CHERRY_PICK_HEAD', 'a cherry-pick'], ['REVERT_HEAD', 'a revert']] as const) {
    if (!dir || !existsSync(join(dir, file))) continue;
    // post-merge runs while Git still holds MERGE_HEAD of a merge it has ALREADY committed: that one is reachable from HEAD.
    // A merge really in progress (conflicts, --no-commit) has a MERGE_HEAD that HEAD does not contain.
    if (file === 'MERGE_HEAD') {
      const mh = readFileSync(join(dir, file), 'utf8').trim().split('\n')[0];
      if (/^[0-9a-f]{40}$/.test(mh) && git(['merge-base', '--is-ancestor', mh, 'HEAD']).code === 0) continue;
    }
    return `${what} is in progress`;
  }
  if (git(['ls-files', '--unmerged']).out) return 'there are unmerged paths';
  return null;
}

/** Push the integration branch ONLY when local is strictly ahead of the remote. Never resolves anything. */
export function publish(git: Git, cfg: Config): PublishResult {
  const refuse = (m: string): PublishResult => ({ status: 'refused', code: 2, lines: [`git-ci publish: recusado: ${m}`] });
  const fail = (m: string): PublishResult => ({ status: 'error', code: 1, lines: [`git-ci publish: ERRO: ${m}`] });
  const branch = currentBranch(git);
  if (branch !== cfg.branch) return refuse(`o branch atual é ${branch ?? '(HEAD solto)'}, só ${cfg.branch} é publicado`);
  const unsafe = unsafeState(git);
  if (unsafe) return refuse(`estado inseguro: ${unsafe}`);
  // The branch refspec is explicit: with a command-line refspec Git would not reliably refresh refs/remotes/<remote>/<branch>, and the
  // ahead/behind/diverged decision below needs it current.
  const fetched = git(['fetch', '--tags', '--prune', '--quiet', cfg.remote, FAIL_REFSPEC, `+refs/heads/${cfg.branch}:refs/remotes/${cfg.remote}/${cfg.branch}`]);
  if (fetched.code !== 0) return fail(`fetch de ${cfg.remote} falhou, nada foi enviado: ${fetched.err || `exit ${fetched.code}`}`);
  const local = git(['rev-parse', '--verify', `refs/heads/${cfg.branch}`]);
  const remote = git(['rev-parse', '--verify', '--quiet', `refs/remotes/${cfg.remote}/${cfg.branch}`]);
  if (local.code !== 0) return fail(`branch local ${cfg.branch} não encontrado`);
  if (remote.code !== 0) return fail(`${cfg.remote}/${cfg.branch} não existe; a primeira publicação é manual`);
  if (local.out === remote.out) return { status: 'up-to-date', code: 0, lines: [`git-ci publish: ${cfg.branch} já igual a ${cfg.remote}/${cfg.branch}; nada a enviar.`] };
  let remoteIsAncestor: boolean; let localIsAncestor: boolean;
  try { remoteIsAncestor = isAncestor(git, remote.out, local.out); localIsAncestor = isAncestor(git, local.out, remote.out); } catch (e) { return fail((e as Error).message); }
  if (localIsAncestor) return fail(`${cfg.branch} local está ATRÁS de ${cfg.remote}/${cfg.branch}; integre o remoto primeiro, nada foi enviado`);
  if (!remoteIsAncestor) return fail(`${cfg.branch} local e ${cfg.remote}/${cfg.branch} DIVERGIRAM; resolva manualmente, nada foi enviado`);
  const pushed = git(['push', cfg.remote, `refs/heads/${cfg.branch}:refs/heads/${cfg.branch}`]);
  if (pushed.code !== 0) return fail(`push recusado/falhou: ${pushed.err || `exit ${pushed.code}`}`);
  return { status: 'pushed', code: 0, lines: [`git-ci publish: ${cfg.branch} enviado para ${cfg.remote} (${remote.out.slice(0, 12)}..${local.out.slice(0, 12)}).`] };
}

// ── CI side: result tags ────────────────────────────────────────────────────────────────────────────────────────────────
export interface TagResult { status: 'created' | 'exists' | 'error'; code: number; tag?: string; lines: string[] }
export interface TagInput { result: 'pass' | 'fail'; sha: string; remote: string; pipelineIid: string; pipelineCreatedAt: string; prefix?: string }

/** `vYYYY.MM.NNNNNN[-fail]` from the pipeline's creation time (UTC, ISO-8601) and its project IID, zero-padded to 6 digits (legacy unpadded tags still parse). */
export function resultTagName(o: { result: 'pass' | 'fail'; pipelineIid: string; pipelineCreatedAt: string }, prefix = ''): string {
  const m = /^(\d{4})-(\d{2})-\d{2}/.exec(o.pipelineCreatedAt);
  if (!m) throw new Error(`data de criação do pipeline inválida: ${JSON.stringify(o.pipelineCreatedAt)}`);
  if (!/^[1-9]\d*$/.test(o.pipelineIid)) throw new Error(`IID do pipeline inválido: ${JSON.stringify(o.pipelineIid)}`);
  return `${prefix}v${m[1]}.${m[2]}.${o.pipelineIid.padStart(6, "0")}${o.result === 'fail' ? '-fail' : ''}`;
}

/**
 * Record a CI result as ONE tag on the exact tested SHA. Creates no commit and touches neither the working tree nor any branch.
 * `remote` is a remote name or URL. The pipeline's tag always shows its CURRENT state: a passing retry removes the earlier -fail tag
 * (and the symmetric case), the new tag is pushed first so there is never a moment without a state. Idempotent per (pipeline, SHA).
 * The same pipeline identity on a different SHA is a real conflict and fails.
 */
export function tagResult(git: Git, o: TagInput): TagResult {
  const err = (m: string): TagResult => ({ status: 'error', code: 1, lines: [`git-ci tag: ERRO: ${m}`] });
  if (!/^[0-9a-f]{40}$/.test(o.sha)) return err(`SHA inválido: ${o.sha}`);
  if (git(['cat-file', '-e', `${o.sha}^{commit}`]).code !== 0) return err(`o commit ${o.sha} não existe neste clone`);
  const prefix = o.prefix ?? '';
  let want: string; let other: string;
  try {
    want = resultTagName(o, prefix);
    other = resultTagName({ ...o, result: o.result === 'pass' ? 'fail' : 'pass' }, prefix);
  } catch (e) { return err((e as Error).message); }
  const note = `CI ${o.result === 'pass' ? 'green' : 'red'} (pipeline ${o.pipelineIid}) for ${o.sha}`;
  const ident = ['-c', 'user.name=GitLab CI', '-c', 'user.email=ci@localhost'];
  const lines: string[] = [];
  for (let attempt = 1; attempt <= 3; attempt++) {
    const f = git(['fetch', '--quiet', o.remote, '+refs/tags/*:refs/tags/*']);
    if (f.code !== 0) return err(`não foi possível buscar as tags de ${o.remote}: ${f.err || `exit ${f.code}`}`);
    const byName = new Map(listCiTags(git, prefix).map((t) => [t.name, t]));
    const mine = byName.get(want); const theirs = byName.get(other);
    for (const t of [mine, theirs]) if (t && t.sha !== o.sha) return err(`conflito: ${t.name} aponta para ${t.sha}, não para ${o.sha}`);
    if (!mine) {
      const made = git([...ident, 'tag', '-a', want, o.sha, '-m', note]);
      if (made.code !== 0) return err(`tag ${want}: ${made.err}`);
      const pushed = git(['push', '--quiet', o.remote, `refs/tags/${want}:refs/tags/${want}`]);
      if (pushed.code !== 0) {
        git(['tag', '-d', want]);   // rejected (race on the same name): look at the remote again, never overwrite
        if (attempt === 3) return err(`push da tag ${want} recusado ${attempt} vezes: ${pushed.err}`);
        continue;
      }
      lines.push(`git-ci tag: ${want} -> ${o.sha}`);
    }
    if (theirs) {
      const del = git(['push', '--quiet', o.remote, `:refs/tags/${other}`]);
      if (del.code !== 0) return err(`${want} foi gravada mas a tag antiga ${other} NÃO pôde ser removida: ${del.err}`);
      git(['tag', '-d', other]);
      lines.push(`git-ci tag: ${other} removida (o pipeline agora é ${want})`);
    }
    if (!lines.length) lines.push(`git-ci tag: ${want} já existe neste SHA; nada a fazer.`);
    return { status: mine ? 'exists' : 'created', code: 0, tag: want, lines };
  }
  return err('inalcançável');
}

/**
 * Canary for the tag path (TLS, token, push, delete) WITHOUT the test suite. It only touches its own tag `ci-selftest/<pipeline>`:
 * creates it on the SHA, proves the remote has it, deletes it and proves it is gone. It never creates a result tag, so it
 * can never fake a green or a red.
 */
export function selfTest(git: Git, o: { sha: string; remote: string; pipeline?: string }): TagResult {
  const err = (m: string): TagResult => ({ status: 'error', code: 1, lines: [`git-ci selftest: ERRO: ${m}`] });
  if (!/^[0-9a-f]{40}$/.test(o.sha)) return err(`SHA inválido: ${o.sha}`);
  const name = `ci-selftest/${o.pipeline ?? o.sha.slice(0, 12)}`;
  const remoteHas = () => { const r = git(['ls-remote', '--tags', o.remote, `refs/tags/${name}`]); return r.code === 0 ? r.out.length > 0 : null; };
  const lines: string[] = [];
  const f = git(['fetch', '--quiet', o.remote, 'HEAD']);
  if (f.code !== 0) return err(`não foi possível falar com ${o.remote}: ${f.err || `exit ${f.code}`}`);
  lines.push('git-ci selftest: leitura do remoto ok');
  const made = git(['-c', 'user.name=GitLab CI', '-c', 'user.email=ci@localhost', 'tag', '-a', name, o.sha, '-m', 'CI tag-path selftest; deleted right after']);
  if (made.code !== 0) return err(`tag ${name}: ${made.err}`);
  const cleanup = () => { git(['push', '--quiet', o.remote, `:refs/tags/${name}`]); git(['tag', '-d', name]); };
  const pushed = git(['push', '--quiet', o.remote, `refs/tags/${name}:refs/tags/${name}`]);
  if (pushed.code !== 0) { git(['tag', '-d', name]); return err(`push da tag recusado: ${pushed.err}`); }
  lines.push(`git-ci selftest: tag ${name} criada no remoto`);
  if (remoteHas() !== true) { cleanup(); return err(`o remoto não mostra ${name} depois do push`); }
  const del = git(['push', '--quiet', o.remote, `:refs/tags/${name}`]);
  git(['tag', '-d', name]);
  if (del.code !== 0) return err(`a tag ${name} foi criada mas NÃO foi apagada: ${del.err}`);
  if (remoteHas() !== false) return err(`a tag ${name} ainda existe no remoto depois de apagada`);
  lines.push(`git-ci selftest: tag ${name} apagada; caminho de tags OK`);
  return { status: 'created', code: 0, lines };
}

/**
 * The REAL tagResult code path, but under the sandbox prefix (`ci-selftest-vYYYY.MM.NNNNNN[-fail]`), which no gate ever reads: records the
 * tag on the exact SHA, proves the remote has it, deletes it and proves it gone. A real -fail tag would block merges; this never does.
 */
export function sandboxTag(git: Git, o: Omit<TagInput, 'prefix'>): TagResult {
  const err = (m: string): TagResult => ({ status: 'error', code: 1, lines: [`git-ci sandbox: ERRO: ${m}`] });
  const t = tagResult(git, { ...o, prefix: SANDBOX_PREFIX });
  if (t.code !== 0 || !t.tag) return t;
  const has = () => { const r = git(['ls-remote', '--tags', o.remote, `refs/tags/${t.tag}`]); return r.code === 0 ? r.out.length > 0 : null; };
  const lines = [...t.lines];
  if (has() !== true) return err(`o remoto não mostra ${t.tag}`);
  lines.push(`git-ci sandbox: ${t.tag} existe no remoto, no SHA ${o.sha}`);
  const del = git(['push', '--quiet', o.remote, `:refs/tags/${t.tag}`]);
  git(['tag', '-d', t.tag]);
  if (del.code !== 0) return err(`a tag ${t.tag} foi criada mas NÃO foi apagada: ${del.err}`);
  if (has() !== false) return err(`a tag ${t.tag} ainda existe depois de apagada`);
  lines.push(`git-ci sandbox: ${t.tag} apagada; caminho ${o.result === 'fail' ? 'RED' : 'GREEN'} OK`);
  return { status: 'created', code: 0, tag: t.tag, lines };
}
