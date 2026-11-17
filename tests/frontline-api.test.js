import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('Frontline API failure messages', () => {
  it.each([
    ['research_unavailable', 'research_unavailable'],
    ['inspection_unavailable', 'inspection_unavailable'],
    ['connection_failed', 'connection_failed'],
    ['origin_mismatch', 'origin_mismatch'],
    ['rate_limited', 'research_busy'],
    ['inspection_busy', 'research_busy'],
    ['inspection_failed', 'failed_retryable'],
  ])('classifies %s as %s', async (code, stage) => {
    const { preparationErrorStage } = await import('../src/lib/frontline-api.js');
    expect(preparationErrorStage(code)).toBe(stage);
  });

  it('explains missing research configuration without exposing provider details', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ csrfToken: 'csrf' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ title: 'research_unavailable', detail: 'The request could not be completed.' }), { status: 503 })));
    const { frontlineApi } = await import('../src/lib/frontline-api.js');
    await expect(frontlineApi.createPreparation('https://example.com'))
      .rejects.toMatchObject({ code: 'research_unavailable', status: 503, message: 'Website research is not configured for this app yet. Please try again after setup.' });
  });

  it('reports an unreachable local API as a connection problem', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('private transport detail')));
    const { frontlineApi } = await import('../src/lib/frontline-api.js');
    await expect(frontlineApi.createPreparation('https://example.com'))
      .rejects.toMatchObject({ code: 'connection_failed', status: 0, message: 'Frontline could not be reached. Check your connection and try again.' });
  });
});
