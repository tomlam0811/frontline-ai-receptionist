import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInspectionGate, handleInspectRequest } from './website-inspection.js';
import { createApiHandler } from './api/service.js';
import { PostgresStore } from './api/postgres-store.js';
import { createPaidStartGate } from './api/paid-start-gate.js';
import { createLiveKitAdapter } from './livekit-adapter.js';

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const defaultDistDirectory = resolve(moduleDirectory, '../dist');
const contentTypes = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.gif', 'image/gif'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.webp', 'image/webp'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
]);

function sendText(response, statusCode, body) {
  response.writeHead(statusCode, {
    'cache-control': 'no-store',
    'content-type': 'text/plain; charset=utf-8',
    'x-content-type-options': 'nosniff',
  });
  response.end(body);
}

function sendJson(response, statusCode, payload, headers = {}) {
  response.writeHead(statusCode, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    'x-content-type-options': 'nosniff',
    ...headers,
  });
  response.end(JSON.stringify(payload));
}

function isInside(root, candidate) {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === '' || (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== '..' && !isAbsolute(pathFromRoot));
}

async function findStaticFile(distDirectory, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;

  const relativePath = decoded.replace(/^\/+/, '') || 'index.html';
  const candidate = resolve(distDirectory, relativePath);
  if (!isInside(distDirectory, candidate)) return null;

  try {
    const candidateRealPath = await realpath(candidate);
    if (!isInside(distDirectory, candidateRealPath)) return null;
    const candidateStat = await stat(candidateRealPath);
    if (candidateStat.isFile()) return { path: candidateRealPath, stat: candidateStat };
  } catch {
    // Extensionless application routes fall through to index.html below.
  }

  if (extname(relativePath)) return null;
  const indexPath = await realpath(resolve(distDirectory, 'index.html'));
  if (!isInside(distDirectory, indexPath)) return null;
  const indexStat = await stat(indexPath);
  return indexStat.isFile() ? { path: indexPath, stat: indexStat } : null;
}

async function serveStatic(request, response, distDirectory, pathname) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    sendText(response, 405, 'Method not allowed');
    return;
  }

  const file = await findStaticFile(distDirectory, pathname);
  if (!file) {
    sendText(response, 404, 'Not found');
    return;
  }

  const extension = extname(file.path).toLowerCase();
  const isHtml = extension === '.html';
  response.writeHead(200, {
    'cache-control': isHtml ? 'no-cache' : 'public, max-age=31536000, immutable',
    'content-length': file.stat.size,
    'content-type': contentTypes.get(extension) ?? 'application/octet-stream',
    'referrer-policy': 'strict-origin-when-cross-origin',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
  });
  if (request.method === 'HEAD') {
    response.end();
    return;
  }
  createReadStream(file.path).pipe(response);
}

