import { describe, expect, it, vi } from 'vitest';
import { researchWebsiteWithExa } from '../server/exa-website-research.js';

const website = 'https://business.example.org/';

/** @param {string} path @param {string} [text] */
function page(path, text = 'Published business information.') {
  return { url: new URL(path, website).href, title: `Page ${path}`, text };
}

/** @param {unknown} payload */
function fixture(payload, status = 200) {
  return {
    apiKey: 'test-only-exa-key',
    fetch: vi.fn(/** @param {RequestInfo | URL} _input @param {RequestInit} [_init] */ async (_input, _init) => new Response(JSON.stringify(payload), {
      status,
      headers: { 'content-type': 'application/json' },
    })),
  };
}

describe('researchWebsiteWithExa', () => {
  it('retains root and nested pages with their own source URLs and bounded content', async () => {
    const network = fixture({
      requestId: 'research-fixture',
      results: [{
        ...page('/', 'Welcome to the business.'),
        subpages: [page('/services', 'We offer pressure washing.'), page('/about', 'A'.repeat(12_100))],
      }],
    });

    const result = await researchWebsiteWithExa(website, network);

    expect(result).toMatchObject({ requestedUrl: website, origin: 'https://business.example.org', provider: 'exa', requestId: 'research-fixture' });
    expect(result.pages.map(({ finalUrl }) => finalUrl)).toEqual([website, `${website}services`, `${website}about`]);
    expect(result.pages[1]).toMatchObject({
      finalUrl: `${website}services`, title: 'Page /services', description: '', excerpt: 'We offer pressure washing.',
    });
    expect(result.pages[2].excerpt).toHaveLength(12_000);
    expect(result.pages[1].retrievedAt).toMatch(/^\d{4}-/);
    expect(result.retrieval).toMatchObject({ state: 'retrieved', admittedCount: 3, exhaustive: false });
    expect(network.fetch).toHaveBeenCalledOnce();
    const [url, options] = network.fetch.mock.calls[0];
    expect(url).toBe('https://api.exa.ai/contents');
    expect(options.method).toBe('POST');
    if (typeof options.body !== 'string') throw new Error('Exa request must have a JSON string body');
    expect(JSON.parse(options.body)).toMatchObject({ urls: [website], subpages: 9, text: { maxCharacters: 12_000 } });
  });

  it('applies same-host, same-origin and safe-URL checks to nested pages', async () => {
    const rejectedUrls = [
      'https://other.example.org/services',
      'https://business.example.org.evil.example/services',
      'https://www.business.example.org/services',
      'http://business.example.org/services',
      'https://business.example.org:8443/services',
      'https://user:password@business.example.org/services',
      'https://127.0.0.1/private',
      'https://[::1]/private',
      'https://service.local/private',
      'data:text/plain,untrusted',
    ];
    const network = fixture({ results: [{
      ...page('/'),
      subpages: [
        ...rejectedUrls.map((url) => ({ url, text: 'Untrusted source text.' })),
        page('/services', 'Allowed same-origin source.'),
      ],
    }] });

    const result = await researchWebsiteWithExa(website, network);

    expect(result.pages.map(({ finalUrl }) => finalUrl)).toEqual([website, `${website}services`]);
    expect(JSON.stringify(result.pages)).not.toContain('Untrusted source text');
    expect(network.fetch).toHaveBeenCalledOnce();
  });

  it('deduplicates normalized URLs across roots and subpages before applying the ten-page cap', async () => {
    const network = fixture({ results: [
      { ...page('/'), subpages: [page('/#top', 'Duplicate root.'), page('/services'), page('/services#details', 'Duplicate services.')] },
      { ...page('/services', 'Duplicate top-level services.'), subpages: Array.from({ length: 12 }, (_, index) => page(`/detail-${index}`)) },
    ] });

    const result = await researchWebsiteWithExa(website, network);

    expect(result.pages.map(({ finalUrl }) => finalUrl)).toEqual([
      website, `${website}services`, ...Array.from({ length: 8 }, (_, index) => `${website}detail-${index}`),
    ]);
    expect(result.pages).toHaveLength(10);
    expect(new Set(result.pages.map(({ finalUrl }) => finalUrl)).size).toBe(10);
    expect(JSON.stringify(result.pages)).not.toContain('Duplicate');
  });

  it('ignores empty or malformed nested text without consuming page slots or hiding a later valid duplicate', async () => {
    const network = fixture({ results: [{
      ...page('/'),
      subpages: [null, {}, page('/services', ''), page('/empty', ' \n\t '), { ...page('/object'), text: { text: 'Not text' } }, page('/services', 'Supported service details.')],
    }, { ...page('/about'), subpages: { url: `${website}not-an-array`, text: 'Ignored malformed collection.' } }] });

    const result = await researchWebsiteWithExa(website, network);

    expect(result.pages.map(({ finalUrl }) => finalUrl)).toEqual([website, `${website}services`, `${website}about`]);
    expect(result.pages[1].excerpt).toBe('Supported service details.');
  });

  it.each([[429, 'exa_rate_limited'], [401, 'exa_account_unavailable'], [402, 'exa_account_unavailable'], [500, 'exa_unavailable']])(
    'returns a safe error for provider status %i instead of admitting its nested results', async (status, code) => {
      const network = fixture({ results: [{ ...page('/'), subpages: [page('/services')] }], detail: 'Provider-private diagnostic' }, status);

      await expect(researchWebsiteWithExa(website, network)).rejects.toMatchObject({
        code, message: 'Exa could not retrieve this website.',
      });
      expect(network.fetch).toHaveBeenCalledTimes(1);
    },
  );
});
