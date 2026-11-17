import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { createInspectionGate } from './server/website-inspection.js';
import { createApiHandler } from './server/api/service.js';

function websiteInspection() {
  const handleInspectRequest = createInspectionGate();
  const mount = (server, allowLocalWorker) => {
    const handleApi = createApiHandler();
    if (allowLocalWorker && process.env.FRONTLINE_START_POSTGRES_PREPARATION_WORKER === '1') {
      void handleApi.startPreparationWorker().catch((error) => {
        // Name and code only, matching the preparation queue's own failure logging: the message can carry
        // connection details.
        const safe = (value) => typeof value === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(value) ? value : 'unknown';
        console.error(`PostgreSQL preparation worker did not start (${safe(error?.name)} ${safe(error?.code)}).`);
      });
      server.httpServer?.once('close', () => handleApi.stopPreparationWorker());
    }
    server.middlewares.use((request, response, next) => {
      let url;
      try { url = new URL(request.url ?? '/', 'http://localhost'); }
      catch { next(); return; }
      if (url.pathname === '/healthz') {
        const readiness = handleApi.researchReadiness?.() ?? { ready: Boolean(handleApi.researchReady?.()), queueReady: false, workerReady: false, configurationReady: false, storageMode: 'unknown' };
        const preparationReady = Boolean(readiness.ready);
        response.writeHead(preparationReady ? 200 : 503, {
          'cache-control': 'no-store',
          'content-type': 'application/json; charset=utf-8',
          'x-content-type-options': 'nosniff',
        });
        response.end(JSON.stringify({ status: preparationReady ? 'ok' : 'degraded', preparationReady, queueReady: readiness.queueReady, workerReady: readiness.workerReady, configurationReady: readiness.configurationReady, storageMode: readiness.storageMode }));
        return;
      }
      if (!url.pathname.startsWith('/v1/')) { next(); return; }
      void handleApi(request, response, url);
    });
    server.middlewares.use('/api/inspect', (request, response) => {
      if (process.env.FRONTLINE_LOCAL_PREVIEW === '1') {
        response.writeHead(503, {
          'cache-control': 'no-store',
          'content-type': 'application/json; charset=utf-8',
          'x-content-type-options': 'nosniff',
        });
        response.end(JSON.stringify({ error: 'research_unavailable', message: 'Business research is not configured for local preview.' }));
        return;
      }
      void handleInspectRequest(request, response);
    });
  };

  return {
    name: 'frontline-website-inspection',
    configureServer: (server) => mount(server, true),
    configurePreviewServer: (server) => mount(server, false),
  };
}

const localPreviewCache = process.env.FRONTLINE_LOCAL_PREVIEW === '1'
  ? resolve(tmpdir(), 'frontline-vite-cache', createHash('sha256').update(process.cwd()).digest('hex').slice(0, 12))
  : undefined;

export default defineConfig({
  ...(localPreviewCache ? { cacheDir: localPreviewCache, envDir: false } : {}),
  plugins: [react(), websiteInspection()],
  test: { environment: 'jsdom', setupFiles: './tests/setup.js', include: ['tests/*.test.{js,jsx}'] },
});
