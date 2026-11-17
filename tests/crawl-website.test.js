import { describe, expect, it, vi } from 'vitest';
import { crawlWebsite } from '../server/website-inspection.js';

const PUBLIC = '93.184.216.34';

function response(body, statusCode = 200, contentType = 'text/html') {
  return {
    body: Buffer.from(body),
    headers: { 'content-type': contentType },
    statusCode,
  };
}

function fixture(pages, lookup = vi.fn(async () => [{ address: PUBLIC, family: 4 }])) {
  const transport = vi.fn(async (url, connection) => {
    expect(connection.address).toBe(PUBLIC);
    return pages[url.pathname] ?? response('', 404);
  });
  return { lookup, transport };
}

describe('crawlWebsite', () => {
  it('does not request a page forbidden by robots.txt', async () => {
    const network = fixture({
      '/robots.txt': response('User-agent: *\nDisallow: /', 200, 'text/plain'),
      '/': response('<html><body>Should not fetch</body></html>'),
    });

    await expect(crawlWebsite('https://business.example.org/', network))
      .rejects.toMatchObject({ code: 'robots_disallowed' });
    expect(network.transport).toHaveBeenCalledTimes(1);
    expect(network.transport.mock.calls[0][0].pathname).toBe('/robots.txt');
  });

  it('recovers source-bearing services and about pages from a sparse homepage', async () => {
    const network = fixture({
      '/robots.txt': response('', 404, 'text/plain'),
      '/': response(`
        <html><head><title>Willow & Row</title></head><body>
          <nav><a href="/house-cleaning">Services</a><a href="/about">About</a></nav>
          <main><h1>Welcome to Willow & Row</h1></main>
          <a href="https://different.example.net/services">Not this business</a>
          <a href="http://127.0.0.1/admin">Unsafe</a>
          <a href="/privacy">Privacy</a>
        </body></html>
      `),
      '/house-cleaning': response('<html><title>Services</title><main>We offer apartment cleaning and move-out cleaning.</main></html>'),
      '/about': response('<html><title>About us</title><main>Willow & Row serves Portland neighborhoods.</main></html>'),
    });

    const result = await crawlWebsite('https://business.example.org/', network);

    expect(result.pages).toHaveLength(3);
    expect(result.pages.map((page) => page.finalUrl)).toEqual([
      'https://business.example.org/',
      'https://business.example.org/house-cleaning',
      'https://business.example.org/about',
    ]);
    expect(result.pages[1].excerpt).toContain('apartment cleaning');
    expect(result.pages[2].excerpt).toContain('Portland');
    expect(result.limits.pages).toBe(3);
    expect(network.lookup).toHaveBeenCalledTimes(4);
    expect(network.transport).toHaveBeenCalledTimes(4);
  });

  it('applies specific robots rules to discovered pages without fetching them', async () => {
    const network = fixture({
      '/robots.txt': response('User-agent: *\nDisallow: /services\nUser-agent: FrontlineWebsiteInspector\nDisallow: /about\nAllow: /services', 200, 'text/plain'),
      '/': response('<html><title>Home</title><body><a href="/services">Services</a><a href="/about">About</a></body></html>'),
      '/services': response('<html><title>Services</title><body>We clean apartments.</body></html>'),
      '/about': response('<html><title>About</title><body>Not permitted.</body></html>'),
    });

    const result = await crawlWebsite('https://business.example.org/', network);
    expect(result.pages.map((page) => new URL(page.finalUrl).pathname)).toEqual(['/', '/services']);
    expect(network.transport.mock.calls.map(([url]) => url.pathname)).not.toContain('/about');
  });

  it.each([403, 500])('fails closed when robots.txt returns %i', async (statusCode) => {
    const network = fixture({ '/robots.txt': response('unavailable', statusCode, 'text/plain') });
    await expect(crawlWebsite('https://business.example.org/', network))
      .rejects.toMatchObject({ code: 'robots_unavailable' });
    expect(network.transport).toHaveBeenCalledTimes(1);
  });

  it('rejects a page redirect to another origin before resolving or fetching it', async () => {
    const network = fixture({
      '/robots.txt': response('', 404, 'text/plain'),
      '/': { body: Buffer.alloc(0), headers: { location: 'https://other.example.org/services' }, statusCode: 302 },
    });

    await expect(crawlWebsite('https://business.example.org/', network))
      .rejects.toMatchObject({ code: 'cross_origin_redirect' });
    expect(network.lookup).toHaveBeenCalledTimes(2);
    expect(network.transport).toHaveBeenCalledTimes(2);
  });

  it('checks the robots policy again at a same-origin redirect destination', async () => {
    const network = fixture({
      '/robots.txt': response('User-agent: *\nDisallow: /private', 200, 'text/plain'),
      '/': { body: Buffer.alloc(0), headers: { location: '/private' }, statusCode: 302 },
      '/private': response('<html><title>Private</title><body>Do not fetch</body></html>'),
    });

    await expect(crawlWebsite('https://business.example.org/', network))
      .rejects.toMatchObject({ code: 'robots_disallowed' });
    expect(network.transport.mock.calls.map(([url]) => url.pathname)).toEqual(['/robots.txt', '/']);
  });

  it('resolves an apex-to-www redirect by reading www robots before the www page', async () => {
    const transport = vi.fn(async (url, connection) => {
      expect(connection.address).toBe(PUBLIC);
      if (url.hostname === 'business.example.org' && url.pathname === '/robots.txt') {
        return response('', 404, 'text/plain');
      }
      if (url.hostname === 'business.example.org' && url.pathname === '/') {
        return { body: Buffer.alloc(0), headers: { location: 'https://www.business.example.org/' }, statusCode: 301 };
      }
      if (url.hostname === 'www.business.example.org' && url.pathname === '/robots.txt') {
        return response('User-agent: *\nAllow: /', 200, 'text/plain');
      }
      return response('<html><title>Business home</title><body>Apartment cleaning in Portland.</body></html>');
    });
    const lookup = vi.fn(async () => [{ address: PUBLIC, family: 4 }]);

    const result = await crawlWebsite('https://business.example.org/', { lookup, transport });

    expect(result.origin).toBe('https://www.business.example.org');
    expect(result.pages[0].finalUrl).toBe('https://www.business.example.org/');
    expect(transport.mock.calls.map(([url]) => `${url.hostname}${url.pathname}`)).toEqual([
      'business.example.org/robots.txt',
      'business.example.org/',
      'www.business.example.org/robots.txt',
      'www.business.example.org/',
    ]);
    expect(lookup).toHaveBeenCalledTimes(4);
  });

  it('does not fetch the canonical www page when its robots policy denies it', async () => {
    const transport = vi.fn(async (url) => {
      if (url.hostname === 'business.example.org' && url.pathname === '/robots.txt') {
        return response('', 404, 'text/plain');
      }
      if (url.hostname === 'business.example.org' && url.pathname === '/') {
        return { body: Buffer.alloc(0), headers: { location: 'https://www.business.example.org/' }, statusCode: 301 };
      }
      return response('User-agent: *\nDisallow: /', 200, 'text/plain');
    });

    await expect(crawlWebsite('https://business.example.org/', {
      lookup: vi.fn(async () => [{ address: PUBLIC, family: 4 }]),
      transport,
    })).rejects.toMatchObject({ code: 'robots_disallowed' });
    expect(transport.mock.calls.map(([url]) => `${url.hostname}${url.pathname}`)).toEqual([
      'business.example.org/robots.txt',
      'business.example.org/',
      'www.business.example.org/robots.txt',
    ]);
  });

  it('rechecks DNS for every hop and rejects a rebinding to a private address', async () => {
    let calls = 0;
    const lookup = vi.fn(async () => {
      calls += 1;
      return [{ address: calls === 3 ? '169.254.169.254' : PUBLIC, family: 4 }];
    });
    const network = fixture({
      '/robots.txt': response('', 404, 'text/plain'),
      '/': response('<html><title>Home</title><a href="/services">Services</a></html>'),
      '/services': response('<html><title>Services</title><body>Should not fetch</body></html>'),
    }, lookup);

    await expect(crawlWebsite('https://business.example.org/', network))
      .rejects.toMatchObject({ code: 'unsafe_address' });
    expect(network.transport).toHaveBeenCalledTimes(2);
    expect(lookup).toHaveBeenCalledTimes(3);
  });

  it('enforces page and total-byte limits', async () => {
    const network = fixture({
      '/robots.txt': response('', 404, 'text/plain'),
      '/': response('<html><title>Home</title><a href="/services">Services</a></html>'),
      '/services': response('<html><title>Services</title><body>Clean homes.</body></html>'),
    });

    const onePage = await crawlWebsite('https://business.example.org/', { ...network, maxPages: 1 });
    expect(onePage.pages).toHaveLength(1);
    expect(network.transport).toHaveBeenCalledTimes(2);

    await expect(crawlWebsite('https://business.example.org/', { ...network, maxTotalBytes: 8 }))
      .rejects.toMatchObject({ code: 'response_too_large' });
  });

  it('counts redirect bodies against the remaining byte budget', async () => {
    const network = fixture({
      '/robots.txt': response('', 404, 'text/plain'),
      '/': { body: Buffer.from('12345678'), headers: { location: '/about' }, statusCode: 302 },
      '/about': response('<html><title>About</title><body>More content</body></html>'),
    });
    await expect(crawlWebsite('https://business.example.org/', { ...network, maxTotalBytes: 12 }))
      .rejects.toMatchObject({ code: 'response_too_large' });
    expect(network.transport).toHaveBeenCalledTimes(3);
  });

  it('uses one deadline across robots and all pages', async () => {
    const network = fixture({
      '/robots.txt': response('', 404, 'text/plain'),
      '/': response('<html><title>Home</title><body>Visible content.</body></html>'),
    });
    network.transport.mockImplementation(async () => new Promise(() => {}));
    await expect(crawlWebsite('https://business.example.org/', { ...network, maxDurationMs: 5 }))
      .rejects.toMatchObject({ code: 'timeout' });
  });
});
