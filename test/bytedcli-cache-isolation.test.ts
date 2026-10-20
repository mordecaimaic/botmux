import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IDENTITY_DENIED_EXIT_CODE, renderIdentityWrapper, writeSessionIdentity } from '../src/core/cli-identity.js';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'botmux-cache-test-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const home = join(root, 'shared-home');
  const scratch = join(root, 'session-tmp');
  mkdirSync(join(home, '.local/share/bytedcli'), { recursive: true });
  mkdirSync(scratch);
  writeFileSync(join(home, '.local/share/bytedcli/bits-cache'), 'user-a');
  const tool = join(root, 'real-bytedcli');
  // Model the actual Bits cache-first lookup with fake identities and no network.
  writeFileSync(tool, `#!/bin/sh
mkdir -p "$HOME/.local/share/bytedcli"
cache="$HOME/.local/share/bytedcli/bits-cache"
if [ -f "$cache" ]; then cat "$cache"; else printf '%s' "$BYTEDCLI_USER_CLOUD_JWT"; fi
printf '%s' "$BYTEDCLI_USER_CLOUD_JWT" > "$cache"
printf '\\n%s\\n%s\\n%s\\n' "$HOME" "$XDG_DATA_HOME" "\${BYTEDCLI_USER_CODE_JWT:-empty}"
printf '%s|%s|%s' "\${BYTEDCLI_PROFILE:-empty}" "\${AIME_WORKSPACE_PATH:-empty}" "$*"
exit "\${TEST_EXIT_CODE:-0}"
`);
  chmodSync(tool, 0o755);
  const wrapper = join(root, 'bytedcli');
  writeFileSync(wrapper, renderIdentityWrapper('bytedcli', tool));
  const env = {
    PATH: '/usr/bin:/bin', HOME: home, TMPDIR: scratch,
    SESSION_DATA_DIR: root, BOTMUX_SESSION_ID: 'session-one',
    XDG_DATA_HOME: join(home, '.local/share'),
    BYTEDCLI_USER_CODE_JWT: 'stale-parent-code-token',
    BYTEDCLI_PROFILE: '../shared-profile', AIME_WORKSPACE_PATH: home,
  };
  return { home, scratch, wrapper, env };
}

