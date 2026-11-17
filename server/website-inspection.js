import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';

const DEFAULT_TIMEOUT_MS = 6_000;
const DEFAULT_MAX_BYTES = 1024 * 1024;
const DEFAULT_MAX_REDIRECTS = 3;
const DEFAULT_MAX_ADDRESS_ATTEMPTS = 4;
const DEFAULT_EXCERPT_LENGTH = 600;
const MAX_TITLE_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 500;
const MAX_REQUEST_BYTES = 16 * 1024;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const CRAWL_USER_AGENT = 'FrontlineWebsiteInspector/0.1';
const CRAWL_MAX_PAGES = 10;
const CRAWL_MAX_TOTAL_BYTES = 10 * 1024 * 1024;
const CRAWL_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const CRAWL_MAX_ROBOTS_BYTES = 128 * 1024;
const CRAWL_MAX_DURATION_MS = 90_000;
const CRAWL_MAX_REQUEST_MS = 15_000;
const CRAWL_MAX_CANDIDATES = 40;
const CRAWL_LINK_PATH = /(?:^|\/)(?:about(?:-us)?|services?|service-areas?|locations?|contact|faq|hours|booking|appointments?)(?:\/|$|-)/i;
const CRAWL_EXCLUDED_PATH = /(?:^|\/)(?:login|signin|logout|account|admin|cart|checkout|privacy|terms|cookie|legal|careers?|jobs?|blog|news|press)(?:\/|$|-)/i;
const CRAWL_FILE_EXTENSION = /\.(?:pdf|zip|gz|tar|rar|7z|jpe?g|png|gif|webp|svg|mp[34]|mov|webm|docx?|xlsx?|pptx?|xml|json|txt)$/i;

export class InspectionError extends Error {
  constructor(code, message, status = 422) {
    super(message);
    this.name = 'InspectionError';
    this.code = code;
    this.status = status;
  }
}

function fail(code, message, status) {
  throw new InspectionError(code, message, status);
}

function parseIpv4(address) {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  const bytes = parts.map((part) => {
    if (!/^\d{1,3}$/.test(part)) return Number.NaN;
    const value = Number(part);
    return value <= 255 ? value : Number.NaN;
  });
  return bytes.every(Number.isFinite) ? bytes : null;
}

function parseIpv6(address) {
  let source = address.toLowerCase();
  const zoneIndex = source.indexOf('%');
  if (zoneIndex !== -1) source = source.slice(0, zoneIndex);

  const ipv4Match = source.match(/(?:^|:)(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (ipv4Match) {
    const ipv4 = parseIpv4(ipv4Match[1]);
    if (!ipv4) return null;
    source = `${source.slice(0, -ipv4Match[1].length)}${((ipv4[0] << 8) | ipv4[1]).toString(16)}:${((ipv4[2] << 8) | ipv4[3]).toString(16)}`;
  }

  if ((source.match(/::/g) ?? []).length > 1) return null;
  const [leftSource, rightSource = ''] = source.split('::');
  const left = leftSource ? leftSource.split(':') : [];
  const right = rightSource ? rightSource.split(':') : [];
  if ([...left, ...right].some((part) => !/^[\da-f]{1,4}$/.test(part))) return null;
  const missing = 8 - left.length - right.length;
  if ((source.includes('::') && missing < 1) || (!source.includes('::') && missing !== 0)) return null;
  const groups = [...left, ...Array.from({ length: missing }, () => '0'), ...right];
  const bytes = [];
  for (const group of groups) {
    const value = Number.parseInt(group, 16);
    bytes.push(value >> 8, value & 0xff);
  }
  return bytes;
}

function isPublicIpv4(address) {
  const bytes = parseIpv4(address);
  if (!bytes) return false;
  const [a, b, c] = bytes;

  // Conservative exclusions from https://www.iana.org/assignments/iana-ipv4-special-registry
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0 && c === 0) return false;
  if (a === 192 && b === 0 && c === 2) return false;
  if (a === 192 && b === 31 && c === 196) return false;
  if (a === 192 && b === 52 && c === 193) return false;
  if (a === 192 && b === 88 && c === 99) return false;
  if (a === 192 && b === 175 && c === 48) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

function isPublicIpv6(address) {
  const bytes = parseIpv6(address);
  if (!bytes) return false;

  // Restrict to global-unicast space, then conservatively remove IANA
  // special-purpose blocks: https://www.iana.org/assignments/iana-ipv6-special-registry
  if ((bytes[0] & 0xe0) !== 0x20) return false;
  // 2001::/23 includes protocol assignments, benchmarking, and ORCHIDv2.
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] <= 0x01) return false;
  // 2001:db8::/32 and 3fff::/20 are documentation ranges.
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8) return false;
  if (bytes[0] === 0x3f && bytes[1] === 0xff && (bytes[2] & 0xf0) === 0) return false;
  // 2002::/16 is 6to4; 2620:4f:8000::/48 is an AS112 service prefix.
  if (bytes[0] === 0x20 && bytes[1] === 0x02) return false;
  if (bytes[0] === 0x26 && bytes[1] === 0x20 && bytes[2] === 0 && bytes[3] === 0x4f && bytes[4] === 0x80 && bytes[5] === 0) return false;
  return true;
}

