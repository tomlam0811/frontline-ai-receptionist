import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProductionServer } from '../server/production-server.js';

describe('staging deployment configuration', () => {
  let directory;
  let server;

  afterEach(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (directory) await rm(directory, { recursive: true, force: true });
    vi.unstubAllEnvs();
    server = undefined;
    directory = undefined;
  });

  it('routes only /v1 to the coordinator API host and applies browser security headers', async () => {
    const config = JSON.parse(await readFile(join(process.cwd(), 'vercel.json'), 'utf8'));
    expect(config.rewrites[0]).toEqual({ source: '/v1/:path*', destination: 'https://api.staging.frontline.example/v1/:path*' });
    expect(config.rewrites.some((route) => route.source.includes('api/inspect') && route.source.includes('healthz'))).toBe(true);
    expect(config.rewrites.some((route) => route.destination.includes('railway.app') && !route.source.startsWith('/v1/'))).toBe(false);
    const headers = Object.fromEntries(config.headers[0].headers.map(({ key, value }) => [key.toLowerCase(), value]));
    expect(headers).toMatchObject({
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'strict-origin-when-cross-origin',
      'x-frame-options': 'DENY',
      'permissions-policy': 'microphone=(self),camera=(),geolocation=()',
    });
  });

  it('sends the old pinned address to the host Google sign-in returns to, and leaves other hosts alone', async () => {
    // Sign-in cookies are per host, so starting sign-in on any host other than the API's AUTH_CALLBACK_URL
    // host fails and lands on the landing page. Only the old alias is redirected, so previews keep working.
    const config = JSON.parse(await readFile(join(process.cwd(), 'vercel.json'), 'utf8'));
    expect(config.redirects).toEqual([{
      source: '/:path(.*)',
      has: [{ type: 'host', value: 'frontline.preview.frontline.example' }],
      destination: 'https://web.staging.frontline.example/:path',
      permanent: false,
    }]);
  });

  it('reports production storage unavailable rather than a ready development fallback', async () => {
    directory = await mkdtemp(join(tmpdir(), 'frontline-production-'));
    await mkdir(join(directory, 'assets'));
    await writeFile(join(directory, 'index.html'), '<!doctype html>');
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('DATABASE_URL', '');
    vi.stubEnv('FRONTLINE_ENABLE_PAID_VOICE', 'false');
    server = await createProductionServer({ distDirectory: directory });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test server did not bind a TCP port.');
    const origin = `http://127.0.0.1:${address.port}`;
    const health = await fetch(`${origin}/healthz`);
    expect(health.status).toBe(503);
    const body = await health.json();
    expect(body).toMatchObject({ status: 'degraded', storageReady: false, voiceReady: false });
    expect(body.revision).toEqual({ commit: null, deploymentId: null });
    const api = await fetch(`${origin}/v1/session`, { headers: { host: new URL(origin).host } });
    expect(api.status).toBe(503);
    await expect(api.json()).resolves.toMatchObject({ title: 'storage_unavailable' });
  });

  it('reports the build revision from valid environment values only', async () => {
    const sha = 'a'.repeat(40);
    const deployment = '12345678-1234-1234-1234-123456789abc';
    const cases = [
      [{ RAILWAY_GIT_COMMIT_SHA: sha, RAILWAY_DEPLOYMENT_ID: deployment }, { commit: sha, deploymentId: deployment }],
      [{ RAILWAY_GIT_COMMIT_SHA: '', FRONTLINE_BUILD_REVISION: sha }, { commit: sha, deploymentId: null }],
      [{ RAILWAY_GIT_COMMIT_SHA: 'not-a-sha', FRONTLINE_BUILD_REVISION: 'abc', RAILWAY_DEPLOYMENT_ID: 'secret-looking-token' }, { commit: null, deploymentId: null }],
    ];
    for (const [env, revision] of cases) {
      directory = await mkdtemp(join(tmpdir(), 'frontline-revision-'));
      await mkdir(join(directory, 'assets'));
      await writeFile(join(directory, 'index.html'), '<!doctype html>');
      vi.stubEnv('NODE_ENV', 'production');
      vi.stubEnv('DATABASE_URL', '');
      for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
      server = await createProductionServer({ distDirectory: directory });
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Test server did not bind a TCP port.');
      const { port } = address;
      const body = await (await fetch(`http://127.0.0.1:${port}/healthz`)).json();
      expect(body.revision).toEqual(revision);
      await new Promise((resolve) => server.close(resolve));
      await rm(directory, { recursive: true, force: true });
      vi.unstubAllEnvs();
      server = undefined;
      directory = undefined;
    }
  });
});
