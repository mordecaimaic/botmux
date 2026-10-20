import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publishActiveTurn, renderGitAuthorWrapper, writeSessionIdentity } from '../src/core/cli-identity.js';
import { parseGitAuthorProfile } from '../src/services/bytedcli-auth.js';

const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
let root: string;
let repo: string;
let wrapper: string;
let env: NodeJS.ProcessEnv;
const alice = { name: "Alice O'Connor", email: 'alice@example.test' };
const bob = { name: '测试同事', email: 'bob@example.test' };
function raw(...args: string[]) { return execFileSync(realGit, ['-C', repo, ...args], { env, encoding: 'utf8' }).trim(); }
function git(...args: string[]) { return spawnSync(wrapper, ['-C', repo, ...args], { env, encoding: 'utf8' }); }
function identity(user: string, author: typeof alice, turn = user) {
  writeSessionIdentity(root, 'session', { tool: 'bytedcli', cloudJwt: 'fixture', openId: user, turnId: turn, gitAuthor: author });
  publishActiveTurn(root, 'session', turn, 1, user);
}
function author() { return raw('log', '-1', '--format=%an|%ae|%cn|%ce'); }
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'botmux-git-author-'));
  repo = join(root, 'repo'); mkdirSync(repo);
  env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(GIT_|BOTMUX_|BYTEDCLI_|SESSION_DATA_DIR$)/.test(k)));
  Object.assign(env, { HOME: root, XDG_CONFIG_HOME: join(root, 'xdg'), GIT_CONFIG_NOSYSTEM: '1',
    SESSION_DATA_DIR: root, BOTMUX_SESSION_ID: 'session',
    GIT_AUTHOR_NAME: 'Inherited Operator', GIT_AUTHOR_EMAIL: 'operator@example.test',
    GIT_COMMITTER_NAME: 'Inherited Operator', GIT_COMMITTER_EMAIL: 'operator@example.test' });
  raw('init', '-q'); raw('config', 'user.name', 'Shared Operator'); raw('config', 'user.email', 'shared@example.test');
  wrapper = join(root, 'git'); writeFileSync(wrapper, renderGitAuthorWrapper(realGit), { mode: 0o755 });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('managed Git attribution using real commits', () => {
  it('switches A to B in one session, overriding inherited env and repository defaults without writing config', () => {
    const config = readFileSync(join(repo, '.git/config'), 'utf8');
    identity('ou_a', alice);
    let r = git('commit', '--allow-empty', '-m', 'A'); expect(r.status, r.stderr).toBe(0);
    expect(author()).toBe(`${alice.name}|${alice.email}|${alice.name}|${alice.email}`);
    identity('ou_b', bob);
    r = git('-c', 'user.name=Wrong', '-c', 'user.email=wrong@example.test', 'commit', '--allow-empty', '-m', 'B');
    expect(r.status, r.stderr).toBe(0);
    expect(author()).toBe(`${bob.name}|${bob.email}|${bob.name}|${bob.email}`);
    expect(readFileSync(join(repo, '.git/config'), 'utf8')).toBe(config);
  });
  it('allows read-only Git while refusing commits without a profile or after sender switch', () => {
    expect(git('status', '--porcelain').status).toBe(0);
    expect(git('commit', '--allow-empty', '-m', 'unauthed').status).toBe(77);
    identity('ou_a', alice);
    publishActiveTurn(root, 'session', 'turn-b', 1, 'ou_b');
    expect(git('commit', '--allow-empty', '-m', 'wrong-user').status).toBe(77);
    expect(git('status', '--porcelain').status).toBe(0);
    expect(spawnSync(realGit, ['-C', repo, 'rev-parse', '--verify', 'HEAD'], { env }).status).not.toBe(0);
  });
  it('requires a live turn even when a usable identity file remains', () => {
    writeSessionIdentity(root, 'session', { tool: 'bytedcli', cloudJwt: 'fixture', turnId: 'old', gitAuthor: alice });
    expect(git('commit', '--allow-empty', '-m', 'stale').status).toBe(77);
  });
  it('keeps same-person follow-ups usable and supports aliases and commit-tree', () => {
    identity('ou_a', alice, 'turn-a1'); publishActiveTurn(root, 'session', 'turn-a2', 2, 'ou_a');
    const r = git('-c', 'alias.ci=commit', 'ci', '--allow-empty', '-m', 'alias'); expect(r.status, r.stderr).toBe(0);
    expect(author()).toContain(`${alice.name}|${alice.email}`);
    const tree = raw('rev-parse', 'HEAD^{tree}');
    const t = git('commit-tree', tree, '-m', 'plumbing'); expect(t.status, t.stderr).toBe(0);
    expect(raw('show', '-s', '--format=%ae|%ce', t.stdout.trim())).toBe('alice@example.test|alice@example.test');
    writeSessionIdentity(root, 'session', { tool: 'bytedcli', mode: 'denied', message: 'fixture login required' });
    expect(git('-c', 'alias.ci=commit', 'ci', '--allow-empty', '-m', 'denied-alias').status).not.toBe(0);
  });
  it('blocks explicit author replacement and keeps historical replay authors', () => {
    identity('ou_a', alice); expect(git('commit', '--allow-empty', '-m', 'original').status).toBe(0);
    identity('ou_b', bob);
    expect(git('commit', '--allow-empty', '--author=Other <other@example.test>', '-m', 'override').status).toBe(77);
    // Git amend retains the original author, but records the actual new committer.
    expect(git('commit', '--amend', '--allow-empty', '--no-edit').status).toBe(0);
    expect(author()).toBe(`${alice.name}|${alice.email}|${bob.name}|${bob.email}`);
    expect(git('commit', '--amend', '--allow-empty', '--reset-author', '--no-edit').status).toBe(0);
    expect(author()).toBe(`${bob.name}|${bob.email}|${bob.name}|${bob.email}`);
  });
});

describe('verified personal profile parser', () => {
  it('accepts exact personal-account name and email only', () => {
    expect(parseGitAuthorProfile({ type: 'person_account', ...bob })).toEqual(bob);
    for (const raw of [null, { type: 'app', ...alice }, { type: 'person_account', name: 'A', username: 'a' },
      { type: 'person_account', ...alice, name: 'A\nB' }, { type: 'person_account', ...alice, email: 'a\n@b' }]) {
      expect(parseGitAuthorProfile(raw)).toBeUndefined();
    }
  });
});