export function isPublicAddress(address) {
  const family = isIP(address);
  if (family === 4) return isPublicIpv4(address);
  if (family === 6) return isPublicIpv6(address);
  return false;
}

export function validateInspectionUrl(input) {
  if (typeof input !== 'string' || !input.trim()) {
    fail('invalid_url', 'Enter a website URL.', 400);
  }

  let url;
  try {
    url = new URL(input.trim());
  } catch {
    fail('invalid_url', 'Enter a valid HTTPS website URL.', 400);
  }

  if (url.protocol !== 'https:') {
    fail('invalid_url', 'Only HTTPS websites can be inspected.', 400);
  }
  if (url.username || url.password) {
    fail('blocked_url', 'Website URLs cannot include credentials.', 400);
  }
  if (url.port && url.port !== '443') {
    fail('blocked_url', 'Only the standard HTTPS port is supported.', 400);
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (isIP(hostname)) {
    fail('blocked_url', 'Enter a public website domain, not an IP address.', 400);
  }
  if (!hostname.includes('.') || hostname.length > 253) {
    fail('blocked_url', 'Enter a public website domain.', 400);
  }
  const labels = hostname.split('.');
  if (labels.some((label) => !/^(?!-)[a-z0-9-]{1,63}(?<!-)$/.test(label))) {
    fail('blocked_url', 'Enter a valid public website domain.', 400);
  }
  const blockedSuffixes = ['.local', '.localhost', '.internal', '.home', '.lan', '.test', '.invalid', '.example'];
  if (blockedSuffixes.some((suffix) => hostname === suffix.slice(1) || hostname.endsWith(suffix))) {
    fail('blocked_url', 'Enter a public website domain.', 400);
  }

  url.hostname = hostname;
  url.hash = '';
  return url;
}

async function resolvePublicAddresses(hostname, lookup) {
  let records;
  try {
    records = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    fail('dns_failed', 'The website domain could not be resolved.', 422);
  }

  const normalized = (Array.isArray(records) ? records : [records]).map((record) => (
    typeof record === 'string' ? { address: record, family: isIP(record) } : record
  ));
  if (!normalized.length || normalized.some((record) => !record?.address || !isPublicAddress(record.address))) {
    fail('unsafe_address', 'The website does not resolve to a public address.', 400);
  }

  const unique = new Map();
  for (const record of normalized) {
    const family = Number(record.family) || isIP(record.address);
    unique.set(`${family}:${record.address}`, { address: record.address, family });
  }
  // IPv4 first avoids making an unreachable local IPv6 route the only attempt.
  return [...unique.values()].sort((left, right) => left.family - right.family);
}

function defaultTransport(url, { address, family, maxBytes, signal, timeoutMs }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      callback(value);
    };
    const abort = () => request.destroy(new InspectionError('timeout', 'The website took too long to respond.', 504));
    const request = httpsRequest(url, {
      agent: false,
      headers: {
        accept: 'text/html,application/xhtml+xml;q=0.9',
        'accept-encoding': 'identity',
        'user-agent': 'FrontlineWebsiteInspector/0.1',
      },
      lookup: createPinnedLookup(address, family),
      method: 'GET',
      servername: url.hostname,
    }, (response) => {
      const chunks = [];
      let total = 0;
      const contentLength = Number(response.headers['content-length']);
      if (Number.isFinite(contentLength) && contentLength > maxBytes) {
        response.destroy();
        finish(reject, new InspectionError('response_too_large', 'The website page is too large to inspect.', 413));
        return;
      }
      response.on('data', (chunk) => {
        total += chunk.length;
        if (total > maxBytes) {
          response.destroy();
          finish(reject, new InspectionError('response_too_large', 'The website page is too large to inspect.', 413));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => finish(resolve, {
        body: Buffer.concat(chunks),
        headers: response.headers,
        statusCode: response.statusCode ?? 0,
      }));
      response.on('error', (error) => finish(reject, error));
    });

    request.setTimeout(timeoutMs, abort);
    request.on('error', (error) => finish(reject, error));
    signal?.addEventListener('abort', abort, { once: true });
    request.end();
  });
}