describe('governed bytedcli invocation cache isolation', () => {
  it('ignores shared A cache and rotates the cache when B then C use one session', () => {
    const { wrapper, env, home, scratch } = fixture();
    const homes: string[] = [];
    for (const principal of ['user-b', 'user-c', 'user-b']) {
      writeSessionIdentity(root, 'session-one', { tool: 'bytedcli', cloudJwt: principal });
      const out = execFileSync('/bin/sh', [wrapper, 'bits', 'a b'], { env, encoding: 'utf8' }).split('\n');
      expect(out[0]).toBe(principal);
      expect(out[1]).toMatch(new RegExp(`^${scratch}/`));
      expect(out[2]).toBe(`${out[1]}/.local/share`);
      expect(out[3]).toBe('empty');
      expect(out[4]).toBe('empty|empty|bits a b');
      expect(existsSync(out[1]!)).toBe(false);
      homes.push(out[1]!);
    }
    expect(new Set(homes).size).toBe(3);
    expect(readFileSync(join(home, '.local/share/bytedcli/bits-cache'), 'utf8')).toBe('user-a');
  });

  it('preserves a failing CLI exit code and cleans derived credentials', () => {
    const { wrapper, env } = fixture();
    writeSessionIdentity(root, 'session-one', { tool: 'bytedcli', cloudJwt: 'user-b' });
    const out = spawnSync('/bin/sh', [wrapper], { env: { ...env, TEST_EXIT_CODE: '23' }, encoding: 'utf8' });
    expect(out.status).toBe(23);
    expect(existsSync(out.stdout.split('\n')[1]!)).toBe(false);
  });

  it('fails closed when no session temp is available', () => {
    const { wrapper, env } = fixture();
    writeSessionIdentity(root, 'session-one', { tool: 'bytedcli', cloudJwt: 'user-b' });
    const out = spawnSync('/bin/sh', [wrapper], { env: { ...env, TMPDIR: '' }, encoding: 'utf8' });
    expect(out.status).toBe(IDENTITY_DENIED_EXIT_CODE);
    expect(out.stdout).toBe('');
  });

  it('keeps missing authorization blocked despite a cached machine identity', () => {
    const { wrapper, env } = fixture();
    const out = spawnSync('/bin/sh', [wrapper], { env, encoding: 'utf8' });
    expect(out.status).toBe(IDENTITY_DENIED_EXIT_CODE);
    expect(out.stdout).toBe('');
  });

  it.each(['--as=bot', '--bytecloud-user-jwt-file=/other/token'])('rejects an identity override: %s', arg => {
    const { wrapper, env } = fixture();
    writeSessionIdentity(root, 'session-one', { tool: 'bytedcli', cloudJwt: 'user-b' });
    const out = spawnSync('/bin/sh', [wrapper, arg], { env, encoding: 'utf8' });
    expect(out.status).toBe(IDENTITY_DENIED_EXIT_CODE);
    expect(out.stdout).toBe('');
  });

  it('preserves stdin and argument boundaries', () => {
    const { wrapper, env } = fixture();
    writeSessionIdentity(root, 'session-one', { tool: 'bytedcli', cloudJwt: 'user-b' });
    writeFileSync(join(root, 'real-bytedcli'), '#!/bin/sh\nprintf "%s|%s|" "$#" "$1"\ncat\n');
    const out = execFileSync('/bin/sh', [wrapper, 'a b'], { env, input: 'input', encoding: 'utf8' });
    expect(out).toBe('1|a b|input');
  });

  it('forwards cancellation and removes the invocation home after the child exits', async () => {
    const { wrapper, env } = fixture();
    writeSessionIdentity(root, 'session-one', { tool: 'bytedcli', cloudJwt: 'user-b' });
    writeFileSync(join(root, 'real-bytedcli'), '#!/bin/sh\ntrap "exit 42" TERM\nprintf "%s\\n" "$HOME"\nwhile :; do sleep 0.05; done\n');
    const child = spawn('/bin/sh', [wrapper], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const finished = new Promise<number | null>(resolve => child.once('exit', resolve));
    try {
      const home = await new Promise<string>((resolve, reject) => {
        child.stdout!.once('data', data => resolve(String(data).trim()));
        child.once('error', reject);
      });
      expect(existsSync(home)).toBe(true);
      child.kill('SIGTERM');
      expect(await finished).toBe(42);
      expect(existsSync(home)).toBe(false);
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  });
});

// Optional offline integration with the installed CLI's actual Bits modules.
// Only fake credentials and cache-repro.invalid are used; network is blocked.
const installedDist = process.env.BOTMUX_TEST_BYTEDCLI_DIST;
it.skipIf(!installedDist)('actual Bits SDK ignores A cache through the native identity wrapper', () => {
  const { wrapper, env, home } = fixture();
  const cleanEnv = { PATH: '/usr/bin:/bin', HOME: home, REPRO_DIST: installedDist!, BYTEDCLI_USER_CLOUD_JWT: 'fixture-B', BYTEDCLI_NO_AUTO_UPGRADE: '1' };
  const seed = "\nconst path = require('node:path');\nconst {BitsOpenApiTokenStorage} = require(path.join(process.env.REPRO_DIST, 'auth/bits_openapi_token.js'));\nnew BitsOpenApiTokenStorage('cache-repro.invalid').save('fixture-A-only');\n";
  const probe = "\n(async () => {\n  // Any unexpected network attempt fails before connecting.\n  const stopNetwork = () => { throw new Error('unexpected network attempt'); };\n  for (const name of ['node:http', 'node:https']) {\n    const m = require(name); m.request = stopNetwork; m.get = stopNetwork;\n  }\n  require('node:net').Socket.prototype.connect = stopNetwork;\n  globalThis.fetch = stopNetwork;\n  const path = require('node:path');\n  const dist = process.env.REPRO_DIST;\n  const {SSOClient} = require(path.join(dist, 'auth/sso.js'));\n  let identityLookups = 0;\n  SSOClient.prototype.getBytecloudJwtForSite = async () => {\n    identityLookups++;\n    throw new Error('fixture: stopped before identity/network lookup');\n  };\n  const {loadBitsConfig} = require(path.join(dist, 'api/bits/client_bits_config.js'));\n  const {loginBitsOpenApiToken} = require(path.join(dist, 'api/bits/openapi_token.js'));\n  const cfg = loadBitsConfig({apiUrl: 'https://cache-repro.invalid/'});\n  let result, stopped = false;\n  try { result = await loginBitsOpenApiToken({origin: 'https://cache-repro.invalid'}); }\n  catch (e) {\n    if (e.message !== 'fixture: stopped before identity/network lookup') throw e;\n    stopped = true;\n  }\n  process.stdout.write(JSON.stringify({\n    currentCaller: 'B',\n    configUsesACache: cfg.token === 'fixture-A-only',\n    loginUsesACache: result?.token === 'fixture-A-only',\n    identityLookups,\n    stoppedBeforeIdentityNetworkLookup: stopped\n  }));\n})().catch(e => { console.error(e.message); process.exitCode = 1; });\n";
  execFileSync(process.execPath, ['-e', seed], { env: cleanEnv });
  const shared = JSON.parse(execFileSync(process.execPath, ['-e', probe], { env: cleanEnv, encoding: 'utf8' }));
  expect(shared).toMatchObject({ configUsesACache: true, loginUsesACache: true, identityLookups: 0 });
  const script = join(root, 'probe.cjs');
  writeFileSync(script, probe);
  const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
  writeFileSync(join(root, 'real-bytedcli'), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)}\n`);
  writeSessionIdentity(root, 'session-one', { tool: 'bytedcli', cloudJwt: 'fixture-B' });
  const isolated = JSON.parse(execFileSync('/bin/sh', [wrapper], {
    env: { ...env, REPRO_DIST: installedDist! }, encoding: 'utf8',
  }));
  expect(isolated).toMatchObject({ configUsesACache: false, loginUsesACache: false, identityLookups: 1, stoppedBeforeIdentityNetworkLookup: true });
});
