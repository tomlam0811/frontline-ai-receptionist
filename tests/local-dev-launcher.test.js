import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { classifyInfisicalFailure, missingSettingNames } from '../scripts/lib/infisical-failure.mjs';
import { secretlessPreviewEnvironment } from '../scripts/lib/local-preview-env.mjs';

const root = process.cwd();
const CANARY = 'CANARY_SECRET_VALUE_9f3a';
const cleanup = [];

// A fake `infisical` that logs each call and prints canary text on failure.
function fakeInfisical() {
  const dir = mkdtempSync(join(tmpdir(), 'fake-infisical-'));
  cleanup.push(dir);
  const script = `#!/bin/sh
echo "$@" >> "$FAKE_LOG"
if [ "$1" = "login" ]; then
  [ -n "$FAKE_STATUS_OUT" ] && echo "$FAKE_STATUS_OUT" >&2
  exit "\${FAKE_STATUS_EXIT:-0}"
fi
case "$*" in
  *require-research-config*)
    [ -n "$FAKE_CHECK_OUT" ] && echo "$FAKE_CHECK_OUT" >&2
    exit "\${FAKE_CHECK_EXIT:-0}" ;;
esac
echo SERVE
exit 0
`;
  writeFileSync(join(dir, 'infisical'), script);
  chmodSync(join(dir, 'infisical'), 0o755);
  return dir;
}

function launch(env, args = ['--integrations']) {
  const bin = fakeInfisical();
  const log = join(bin, 'calls.log');
  writeFileSync(log, '');
  const result = spawnSync(process.execPath, ['scripts/local-dev.mjs', ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { PATH: `${bin}:/usr/bin:/bin`, HOME: bin, FAKE_LOG: log, ...env },
  });
  return { ...result, calls: readFileSync(log, 'utf8').trim().split('\n').filter(Boolean), text: `${result.stdout}${result.stderr}` };
}

afterEach(() => { while (cleanup.length) rmSync(cleanup.pop(), { recursive: true, force: true }); });

describe('secretless local preview environment', () => {
  it('passes only basic local runtime settings and excludes credentials and provider/worker configuration', () => {
    const env = secretlessPreviewEnvironment({
      PATH: '/bin', HOME: '/tmp/home', TMPDIR: '/tmp', PORT: '4185', LC_CTYPE: 'en_US.UTF-8',
      EXA_API_KEY: CANARY, DATABASE_URL: `postgres://${CANARY}`, OPENAI_API_KEY: CANARY,
      LIVEKIT_API_SECRET: CANARY, GOOGLE_CLIENT_SECRET: CANARY, RAILWAY_TOKEN: CANARY,
      FRONTLINE_EXA_DAILY_MAX_PREPARATIONS: '5', FRONTLINE_START_POSTGRES_PREPARATION_WORKER: '1',
      FRONTLINE_ENABLE_PAID_VOICE: 'true', VITE_PUBLIC_FLAG: 'irrelevant',
    });
    expect(env).toEqual({ PATH: '/bin', HOME: '/tmp/home', TMPDIR: '/tmp', PORT: '4185', LC_CTYPE: 'en_US.UTF-8', NODE_ENV: 'development', FRONTLINE_LOCAL_PREVIEW: '1' });
    expect(JSON.stringify(env)).not.toContain(CANARY);
  });
});