export function createPinnedLookup(address, family) {
  return (_hostname, options, callback) => {
    if (options?.all) {
      callback(null, [{ address, family }]);
      return;
    }
    callback(null, address, family);
  };
}

async function withTimeout(operation, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await Promise.race([
      operation(controller.signal),
      new Promise((_, reject) => {
        controller.signal.addEventListener('abort', () => {
          reject(new InspectionError('timeout', 'The website took too long to respond.', 504));
        }, { once: true });
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function decodeEntities(value) {
  const named = {
    amp: '&', apos: "'", gt: '>', hellip: '…', laquo: '“', ldquo: '“',
    lt: '<', mdash: '—', nbsp: ' ', ndash: '–', quot: '"', raquo: '”', rdquo: '”', rsquo: '’', lsquo: '‘',
  };
  return value.replace(/&(#x[\da-f]+|#\d+|[a-z][a-z\d]+);/gi, (entity, key) => {
    if (key[0] === '#') {
      const hexadecimal = key[1]?.toLowerCase() === 'x';
      const codePoint = Number.parseInt(key.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
      if (!Number.isFinite(codePoint) || codePoint > 0x10ffff) return ' ';
      try {
        return String.fromCodePoint(codePoint);
      } catch {
        return ' ';
      }
    }
    return named[key.toLowerCase()] ?? ' ';
  });
}

function normalizeText(value) {
  return decodeEntities(value).replace(/\s+/g, ' ').trim();
}

function boundedExcerpt(value, maxLength) {
  if (value.length <= maxLength) return value;
  const prefix = value.slice(0, maxLength);
  const sentenceEnd = Math.max(prefix.lastIndexOf('. '), prefix.lastIndexOf('! '), prefix.lastIndexOf('? '));
  // A source excerpt must not turn a partial sentence into evidence for a fact.
  return sentenceEnd >= 0 ? prefix.slice(0, sentenceEnd + 1).trim() : '';
}

function extractAttribute(tag, name) {
  const attributePattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let match;
  while ((match = attributePattern.exec(tag))) {
    if (match[1].toLowerCase() === name) return match[2] ?? match[3] ?? match[4] ?? '';
  }
  return '';
}

function extractPage(html, excerptLength) {
  const withoutComments = html.replace(/<!--[\s\S]*?-->/g, ' ');
  const titleMatch = withoutComments.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i);
  const title = normalizeText((titleMatch?.[1] ?? '').replace(/<[^>]*>/g, ' ')).slice(0, MAX_TITLE_LENGTH);

  let description = '';
  let siteName = '';
  for (const match of withoutComments.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = match[0];
    if (extractAttribute(tag, 'name').toLowerCase() === 'description' && !description) {
      description = normalizeText(extractAttribute(tag, 'content')).slice(0, MAX_DESCRIPTION_LENGTH);
    }
    if (extractAttribute(tag, 'property').toLowerCase() === 'og:site_name' && !siteName) {
      siteName = normalizeText(extractAttribute(tag, 'content')).slice(0, MAX_TITLE_LENGTH);
    }
  }

  const bodyMatch = withoutComments.match(/<body\b[^>]*>([\s\S]*?)<\/body\s*>/i);
  const documentBody = bodyMatch?.[1] ?? withoutComments;
  const mainMatch = documentBody.match(/<main\b[^>]*>([\s\S]*?)<\/main\s*>/i);
  const articleMatch = documentBody.match(/<article\b[^>]*>([\s\S]*?)<\/article\s*>/i);
  let visible = mainMatch?.[1] ?? articleMatch?.[1] ?? documentBody;
  visible = visible
    .replace(/<(script|style|template|noscript|svg|canvas|nav|header|footer|aside)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<head\b[^>]*>[\s\S]*?<\/head\s*>/gi, ' ')
    .replace(/<(?:br|hr)\s*\/?>/gi, '. ')
    .replace(/<\/?(?:address|article|aside|blockquote|div|footer|form|h[1-6]|header|li|main|nav|ol|p|section|table|td|th|tr|ul)\b[^>]*>/gi, '. ')
    .replace(/<[^>]*>/g, ' ');
  let excerptText = normalizeText(visible).replace(/(?:\.\s*){2,}/g, '. ');
  if (description.length >= 24) {
    const duplicateIndex = excerptText.toLowerCase().indexOf(description.toLowerCase());
    if (duplicateIndex !== -1) {
      excerptText = normalizeText(`${excerptText.slice(0, duplicateIndex)} ${excerptText.slice(duplicateIndex + description.length)}`);
    }
  }
  // Block boundaries preserve sentences, but must not become leading evidence.
  excerptText = normalizeText(excerptText.replace(/^(?:\.\s*)+/, ''));
  const excerpt = boundedExcerpt(excerptText, excerptLength);

  return { title, siteName, description, excerpt };
}

function normalizeHeaders(headers = {}) {
  const normalized = {};
  for (const [key, value] of Object.entries(headers)) {
    normalized[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value ?? '');
  }
  return normalized;
}

function boundedCrawlOption(value, fallback, ceiling) {
  return Number.isSafeInteger(value) && value > 0 ? Math.min(value, ceiling) : fallback;
}

function sameOriginUrl(input, origin, base) {
  let url;
  try {
    url = validateInspectionUrl(new URL(input, base).toString());
  } catch {
    return null;
  }
  if (url.origin !== origin) return null;
  return url;
}

function isApexWwwVariant(first, second) {
  const stripWww = (host) => host.replace(/^www\./, '');
  return first !== second && stripWww(first) === stripWww(second)
    && (first.startsWith('www.') || second.startsWith('www.'));
}

function robotsGroups(body) {
  const groups = [];
  let current = null;
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    const directive = line.match(/^([a-z-]+)\s*:\s*(.*)$/i);
    if (!directive) continue;
    const key = directive[1].toLowerCase();
    const value = directive[2].trim();
    if (key === 'user-agent') {
      if (!current || current.rules.length || current.crawlDelayMs !== null) {
        current = { agents: [], rules: [], crawlDelayMs: null };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
    } else if (current && (key === 'allow' || key === 'disallow')) {
      if (value) current.rules.push({ allow: key === 'allow', path: value });
    } else if (current && key === 'crawl-delay') {
      const seconds = Number(value);
      if (Number.isFinite(seconds) && seconds >= 0) current.crawlDelayMs = Math.ceil(seconds * 1000);
    }
  }
  return groups;
}

function robotsPolicy(body) {
  const groups = robotsGroups(body);
  const agent = CRAWL_USER_AGENT.toLowerCase();
  const scored = groups.map((group) => ({
    group,
    score: Math.max(-1, ...group.agents.map((name) => name === '*' ? 0 : agent.includes(name) ? name.length : -1)),
  }));
  const highest = Math.max(-1, ...scored.map(({ score }) => score));
  const selected = highest < 0 ? [] : scored.filter(({ score }) => score === highest).map(({ group }) => group);
  const rules = selected.flatMap((group) => group.rules);
  const crawlDelayMs = Math.max(0, ...selected.map((group) => group.crawlDelayMs ?? 0));

  function allowed(url) {
    const path = `${url.pathname}${url.search}`;
    let winner = null;
    for (const rule of rules) {
      const anchor = rule.path.endsWith('$');
      const pattern = rule.path.replace(/\$$/, '').split('*')
        .map((part) => part.replace(/[|\\{}()[\]^$+?.]/g, '\\$&')).join('.*');
      if (!new RegExp(`^${pattern}${anchor ? '$' : ''}`).test(path)) continue;
      const length = rule.path.replace(/[*$]/g, '').length;
      if (!winner || length > winner.length || (length === winner.length && rule.allow)) {
        winner = { allow: rule.allow, length };
      }
    }
    return winner?.allow ?? true;
  }
  return { allowed, crawlDelayMs };
}

function linkedPages(html, base, origin) {
  const withoutInactive = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|template|noscript|svg)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ');
  const candidates = new Map();
  for (const match of withoutInactive.matchAll(/<a\b[^>]*>/gi)) {
    const tag = match[0];
    if (/\bnofollow\b/i.test(extractAttribute(tag, 'rel'))) continue;
    const href = decodeEntities(extractAttribute(tag, 'href'));
    if (!href || href.startsWith('#')) continue;
    const url = sameOriginUrl(href, origin, base);
    if (!url) continue;
    url.search = '';
    if (CRAWL_EXCLUDED_PATH.test(url.pathname) || CRAWL_FILE_EXTENSION.test(url.pathname)) continue;
    const following = withoutInactive.slice(match.index + tag.length, match.index + tag.length + 300);
    const anchorBody = following.match(/^([\s\S]*?)<\/a\s*>/i)?.[1] ?? '';
    const anchorText = normalizeText(anchorBody.replace(/<[^>]*>/g, ' '));
    const relevantLabel = /\b(?:services?|cleaning|repair|appointments?|booking|book|about|team|hours|faq|contact|locations?|areas?|what we do)\b/i.test(anchorText);
    if (url.pathname !== '/' && !CRAWL_LINK_PATH.test(url.pathname) && !relevantLabel) continue;
    const score = /\/services?(?:\/|$|-)/i.test(url.pathname) || /\bservices?\b/i.test(anchorText) ? 0
      : /\/about(?:-us)?(?:\/|$|-)/i.test(url.pathname) ? 1
        : /\/(?:locations?|service-areas?)(?:\/|$|-)/i.test(url.pathname) ? 2
          : /\/(?:faq|hours)(?:\/|$|-)/i.test(url.pathname) ? 3 : 4;
    candidates.set(url.toString(), { url, score });
    if (candidates.size >= CRAWL_MAX_CANDIDATES) break;
  }
  return [...candidates.values()].sort((a, b) => a.score - b.score).map(({ url }) => url);
}

async function fetchCrawlResource(requested, {
  allowCanonicalRedirect = false, allowed, deadline, lookup, maxAddressAttempts, maxBytes, maxRedirects, origin, signal, transport,
}) {
  let current = requested;
  let transferredBytes = 0;
  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
    if (signal.aborted || Date.now() >= deadline) fail('timeout', 'The website took too long to respond.', 504);
    if (transferredBytes >= maxBytes) fail('response_too_large', 'The website page is too large to inspect.', 413);
    if (!allowed(current)) fail('robots_disallowed', 'The website does not permit this page to be inspected.', 422);
    const pinnedAddresses = await resolvePublicAddresses(current.hostname, lookup);
    if (signal.aborted) fail('timeout', 'The website took too long to respond.', 504);
    let response;
    let lastError;
    for (const pinned of pinnedAddresses.slice(0, maxAddressAttempts)) {
      try {
        response = await transport(current, {
          ...pinned,
          maxBytes: maxBytes - transferredBytes,
          signal,
          timeoutMs: Math.min(CRAWL_MAX_REQUEST_MS, Math.max(1, deadline - Date.now())),
        });
        break;
      } catch (error) {
        if (error instanceof InspectionError) throw error;
        lastError = error;
      }
    }
    if (!response) {
      if (signal.aborted) fail('timeout', 'The website took too long to respond.', 504);
      if (lastError) fail('fetch_failed', 'The website could not be reached securely.', 502);
      fail('fetch_failed', 'The website could not be reached securely.', 502);
    }
    if (signal.aborted) fail('timeout', 'The website took too long to respond.', 504);
    const body = Buffer.isBuffer(response.body) ? response.body : Buffer.from(response.body ?? '');
    if (body.length > maxBytes - transferredBytes) fail('response_too_large', 'The website page is too large to inspect.', 413);
    transferredBytes += body.length;
    const headers = normalizeHeaders(response.headers);
    const statusCode = Number(response.statusCode) || 0;
    if (REDIRECT_STATUSES.has(statusCode)) {
      if (redirectCount === maxRedirects) fail('too_many_redirects', 'The website redirected too many times.', 422);
      if (!headers.location) fail('invalid_redirect', 'The website returned an invalid redirect.', 422);
      let destination;
      try {
        destination = validateInspectionUrl(new URL(headers.location, current).toString());
      } catch {
        fail('cross_origin_redirect', 'The website redirected outside its domain or to an unsafe URL.', 422);
      }
      if (destination.origin !== origin) {
        if (allowCanonicalRedirect && isApexWwwVariant(current.hostname, destination.hostname)) {
          return { canonicalRedirect: destination, redirectsUsed: redirectCount + 1, transferredBytes };
        }
        fail('cross_origin_redirect', 'The website redirected outside its domain or to an unsafe URL.', 422);
      }
      current = destination;
      continue;
    }
    return { body, finalUrl: current, headers, statusCode, transferredBytes };
  }
  fail('too_many_redirects', 'The website redirected too many times.', 422);
}

/** Bounded, same-origin HTML discovery for source-bearing business preparation. */
export async function crawlWebsite(input, options = {}) {
  const requested = validateInspectionUrl(input);
  let origin = requested.origin;
  const maxPages = boundedCrawlOption(options.maxPages, CRAWL_MAX_PAGES, CRAWL_MAX_PAGES);
  const maxTotalBytes = boundedCrawlOption(options.maxTotalBytes, CRAWL_MAX_TOTAL_BYTES, CRAWL_MAX_TOTAL_BYTES);
  const maxResponseBytes = boundedCrawlOption(options.maxResponseBytes, CRAWL_MAX_RESPONSE_BYTES, CRAWL_MAX_RESPONSE_BYTES);
  const maxRobotsBytes = boundedCrawlOption(options.maxRobotsBytes, CRAWL_MAX_ROBOTS_BYTES, CRAWL_MAX_ROBOTS_BYTES);
  const maxDurationMs = boundedCrawlOption(options.maxDurationMs, CRAWL_MAX_DURATION_MS, CRAWL_MAX_DURATION_MS);
  const maxRedirects = boundedCrawlOption(options.maxRedirects, 5, 5);
  const maxAddressAttempts = boundedCrawlOption(options.maxAddressAttempts, DEFAULT_MAX_ADDRESS_ATTEMPTS, DEFAULT_MAX_ADDRESS_ATTEMPTS);
  const excerptLength = boundedCrawlOption(options.excerptLength, 6_000, 8_000);
  const lookup = options.lookup ?? dnsLookup;
  const transport = options.transport ?? defaultTransport;

  return withTimeout(async (signal) => {
    const startedAt = Date.now();
    const deadline = Date.now() + maxDurationMs;
    let bytes = 0;
    let switchedOrigin = false;
    let startUrl = requested;
    async function loadRobots() {
      while (true) {
        const robotsUrl = new URL('/robots.txt', origin);
        const robots = await fetchCrawlResource(robotsUrl, {
          allowCanonicalRedirect: !switchedOrigin,
          allowed: () => true,
          deadline,
          lookup,
          maxAddressAttempts,
          maxBytes: Math.min(maxRobotsBytes, maxTotalBytes - bytes),
          maxRedirects,
          origin,
          signal,
          transport,
        });
        bytes += robots.transferredBytes;
        if (robots.canonicalRedirect) {
          switchedOrigin = true;
          origin = robots.canonicalRedirect.origin;
          startUrl = new URL(`${requested.pathname}${requested.search}`, origin);
          continue;
        }
        if (robots.statusCode === 404 || robots.statusCode === 410) {
          return { allowed: () => true, crawlDelayMs: 0 };
        }
        if (robots.statusCode !== 200) fail('robots_unavailable', 'The website crawling policy could not be read.', 422);
        const type = robots.headers['content-type']?.split(';', 1)[0].trim().toLowerCase();
        if (type && type !== 'text/plain') fail('robots_unavailable', 'The website crawling policy could not be read.', 422);
        const encoding = robots.headers['content-encoding']?.trim().toLowerCase();
        if (encoding && encoding !== 'identity') fail('robots_unavailable', 'The website crawling policy could not be read.', 422);
        const body = robots.body.toString('utf8').replace(/^\uFEFF/, '');
        if (body.includes('\0') || body.includes('\uFFFD')) fail('robots_unavailable', 'The website crawling policy could not be read.', 422);
        return robotsPolicy(body);
      }
    }
    let policy = await loadRobots();
    if (!policy.allowed(startUrl)) fail('robots_disallowed', 'The website does not permit this page to be inspected.', 422);

    const queue = [startUrl];
    const seen = new Set();
    const pages = [];
    let remainingInitialRedirects = maxRedirects;
    let lastFetchAt = 0;
    while (queue.length && pages.length < maxPages) {
      const url = queue.shift();
      if (seen.has(url.toString())) continue;
      seen.add(url.toString());
      if (!policy.allowed(url)) continue;
      if (bytes >= maxTotalBytes) break;
      const delay = lastFetchAt + policy.crawlDelayMs - Date.now();
      if (delay > 0) {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, delay);
          signal.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new InspectionError('timeout', 'The website took too long to respond.', 504));
          }, { once: true });
        });
      }
      lastFetchAt = Date.now();
      let fetched;
      try {
        fetched = await fetchCrawlResource(url, {
          allowCanonicalRedirect: pages.length === 0 && !switchedOrigin,
          allowed: policy.allowed,
          deadline,
          lookup,
          maxAddressAttempts,
          maxBytes: Math.min(maxResponseBytes, maxTotalBytes - bytes),
          maxRedirects: pages.length === 0 ? remainingInitialRedirects : maxRedirects,
          origin,
          signal,
          transport,
        });
      } catch (error) {
        if (pages.length && error instanceof InspectionError && [
          'site_restricted', 'upstream_status', 'unsupported_content_type', 'empty_page', 'robots_disallowed',
        ].includes(error.code)) continue;
        throw error;
      }
      bytes += fetched.transferredBytes;
      if (fetched.canonicalRedirect) {
        remainingInitialRedirects -= fetched.redirectsUsed;
        switchedOrigin = true;
        origin = fetched.canonicalRedirect.origin;
        startUrl = fetched.canonicalRedirect;
        policy = await loadRobots();
        if (!policy.allowed(startUrl)) fail('robots_disallowed', 'The website does not permit this page to be inspected.', 422);
        queue.length = 0;
        queue.push(startUrl);
        seen.clear();
        continue;
      }
      if (fetched.statusCode === 401 || fetched.statusCode === 403) {
        if (pages.length) continue;
        fail('site_restricted', 'That website is not allowing us to read it. Try another public page from your business.', 422);
      }
      if (fetched.statusCode < 200 || fetched.statusCode >= 300) {
        if (pages.length) continue;
        fail('upstream_status', 'The website did not return a page that can be inspected.', 422);
      }
      const type = fetched.headers['content-type']?.split(';', 1)[0].trim().toLowerCase();
      if (type !== 'text/html' && type !== 'application/xhtml+xml') {
        if (pages.length) continue;
        fail('unsupported_content_type', 'The URL does not point to an HTML page.', 415);
      }
      const encoding = fetched.headers['content-encoding']?.trim().toLowerCase();
      if (encoding && encoding !== 'identity') fail('unsupported_content_encoding', 'The website returned an unsupported page encoding.', 415);
      const html = fetched.body.toString('utf8');
      const page = extractPage(html, excerptLength);
      if (!page.title && !page.description && !page.excerpt) {
        if (pages.length) continue;
        fail('empty_page', 'The website page did not contain readable information.', 422);
      }
      pages.push({ requestedUrl: url.toString(), finalUrl: fetched.finalUrl.toString(), ...page });
      for (const candidate of linkedPages(html, fetched.finalUrl, origin)) {
        if (!seen.has(candidate.toString()) && !queue.some((pending) => pending.toString() === candidate.toString())) {
          queue.push(candidate);
        }
        if (queue.length >= CRAWL_MAX_CANDIDATES) break;
      }
    }
    return {
      requestedUrl: requested.toString(),
      origin,
      pages,
      limits: { pages: pages.length, maxPages, bytes, maxTotalBytes, elapsedMs: Date.now() - startedAt, maxDurationMs },
    };
  }, maxDurationMs);
}

