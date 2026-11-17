import { readFile } from 'node:fs/promises';
import { researchConfiguration } from '../../server/api/research-readiness.js';

const packageJson = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
const viteConfig = await readFile(new URL('../../vite.config.js', import.meta.url), 'utf8');
const apiClient = await readFile(new URL('../../src/lib/frontline-api.js', import.meta.url), 'utf8');
const missing = [];

const launcher = await readFile(new URL('../local-dev.mjs', import.meta.url), 'utf8');
if (packageJson.scripts.dev !== 'node scripts/local-dev.mjs') missing.push('ordinary preview must run the local launcher');
if (packageJson.scripts['dev:integrations'] !== 'node scripts/local-dev.mjs --integrations') missing.push('secret-backed research preview must be an explicit command');
if (!launcher.includes("'run', '--env=dev'")) missing.push('the explicit integration path must load the dev environment from Infisical');
if (!launcher.includes('secretlessPreviewEnvironment()')) missing.push('ordinary preview must use the credential-free environment');
if (!launcher.includes("'--configLoader', 'native'")) missing.push('sandbox preview must avoid Vite config-bundle writes inside the checkout');
if (!launcher.includes("'127.0.0.1'")) missing.push('local preview must bind only to loopback');
const previewEnv = await readFile(new URL('../lib/local-preview-env.mjs', import.meta.url), 'utf8');
if (!previewEnv.includes('SAFE_PREVIEW_ENV') || !previewEnv.includes('FRONTLINE_LOCAL_PREVIEW')) missing.push('ordinary preview must use an explicit safe environment allowlist');
if (!viteConfig.includes('localPreviewCache ? { cacheDir: localPreviewCache, envDir: false }')) missing.push('sandbox preview must put cache files outside the checkout and avoid loading local env files');
if (!launcher.includes("['env', '-u', 'DATABASE_URL', '-u', WORKER_FLAG]")) missing.push('secret-backed integration preview must not inherit database access or start the opt-in worker');
if (!packageJson.scripts['dev:server']?.includes('scripts/require-research-config.mjs')) missing.push('dev server must fail fast when research settings are missing');
if (packageJson.scripts['dev:postgres-worker'] !== 'node scripts/local-dev.mjs --postgres-worker' || !launcher.includes('`${WORKER_FLAG}=1`')) missing.push('PostgreSQL worker startup must be an explicit opt-in dev command');
if (!viteConfig.includes('handleApi.startPreparationWorker()') || !viteConfig.includes('handleApi.stopPreparationWorker()')) missing.push('the opt-in dev worker must start and stop with the Vite server');
if (!viteConfig.includes("url.pathname === '/healthz'")) missing.push('Vite must expose a local research readiness endpoint');
if (!viteConfig.includes('storageMode: readiness.storageMode')) missing.push('health must identify development versus PostgreSQL storage');
if (!viteConfig.includes("FRONTLINE_LOCAL_PREVIEW === '1'") || !viteConfig.includes("error: 'research_unavailable'")) missing.push('secretless preview must disable the legacy inspection endpoint');
const configScript = await readFile(new URL('../../scripts/require-research-config.mjs', import.meta.url), 'utf8');
if (!configScript.includes("missing.push('DATABASE_URL')")) missing.push('the PostgreSQL worker dev command must fail fast without DATABASE_URL');
if (!apiClient.includes("origin_mismatch: 'origin_mismatch'") || !apiClient.includes("rate_limited: 'research_busy'") || !apiClient.includes("inspection_busy: 'research_busy'")) missing.push('pre-admission setup and capacity failures must stay distinct from research-job failures');
if (!packageJson.scripts['check:local-research-runtime']?.includes('local-research-readiness-smoke.mjs')) missing.push('the check command must smoke-test the readiness endpoint');

const valid = researchConfiguration({ EXA_API_KEY: 'present-only-check', FRONTLINE_EXA_DAILY_MAX_PREPARATIONS: '1' });
const invalid = researchConfiguration({ EXA_API_KEY: '', FRONTLINE_EXA_DAILY_MAX_PREPARATIONS: '0' });
if (!valid.ready || valid.missing.length) missing.push('valid research configuration must pass');
if (invalid.ready || invalid.missing.length !== 2) missing.push('incomplete research configuration must report only missing setting names');
if (JSON.stringify(valid).includes('present-only-check')) missing.push('readiness must not expose secret values');

if (missing.length) {
  console.error(`Local research runtime check failed: ${missing.join('; ')}`);
  process.exit(1);
}
console.log('Local research runtime configuration and readiness checks passed.');
