import { createServer } from 'vite';
import { secretlessPreviewEnvironment } from '../lib/local-preview-env.mjs';

const inherited = { ...process.env, DATABASE_URL: 'TOM26_DATABASE_CANARY', FRONTLINE_START_POSTGRES_PREPARATION_WORKER: '1', EXA_API_KEY: '', FRONTLINE_EXA_DAILY_MAX_PREPARATIONS: '' };
const previewEnvironment = secretlessPreviewEnvironment(inherited);
if (previewEnvironment.DATABASE_URL || previewEnvironment.FRONTLINE_START_POSTGRES_PREPARATION_WORKER || previewEnvironment.EXA_API_KEY) {
  throw new Error('Secretless preview environment retained provider or worker settings.');
}
for (const name of Object.keys(process.env)) delete process.env[name];
Object.assign(process.env, previewEnvironment);

let server = await createServer({ configLoader: 'native', logLevel: 'error', server: { host: '127.0.0.1', port: 0 } });
try {
  await server.listen();
  const address = server.httpServer.address();
  const response = await fetch(`http://127.0.0.1:${address.port}/healthz`);
  const body = await response.json();
  const expected = { status: 'degraded', preparationReady: false, queueReady: true, workerReady: false, configurationReady: false, storageMode: 'development' };
  if (response.status !== 503 || JSON.stringify(body) !== JSON.stringify(expected)) {
    throw new Error('The local readiness endpoint did not report the expected safe, unavailable state.');
  }
  if (JSON.stringify(body).includes('EXA_API_KEY')) throw new Error('The local readiness endpoint exposed a setting name.');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const sessionResponse = await fetch(`${baseUrl}/v1/session`);
  const session = await sessionResponse.json();
  const cookie = sessionResponse.headers.get('set-cookie')?.split(';', 1)[0];
  const preparationResponse = await fetch(`${baseUrl}/v1/preparations`, {
    method: 'POST',
    headers: { origin: baseUrl, cookie, 'content-type': 'application/json', 'x-frontline-csrf': session.csrfToken },
    body: JSON.stringify({ url: 'https://example.com' }),
  });
  const preparation = await preparationResponse.json();
  if (preparationResponse.status !== 503 || preparation.title !== 'research_unavailable') {
    throw new Error('Secretless preview did not reject website preparation before research.');
  }
  const legacyInspection = await fetch(`${baseUrl}/api/inspect`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: 'https://example.com' }),
  });
  const legacyBody = await legacyInspection.json();
  if (legacyInspection.status !== 503 || legacyBody.error !== 'research_unavailable') {
    throw new Error('Secretless preview left the legacy website inspection route available.');
  }
  await server.close();
  server = null;

  process.env.EXA_API_KEY = 'readiness-only-placeholder';
  process.env.FRONTLINE_EXA_DAILY_MAX_PREPARATIONS = '3';
  server = await createServer({ configLoader: 'native', logLevel: 'error', server: { host: '127.0.0.1', port: 0 } });
  await server.listen();
  const readyAddress = server.httpServer.address();
  const readyResponse = await fetch(`http://127.0.0.1:${readyAddress.port}/healthz`);
  const readyBody = await readyResponse.json();
  const readyExpected = { status: 'ok', preparationReady: true, queueReady: true, workerReady: false, configurationReady: true, storageMode: 'development' };
  if (readyResponse.status !== 200 || JSON.stringify(readyBody) !== JSON.stringify(readyExpected)) {
    throw new Error('The local readiness endpoint did not report the expected configured state.');
  }
  if (JSON.stringify(readyBody).includes('readiness-only-placeholder')) throw new Error('The local readiness endpoint exposed an environment value.');
  console.log('Secretless preview readiness and both research-route refusals passed; no external website was fetched.');
} finally {
  if (server) await server.close();
}