export async function inspectWebsite(input, options = {}) {
  const {
    excerptLength = DEFAULT_EXCERPT_LENGTH,
    lookup = dnsLookup,
    maxAddressAttempts = DEFAULT_MAX_ADDRESS_ATTEMPTS,
    maxBytes = DEFAULT_MAX_BYTES,
    maxRedirects = DEFAULT_MAX_REDIRECTS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    transport = defaultTransport,
  } = options;
  const requested = validateInspectionUrl(input);
  return withTimeout(async (signal) => {
    let current = requested;

    for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
      if (signal.aborted) fail('timeout', 'The website took too long to respond.', 504);
      const pinnedAddresses = await resolvePublicAddresses(current.hostname, lookup);
      if (signal.aborted) fail('timeout', 'The website took too long to respond.', 504);
      let response;
      try {
        response = await (async () => {
          let lastError;
          for (const pinned of pinnedAddresses.slice(0, Math.max(1, maxAddressAttempts))) {
            if (signal.aborted) fail('timeout', 'The website took too long to respond.', 504);
            try {
              return await transport(current, {
                ...pinned,
                maxBytes,
                signal,
                timeoutMs,
              });
            } catch (error) {
              if (error instanceof InspectionError) throw error;
              lastError = error;
            }
          }
          throw lastError ?? new Error('No public address could be reached.');
        })();
      } catch (error) {
        if (error instanceof InspectionError) throw error;
        fail('fetch_failed', 'The website could not be reached securely.', 502);
      }
      if (signal.aborted) fail('timeout', 'The website took too long to respond.', 504);

      const statusCode = Number(response?.statusCode) || 0;
      const headers = normalizeHeaders(response?.headers);
      if (REDIRECT_STATUSES.has(statusCode)) {
        if (redirectCount === maxRedirects) {
          fail('too_many_redirects', 'The website redirected too many times.', 422);
        }
        if (!headers.location) {
          fail('invalid_redirect', 'The website returned an invalid redirect.', 422);
        }
        let redirectUrl;
        try {
          redirectUrl = new URL(headers.location, current);
        } catch {
          fail('invalid_redirect', 'The website returned an invalid redirect.', 422);
        }
        current = validateInspectionUrl(redirectUrl.toString());
        continue;
      }

      if (statusCode === 401 || statusCode === 403) {
        fail('site_restricted', 'That website is not allowing us to read it. Try another public page from your business.', 422);
      }
      if (statusCode < 200 || statusCode >= 300) {
        fail('upstream_status', 'The website did not return a page that can be inspected.', 422);
      }

      const contentType = headers['content-type']?.split(';', 1)[0].trim().toLowerCase();
      if (contentType !== 'text/html' && contentType !== 'application/xhtml+xml') {
        fail('unsupported_content_type', 'The URL does not point to an HTML page.', 415);
      }
      const contentEncoding = headers['content-encoding']?.trim().toLowerCase();
      if (contentEncoding && contentEncoding !== 'identity') {
        fail('unsupported_content_encoding', 'The website returned an unsupported page encoding.', 415);
      }

      const body = Buffer.isBuffer(response.body) ? response.body : Buffer.from(response.body ?? '');
      if (body.length > maxBytes) {
        fail('response_too_large', 'The website page is too large to inspect.', 413);
      }
      const page = extractPage(body.toString('utf8'), Math.min(Math.max(1, excerptLength), 2_000));
      if (!page.title && !page.description && !page.excerpt) {
        fail('empty_page', 'The website page did not contain readable information.', 422);
      }

      return {
        requestedUrl: requested.toString(),
        finalUrl: current.toString(),
        ...page,
      };
    }

    fail('too_many_redirects', 'The website redirected too many times.', 422);
  }, timeoutMs);
}

