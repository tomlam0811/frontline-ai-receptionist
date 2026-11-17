// Local preview launcher (TOM-26). `npm run dev` runs a secretless UI preview.
// `dev:integrations` explicitly opts into Infisical-backed research configuration.
// `dev:postgres-worker` is a separate opt-in that retains database access.
// Integration diagnostics print only safe categories and allowlisted setting names.
import { spawn, spawnSync } from 'node:child_process';
import { classifyInfisicalFailure, missingSettingNames } from './lib/infisical-failure.mjs';
import { secretlessPreviewEnvironment } from './lib/local-preview-env.mjs';

const WORKER_FLAG = 'FRONTLINE_START_POSTGRES_PREPARATION_WORKER';
const STATUS_TIMEOUT_MS = 20_000;
const PREFLIGHT_TIMEOUT_MS = 60_000;

const postgresWorker = process.argv.includes('--postgres-worker');
const integrations = process.argv.includes('--integrations') || postgresWorker;
const modeEnv = postgresWorker ? ['env', `${WORKER_FLAG}=1`] : ['env', '-u', 'DATABASE_URL', '-u', WORKER_FLAG];

function stop(category, recovery, names = []) {
  console.error(`Frontline preview did not start (${category}).`);
  if (names.length) console.error(`Settings: ${names.join(', ')}`);
  console.error(recovery);
  process.exit(1);
}

function runCli(args, timeout) {
  const result = spawnSync('infisical', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout, killSignal: 'SIGKILL' });
  return {
    ok: result.status === 0 && !result.error,
    output: `${result.stdout ?? ''}\n${result.stderr ?? ''}`,
    spawnErrorCode: /** @type {NodeJS.ErrnoException | undefined} */ (result.error)?.code,
    timedOut: /** @type {NodeJS.ErrnoException | undefined} */ (result.error)?.code === 'ETIMEDOUT',
  };
}

function preflight() {
  const status = runCli(['login', 'status'], STATUS_TIMEOUT_MS);
  if (!status.ok) {
    const failure = classifyInfisicalFailure({ ...status, output: status.output });
    // `login status` failing with no other evidence means there is no usable session here.
    const known = failure.category === 'unknown' ? classifyInfisicalFailure({ output: 'not authenticated' }) : failure;
    stop(known.category, known.recovery);
  }
  const check = runCli(['run', '--env=dev', '--silent', '--', ...modeEnv, process.execPath, 'scripts/require-research-config.mjs'], PREFLIGHT_TIMEOUT_MS);
  if (!check.ok) {
    const failure = classifyInfisicalFailure(check);
    stop(failure.category, failure.recovery, failure.category === 'config-incomplete' ? missingSettingNames(check.output) : []);
  }
}

const viteArgs = ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--configLoader', 'native'];
if (integrations) {
  preflight();
}
const serve = integrations
  ? spawn('infisical', ['run', '--env=dev', '--', ...modeEnv, 'npm', 'run', 'dev:server'], { stdio: 'inherit' })
  : spawn(process.execPath, viteArgs, { stdio: 'inherit', env: secretlessPreviewEnvironment() });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => serve.kill(/** @type {NodeJS.Signals} */ (signal)));
serve.on('exit', (code) => process.exit(code ?? 0));