export async function createProductionServer(options = {}) {
  const distDirectory = await realpath(options.distDirectory ?? defaultDistDirectory);
  const inspectHandler = createInspectionGate({
    handler: options.inspectHandler ?? handleInspectRequest,
    maxConcurrent: options.maxConcurrentInspections,
    maxConcurrentPerClient: options.maxConcurrentInspectionsPerClient,
    maxRequests: options.maxInspectionsPerWindow,
    windowMs: options.inspectionWindowMs,
  });
  const apiOptions = { ...options.apiOptions };
  let ownedStore;
  let voiceAdapter;
  let voiceRetryTimer;
  let voiceActivationPending = false;
  const production = process.env.NODE_ENV === 'production';
  const productionStorageConfigured = !production || Boolean(options.apiHandler) || apiOptions.store instanceof PostgresStore || (!apiOptions.store && Boolean(process.env.DATABASE_URL));
  if (!options.apiHandler && process.env.NODE_ENV === 'production' && process.env.DATABASE_URL) {
    ownedStore = apiOptions.store ? null : new PostgresStore();
    apiOptions.store ??= ownedStore;
    if (process.env.FRONTLINE_ENABLE_PAID_VOICE === 'true') {
      let secureAppOrigin = false;
      try { secureAppOrigin = new URL(process.env.APP_BASE_URL).protocol === 'https:'; } catch { /* Missing public origin disables paid starts. */ }
      const gate = createPaidStartGate(apiOptions.store);
      voiceAdapter = createLiveKitAdapter({
        listDueDemos: (now) => apiOptions.store.listDueDemos(now),
        // Both the process-local timer and restart sweep persist terminal state
        // before provider deletion. Failed deletion leaves the deadline closing
        // so the next sweep can retry it.
        onHardEndDue: (demo) => apiOptions.store.persistHardEnd({
          ...demo,
          ownerScopeId: demo.ownerScopeId ?? demo.workspaceId,
          deadlinePhase: demo.deadlinePhase ?? (demo.hardEndAt ? 'active' : 'setup'),
        }, false),
        onHardEnd: (demo) => apiOptions.store.finalizeHardEnd({
          ...demo,
          ownerScopeId: demo.ownerScopeId ?? demo.workspaceId,
          deadlinePhase: demo.deadlinePhase ?? 'active',
        }),
      });
      if (voiceAdapter.isConfigured() && typeof apiOptions.store.listDueDemos === 'function' && typeof apiOptions.store.persistHardEnd === 'function' && typeof apiOptions.store.finalizeHardEnd === 'function') {
        apiOptions.voiceAdapter = voiceAdapter;
        apiOptions.paidStartGate = gate;
        // Deadline recovery must keep running after a transient startup error.
        // Paid starts stay closed until a successful durable sweep.
        const activateVoice = async () => {
          if (voiceActivationPending) return false;
          voiceActivationPending = true;
          try {
            await apiOptions.store.ensureReady();
            voiceAdapter.startWatchdog();
            await voiceAdapter.sweepDueHardEnds();
            if (!voiceAdapter.watchdogHealthy()) return false;
            apiOptions.enablePaidVoiceStarts = Boolean(secureAppOrigin && gate && String(process.env.FRONTLINE_VOICE_SERVICE_TOKEN ?? '').length >= 32);
            if (voiceRetryTimer) clearInterval(voiceRetryTimer);
            voiceRetryTimer = undefined;
            return true;
          } catch { return false; }
          finally { voiceActivationPending = false; }
        };
        if (!await activateVoice()) {
          voiceRetryTimer = setInterval(() => { void activateVoice(); }, 5_000);
          voiceRetryTimer.unref?.();
        }
      }
    }
  }
  const apiHandler = options.apiHandler ?? createApiHandler(apiOptions);
  let preparationRetryTimer;
  let preparationStartPending = false;
  if (!options.apiHandler && process.env.NODE_ENV === 'production' && process.env.DATABASE_URL) {
    const startPreparation = async () => {
      if (preparationStartPending || apiHandler.preparationWorkerHealthy?.()) return;
      preparationStartPending = true;
      try {
        await apiHandler.startPreparationWorker?.();
        if (apiHandler.preparationWorkerHealthy?.() && preparationRetryTimer) {
          clearInterval(preparationRetryTimer);
          preparationRetryTimer = undefined;
        }
      } catch { /* Preparation remains at 503 until the next bounded retry. */ }
      finally { preparationStartPending = false; }
    };
    await startPreparation();
    if (!apiHandler.preparationWorkerHealthy?.()) {
      preparationRetryTimer = setInterval(() => { void startPreparation(); }, 5_000);
      preparationRetryTimer.unref?.();
    }
  }

  const buildRevision = () => ({
    commit: [process.env.RAILWAY_GIT_COMMIT_SHA, process.env.FRONTLINE_BUILD_REVISION].find((value) => /^[0-9a-f]{40}$/i.test(value ?? '')) ?? null,
    deploymentId: /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(process.env.RAILWAY_DEPLOYMENT_ID ?? '') ? process.env.RAILWAY_DEPLOYMENT_ID : null,
  });
  const server = createServer(async (request, response) => {
    let url;
    try {
      url = new URL(request.url ?? '/', 'http://localhost');
    } catch {
      sendText(response, 400, 'Bad request');
      return;
    }

    if (url.pathname === '/healthz') {
      let storageReady = productionStorageConfigured;
      const runtimeStore = apiOptions.store;
      if (storageReady && production && !options.apiHandler) {
        try {
          if (!(runtimeStore instanceof PostgresStore)) throw new Error('Production requires scoped PostgreSQL storage.');
          await runtimeStore.ensureReady();
        }
        catch { storageReady = false; }
      }
      const preparationReady = Boolean(apiHandler.researchReady?.() ?? apiHandler.preparationWorkerHealthy?.());
      const ready = storageReady && (!production || preparationReady);
      response.writeHead(ready ? 200 : 503, {
        'cache-control': 'no-store',
        'content-type': 'application/json; charset=utf-8',
        'x-content-type-options': 'nosniff',
      });
      response.end(JSON.stringify({
        status: ready ? 'ok' : 'degraded',
        storageReady,
        preparationReady,
        voiceReady: Boolean(apiOptions.enablePaidVoiceStarts && voiceAdapter?.watchdogHealthy?.()),
        // Public, non-secret identity of the running build. Railway CLI uploads have no commit, so FRONTLINE_BUILD_REVISION can supply a full 40-character commit.
        revision: buildRevision(),
      }));
      return;
    }
    if (url.pathname === '/api/inspect') {
      await inspectHandler(request, response);
      return;
    }
    if (url.pathname.startsWith('/v1/')) {
      await apiHandler(request, response, url);
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      sendJson(response, 404, { error: 'not_found', message: 'API route not found.' });
      return;
    }

    try {
      await serveStatic(request, response, distDirectory, url.pathname);
    } catch {
      if (!response.headersSent) sendText(response, 500, 'Server error');
      else response.destroy();
    }
  });
  server.on('close', () => {
    if (voiceRetryTimer) clearInterval(voiceRetryTimer);
    if (preparationRetryTimer) clearInterval(preparationRetryTimer);
    apiHandler.stopPreparationWorker?.();
    voiceAdapter?.stopWatchdog();
    if (ownedStore) void ownedStore.close();
  });
  return server;
}

const isEntryPoint = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntryPoint) {
  const host = process.env.HOST ?? '127.0.0.1';
  const parsedPort = Number.parseInt(process.env.PORT ?? '4173', 10);
  const port = Number.isInteger(parsedPort) && parsedPort > 0 && parsedPort <= 65_535 ? parsedPort : 4173;
  const server = await createProductionServer();
  server.listen(port, host, () => {
    console.log(`Frontline is ready at http://${host}:${port}`);
  });
}