async function readJsonBody(request) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_REQUEST_BYTES) {
      fail('request_too_large', 'The request body is too large.', 413);
    }
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    fail('invalid_json', 'Send a JSON body with a website URL.', 400);
  }
}

function sendJson(response, statusCode, payload, headers = {}) {
  response.writeHead(statusCode, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    ...headers,
  });
  response.end(JSON.stringify(payload));
}

export function createInspectHandler(options = {}) {
  return async function inspectHandler(request, response) {
    if (request.method !== 'POST') {
      response.setHeader?.('allow', 'POST');
      sendJson(response, 405, { error: 'method_not_allowed', message: 'Use POST for website inspection.' });
      return;
    }

    const contentTypeHeader = request.headers?.['content-type'];
    const contentType = (Array.isArray(contentTypeHeader) ? contentTypeHeader[0] : contentTypeHeader ?? '')
      .split(';', 1)[0]
      .trim()
      .toLowerCase();
    if (contentType !== 'application/json') {
      sendJson(response, 415, { error: 'unsupported_media_type', message: 'Send the website URL as application/json.' });
      return;
    }

    try {
      const body = await readJsonBody(request);
      const result = await inspectWebsite(body?.url, options);
      sendJson(response, 200, result);
    } catch (error) {
      if (error instanceof InspectionError) {
        sendJson(response, error.status, { error: error.code, message: error.message });
        return;
      }
      sendJson(response, 500, { error: 'inspection_failed', message: 'The website could not be inspected.' });
    }
  };
}

