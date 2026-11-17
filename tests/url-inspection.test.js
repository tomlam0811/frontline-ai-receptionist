import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
  InspectionError,
  createInspectionGate,
  createPinnedLookup,
  createInspectHandler,
  inspectWebsite,
  isPublicAddress,
  validateInspectionUrl,
} from '../server/website-inspection.js';

const PUBLIC_ADDRESS = '93.184.216.34';

function publicLookup(address = PUBLIC_ADDRESS) {
  return vi.fn(async () => [{ address, family: 4 }]);
}

function htmlResponse(html, overrides = {}) {
  return {
    body: Buffer.from(html),
    headers: { 'content-type': 'text/html; charset=utf-8' },
    statusCode: 200,
    ...overrides,
  };
}

function responseRecorder() {
  return {
    body: '',
    headers: {},
    statusCode: 0,
    end(value = '') {
      this.body += value;
    },
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      for (const [name, value] of Object.entries(headers)) this.setHeader(name, value);
    },
  };
}

describe('inspectWebsite', () => {
  it('gives a usable recovery when a business website denies automated access', async () => {
    await expect(inspectWebsite('https://example.org', {
      lookup: publicLookup(),
      transport: async () => htmlResponse('<html><body>Forbidden</body></html>', { statusCode: 403 }),
    })).rejects.toMatchObject({
      code: 'site_restricted',
      message: 'That website is not allowing us to read it. Try another public page from your business.',
    });
  });

  it('serves a pinned DNS answer in both modern all-record and legacy callback shapes', () => {
    const lookup = createPinnedLookup('93.184.216.34', 4);
    const allCallback = vi.fn();
    const singleCallback = vi.fn();

    lookup('example.org', { all: true }, allCallback);
    lookup('example.org', {}, singleCallback);

    expect(allCallback).toHaveBeenCalledWith(null, [{ address: '93.184.216.34', family: 4 }]);
    expect(singleCallback).toHaveBeenCalledWith(null, '93.184.216.34', 4);
  });

  it('returns bounded facts extracted only from the fetched HTML and passes a pinned address to transport', async () => {
    const lookup = publicLookup();
    const transport = vi.fn(async (_url, connection) => {
      expect(connection.address).toBe(PUBLIC_ADDRESS);
      expect(connection.family).toBe(4);
      expect(connection.maxBytes).toBe(1_048_576);
      return htmlResponse(`
        <!doctype html>
        <html>
          <head>
            <title>Willow &amp; Row Cleaning</title>
            <meta content="Apartment cleaning in Portland &amp; nearby areas." name="description">
            <script>secret script text</script>
          </head>
          <body>
            <nav>Home Services</nav>
            <main><h1>Care for your home</h1><p>Weekly and one-time cleaning.</p></main>
            <style>.hidden { display: none }</style>
          </body>
        </html>
      `);
    });

    const result = await inspectWebsite('https://willow-row.example.org/services#top', {
      excerptLength: 55,
      lookup,
      transport,
    });

    expect(result).toEqual({
      requestedUrl: 'https://willow-row.example.org/services',
      finalUrl: 'https://willow-row.example.org/services',
      title: 'Willow & Row Cleaning',
      siteName: '',
      description: 'Apartment cleaning in Portland & nearby areas.',
      excerpt: 'Care for your home. Weekly and one-time cleaning.',
    });
    expect(result.excerpt).not.toContain('secret script text');
    expect(lookup).toHaveBeenCalledWith('willow-row.example.org', { all: true, verbatim: true });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('prefers semantic page content and excludes site chrome and a repeated meta description', async () => {
    const repeatedDescription = 'AI support that helps customer service teams resolve requests.';
    const result = await inspectWebsite('https://example.org', {
      lookup: publicLookup(),
      transport: async () => htmlResponse(`
        <html>
          <head><meta name="description" content="${repeatedDescription}"></head>
          <body>
            <header>Summit announcement</header>
            <nav>Product Industries Customers Pricing</nav>
            <main>
              <h1>Customer service built around outcomes</h1>
              <p>${repeatedDescription}</p>
              <p>Resolve complex questions while keeping context intact.</p>
              <aside>Related links</aside>
            </main>
            <footer>Legal and social links</footer>
          </body>
        </html>
      `),
    });

    expect(result.description).toBe(repeatedDescription);
    expect(result.excerpt).toBe('Customer service built around outcomes. Resolve complex questions while keeping context intact.');
    expect(result.excerpt).not.toMatch(/Summit|Product Industries|Related links|Legal/i);
    expect(result.excerpt).not.toContain(repeatedDescription);
  });

  it('revalidates and repins every redirect destination', async () => {
    const lookup = vi.fn(async (hostname) => {
      if (hostname === 'start.example.org') return [{ address: '93.184.216.34', family: 4 }];
      if (hostname === 'final.example.net') return [{ address: '151.101.1.69', family: 4 }];
      throw new Error('unexpected hostname');
    });
    const transport = vi.fn(async (url, connection) => {
      if (url.hostname === 'start.example.org') {
        expect(connection.address).toBe('93.184.216.34');
        return { body: Buffer.alloc(0), headers: { location: 'https://final.example.net/about' }, statusCode: 302 };
      }
      expect(connection.address).toBe('151.101.1.69');
      return htmlResponse('<html><head><title>Final site</title></head><body>Public final page.</body></html>');
    });

    const result = await inspectWebsite('https://start.example.org', { lookup, transport });

    expect(result.requestedUrl).toBe('https://start.example.org/');
    expect(result.finalUrl).toBe('https://final.example.net/about');
    expect(result.title).toBe('Final site');
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it('retries a bounded set of prevalidated pinned addresses within one fetch', async () => {
    const lookup = vi.fn(async () => [
      { address: '2607:f8b0:4005:80a::200e', family: 6 },
      { address: '93.184.216.34', family: 4 },
      { address: '151.101.1.69', family: 4 },
    ]);
    const attempted = [];
    const transport = vi.fn(async (_url, connection) => {
      attempted.push(connection.address);
      if (attempted.length === 1) throw new Error('edge unreachable');
      return htmlResponse('<html><head><title>Reachable edge</title></head><body>Public page.</body></html>');
    });

    const result = await inspectWebsite('https://example.org', {
      lookup,
      maxAddressAttempts: 2,
      transport,
    });

    expect(attempted).toEqual(['93.184.216.34', '151.101.1.69']);
    expect(result.title).toBe('Reachable edge');
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['http://example.org', 'invalid_url'],
    ['https://user:password@example.org', 'blocked_url'],
    ['https://127.0.0.1', 'blocked_url'],
    ['https://[::1]', 'blocked_url'],
    ['https://service.local', 'blocked_url'],
    ['https://example.org:8443', 'blocked_url'],
  ])('rejects unsafe input %s', (input, code) => {
    expect(() => validateInspectionUrl(input)).toThrowError(expect.objectContaining({ code }));
  });

  it('rejects resolution when any DNS answer is not public before transport runs', async () => {
    const transport = vi.fn();
    const lookup = vi.fn(async () => [
      { address: PUBLIC_ADDRESS, family: 4 },
      { address: '169.254.169.254', family: 4 },
    ]);

    await expect(inspectWebsite('https://example.org', { lookup, transport })).rejects.toMatchObject({
      code: 'unsafe_address',
      status: 400,
    });
    expect(transport).not.toHaveBeenCalled();
  });

  it('rejects redirects to private destinations before a second request', async () => {
    const lookup = vi.fn(async (hostname) => (
      hostname === 'example.org'
        ? [{ address: PUBLIC_ADDRESS, family: 4 }]
        : [{ address: '10.0.0.7', family: 4 }]
    ));
    const transport = vi.fn(async () => ({
      body: Buffer.alloc(0),
      headers: { location: 'https://private.example.net/admin' },
      statusCode: 302,
    }));

    await expect(inspectWebsite('https://example.org', { lookup, transport })).rejects.toMatchObject({
      code: 'unsafe_address',
    });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('bounds redirects, response bytes, content type, and elapsed time', async () => {
    const lookup = publicLookup();
    const redirectTransport = vi.fn(async () => ({
      body: Buffer.alloc(0),
      headers: { location: '/again' },
      statusCode: 302,
    }));
    await expect(inspectWebsite('https://example.org', {
      lookup,
      maxRedirects: 1,
      transport: redirectTransport,
    })).rejects.toMatchObject({ code: 'too_many_redirects' });

    await expect(inspectWebsite('https://example.org', {
      lookup,
      maxBytes: 5,
      transport: async () => htmlResponse('longer than five bytes'),
    })).rejects.toMatchObject({ code: 'response_too_large', status: 413 });

    await expect(inspectWebsite('https://example.org/file.pdf', {
      lookup,
      transport: async () => ({ body: Buffer.from('%PDF'), headers: { 'content-type': 'application/pdf' }, statusCode: 200 }),
    })).rejects.toMatchObject({ code: 'unsupported_content_type', status: 415 });

    await expect(inspectWebsite('https://example.org', {
      lookup,
      timeoutMs: 5,
      transport: () => new Promise(() => {}),
    })).rejects.toMatchObject({ code: 'timeout', status: 504 });
  });

  it('uses one time budget across DNS and every redirect', async () => {
    await expect(inspectWebsite('https://example.org', {
      lookup: () => new Promise(() => {}),
      timeoutMs: 5,
    })).rejects.toMatchObject({ code: 'timeout', status: 504 });

    let hops = 0;
    await expect(inspectWebsite('https://example.org', {
      lookup: publicLookup(),
      maxRedirects: 3,
      timeoutMs: 20,
      transport: async () => {
        hops += 1;
        await new Promise((resolve) => setTimeout(resolve, 12));
        return hops < 4
          ? { body: Buffer.alloc(0), headers: { location: '/next' }, statusCode: 302 }
          : htmlResponse('<html><body>Reached</body></html>');
      },
    })).rejects.toMatchObject({ code: 'timeout', status: 504 });
    expect(hops).toBeLessThan(4);
  });

  it('classifies private, metadata, documentation, and public addresses conservatively', () => {
    expect(isPublicAddress('8.8.8.8')).toBe(true);
    expect(isPublicAddress('2607:f8b0:4005:80a::200e')).toBe(true);
    expect(isPublicAddress('127.0.0.1')).toBe(false);
    expect(isPublicAddress('169.254.169.254')).toBe(false);
    expect(isPublicAddress('10.1.2.3')).toBe(false);
    expect(isPublicAddress('2001:db8::1')).toBe(false);
    expect(isPublicAddress('2001:2::1')).toBe(false);
    expect(isPublicAddress('2001:20::1')).toBe(false);
    expect(isPublicAddress('2002:7f00:1::')).toBe(false);
    expect(isPublicAddress('3fff::1')).toBe(false);
    expect(isPublicAddress('2620:4f:8000::1')).toBe(false);
    expect(isPublicAddress('192.88.99.1')).toBe(false);
    expect(isPublicAddress('192.31.196.1')).toBe(false);
    expect(isPublicAddress('192.52.193.1')).toBe(false);
    expect(isPublicAddress('192.175.48.1')).toBe(false);
    expect(isPublicAddress('fe80::1')).toBe(false);
  });
});

describe('createInspectHandler', () => {
  it('returns the stable success shape from POST /api/inspect', async () => {
    const request = Object.assign(Readable.from([JSON.stringify({ url: 'https://example.org' })]), {
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });
    const response = responseRecorder();
    const handler = createInspectHandler({
      lookup: publicLookup(),
      transport: async () => htmlResponse('<html><head><title>Example</title></head><body>Useful public text.</body></html>'),
    });

    await handler(request, response);

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(JSON.parse(response.body)).toEqual({
      requestedUrl: 'https://example.org/',
      finalUrl: 'https://example.org/',
      title: 'Example',
      siteName: '',
      description: '',
      excerpt: 'Useful public text.',
    });
  });

  it('returns structured errors without leaking internal transport details', async () => {
    const request = Object.assign(Readable.from([JSON.stringify({ url: 'https://example.org' })]), {
      headers: { 'content-type': 'application/json; charset=utf-8' },
      method: 'POST',
    });
    const response = responseRecorder();
    const handler = createInspectHandler({
      lookup: publicLookup(),
      transport: async () => {
        throw new Error('connect ECONNREFUSED 10.0.0.1:443');
      },
    });

    await handler(request, response);

    expect(response.statusCode).toBe(502);
    expect(JSON.parse(response.body)).toEqual({
      error: 'fetch_failed',
      message: 'The website could not be reached securely.',
    });
    expect(response.body).not.toContain('10.0.0.1');
  });

  it('returns request errors with stable codes', async () => {
    const request = Object.assign(Readable.from(['not json']), {
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });
    const response = responseRecorder();
    await createInspectHandler()(request, response);

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body)).toEqual({
      error: 'invalid_json',
      message: 'Send a JSON body with a website URL.',
    });
  });

  it('requires JSON request content', async () => {
    const request = Object.assign(Readable.from([JSON.stringify({ url: 'https://example.org' })]), {
      headers: { 'content-type': 'text/plain' },
      method: 'POST',
    });
    const response = responseRecorder();
    await createInspectHandler()(request, response);

    expect(response.statusCode).toBe(415);
    expect(JSON.parse(response.body)).toEqual({
      error: 'unsupported_media_type',
      message: 'Send the website URL as application/json.',
    });
  });
});

it('uses InspectionError for stable public failures', () => {
  const error = new InspectionError('test_error', 'Safe message', 418);
  expect(error).toMatchObject({ code: 'test_error', message: 'Safe message', status: 418 });
});

describe('createInspectionGate', () => {
  it('limits repeated inspection requests per client with a stable retry response', async () => {
    const handler = vi.fn(async (_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{}');
    });
    const gate = createInspectionGate({ handler, maxRequests: 1, now: () => 1_000, windowMs: 60_000 });
    const request = { socket: { remoteAddress: '192.0.2.10' } };
    const firstResponse = responseRecorder();
    const secondResponse = responseRecorder();

    await gate(request, firstResponse);
    await gate(request, secondResponse);

    expect(firstResponse.statusCode).toBe(200);
    expect(secondResponse.statusCode).toBe(429);
    expect(secondResponse.headers['retry-after']).toBe('60');
    expect(JSON.parse(secondResponse.body)).toEqual({
      error: 'rate_limited',
      message: 'Too many website checks. Try again shortly.',
    });
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