describe('Infisical-backed integration launcher', () => {
  it('stops at the session check without running an interactive Infisical command', () => {
    const result = launch({ FAKE_STATUS_EXIT: '1', FAKE_STATUS_OUT: `x You are not authenticated. token=${CANARY}` });
    expect(result.status).toBe(1);
    expect(result.text).toContain('(not-authenticated)');
    expect(result.text).toContain('outside the sandbox');
    expect(result.text).not.toContain(CANARY);
    expect(result.calls).toEqual(['login status']);
  });

  it.each([
    ['credential-store-unavailable', { FAKE_STATUS_EXIT: '1', FAKE_STATUS_OUT: `failed to read keyring ${CANARY}` }],
    ['wrong-environment', { FAKE_CHECK_EXIT: '1', FAKE_CHECK_OUT: `status-code=404 Folder with path '/' in environment 'dev' was not found. environment slug ${CANARY}` }],
    ['wrong-project', { FAKE_CHECK_EXIT: '1', FAKE_CHECK_OUT: `Project with ID ${CANARY} was not found` }],
    ['access-denied', { FAKE_CHECK_EXIT: '1', FAKE_CHECK_OUT: `status-code=403 forbidden https://app.example/api?token=${CANARY}` }],
    ['service-unreachable', { FAKE_CHECK_EXIT: '1', FAKE_CHECK_OUT: `dial tcp: no such host ${CANARY}` }],
    ['unknown', { FAKE_CHECK_EXIT: '1', FAKE_CHECK_OUT: `something unexpected ${CANARY}` }],
  ])('reports %s without echoing CLI output', (category, env) => {
    const result = launch(env);
    expect(result.status).toBe(1);
    expect(result.text).toContain(`(${category})`);
    expect(result.text).not.toContain(CANARY);
    expect(result.text).not.toContain('SERVE');
  });

  it('lists only allowlisted setting names when configuration is incomplete', () => {
    const result = launch({ FAKE_CHECK_EXIT: '1', FAKE_CHECK_OUT: `Frontline website research is not configured. Missing or invalid settings: EXA_API_KEY, OTHER=${CANARY}.` });
    expect(result.text).toContain('(config-incomplete)');
    expect(result.text).toContain('Settings: EXA_API_KEY');
    expect(result.text).not.toContain(CANARY);
    expect(result.text).not.toContain('OTHER');
  });

  it('reports a missing CLI without a stack trace', () => {
    const result = spawnSync(process.execPath, ['scripts/local-dev.mjs', '--integrations'], { cwd: root, encoding: 'utf8', env: { PATH: '/nonexistent' } });
    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain('(cli-missing)');
  });

  it('checks settings, then starts the secret-backed integration preview without database or worker settings', () => {
    const result = launch({});
    expect(result.status).toBe(0);
    expect(result.calls[0]).toBe('login status');
    expect(result.calls[1]).toContain('require-research-config');
    expect(result.calls[2]).toBe('run --env=dev -- env -u DATABASE_URL -u FRONTLINE_START_POSTGRES_PREPARATION_WORKER npm run dev:server');
  });

  it('keeps the worker flag only for the explicit worker command', () => {
    const result = launch({}, ['--postgres-worker']);
    expect(result.calls[1]).toContain('FRONTLINE_START_POSTGRES_PREPARATION_WORKER=1');
    expect(result.calls[2]).toBe('run --env=dev -- env FRONTLINE_START_POSTGRES_PREPARATION_WORKER=1 npm run dev:server');
    expect(result.calls[2]).not.toContain('-u');
  });
});

describe('Infisical failure classifier', () => {
  it('classifies the real messages captured from the CLI', () => {
    expect(classifyInfisicalFailure({ output: 'INF No valid login session found, triggering login flow' }).category).toBe('not-authenticated');
    expect(classifyInfisicalFailure({ output: "Folder with path '/' in environment 'x' was not found. Please ensure the environment slug and secret path is correct. [status-code=404]" }).category).toBe('wrong-environment');
    expect(classifyInfisicalFailure({ output: 'cannot find logged-in details' }).category).toBe('not-authenticated');
  });

  it('reads only allowlisted names from the config message', () => {
    expect(missingSettingNames('Missing or invalid settings: EXA_API_KEY, DATABASE_URL.')).toEqual(['EXA_API_KEY', 'DATABASE_URL']);
    expect(missingSettingNames('nothing here')).toEqual([]);
  });
});