export function createInspectionGate(options = {}) {
  const handler = options.handler ?? handleInspectRequest;
  const maxConcurrent = options.maxConcurrent ?? 8;
  const maxConcurrentPerClient = options.maxConcurrentPerClient ?? 1;
  const maxRequests = options.maxRequests ?? 6;
  const maxTrackedClients = options.maxTrackedClients ?? 10_000;
  const now = options.now ?? Date.now;
  const windowMs = options.windowMs ?? 60_000;
  const clients = new Map();
  let inFlight = 0;

  return async function gatedInspection(request, response) {
    const timestamp = now();
    const clientKey = request.socket?.remoteAddress ?? 'unknown';
    let client = clients.get(clientKey);
    if (!client || timestamp - client.windowStart >= windowMs) {
      if (!client && clients.size >= maxTrackedClients) {
        for (const [key, tracked] of clients) {
          if (tracked.inFlight === 0 && timestamp - tracked.windowStart >= windowMs) clients.delete(key);
        }
      }
      if (!client && clients.size >= maxTrackedClients) {
        sendJson(response, 429, { error: 'rate_limited', message: 'Too many website checks. Try again shortly.' }, { 'retry-after': '60' });
        return;
      }
      client = { count: 0, inFlight: 0, windowStart: timestamp };
      clients.set(clientKey, client);
    }

    if (client.count >= maxRequests) {
      const retryAfter = Math.max(1, Math.ceil((client.windowStart + windowMs - timestamp) / 1000));
      sendJson(response, 429, { error: 'rate_limited', message: 'Too many website checks. Try again shortly.' }, { 'retry-after': String(retryAfter) });
      return;
    }
    if (client.inFlight >= maxConcurrentPerClient || inFlight >= maxConcurrent) {
      sendJson(response, 429, { error: 'inspection_busy', message: 'A website check is already running. Try again shortly.' }, { 'retry-after': '2' });
      return;
    }

    client.count += 1;
    client.inFlight += 1;
    inFlight += 1;
    try {
      await handler(request, response);
    } finally {
      client.inFlight -= 1;
      inFlight -= 1;
      if (timestamp - client.windowStart >= windowMs && client.inFlight === 0) clients.delete(clientKey);
    }
  };
}

export const handleInspectRequest = createInspectHandler();
