import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { problem } from './errors.js';
import { schemaVersion } from '../contracts.js';

// Behavioral mirrors of the request helpers in server/api/service.js (which does
// not export them). tests/post-onboarding/http.test.js pins the behavior so that
// connection (PO-C14) can swap these for the shared helpers without drift.
export const sha256 = (value) => createHash('sha256').update(value).digest('hex');
export const safeEqual = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export function parseCookies(request) {
  return Object.fromEntries(String(request.headers.cookie ?? '').split(';').map((entry) => entry.trim().split(/=(.*)/s).slice(0, 2)).filter(([key]) => key));
}

export async function readJson(request, { maxBytes = 16_384 } = {}) {
  if (!String(request.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) throw problem(415, 'unsupported_media_type', 'Send application/json.');
  let total = 0;
  const chunks = [];
  for await (const chunk of request) {
    total += chunk.length;
    if (total > maxBytes) throw problem(413, 'body_too_large', 'Request body is too large.');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw problem(400, 'invalid_json', 'Send valid JSON.'); }
}

export function originGuard(request, allowMissing = false) {
  const host = request.headers.host;
  const origin = request.headers.origin;
  if (!host) throw problem(403, 'origin_required', 'Host is required.');
  if (!origin && allowMissing) {
    const fetchSite = request.headers['sec-fetch-site'];
    if (fetchSite && !['same-origin', 'none'].includes(fetchSite)) throw problem(403, 'origin_mismatch', 'Request must come from this application.');
    return;
  }
  if (!origin) throw problem(403, 'origin_required', 'Origin is required.');
  let parsed;
  try { parsed = new URL(origin); } catch { throw problem(403, 'invalid_origin', 'Origin is invalid.'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.origin === 'null') throw problem(403, 'invalid_origin', 'Origin is invalid.');
  const allowed = [process.env.APP_BASE_URL, ...String(process.env.FRONTLINE_ALLOWED_ORIGINS ?? '').split(',')].map((value) => value?.trim()).filter(Boolean);
  if (allowed.length) {
    const matches = allowed.some((value) => { try { return parsed.origin === new URL(value).origin; } catch { return false; } });
    if (!matches) throw problem(403, 'origin_mismatch', 'Origin does not match this application.');
  } else if (parsed.host !== host) throw problem(403, 'origin_mismatch', 'Origin does not match this application.');
}

export function csrfGuard(request) {
  originGuard(request, request.method === 'GET');
  const csrf = parseCookies(request).fl_csrf;
  if (!csrf || !safeEqual(csrf, request.headers['x-frontline-csrf'])) throw problem(403, 'csrf_failed', 'Refresh the page and try again.');
}

export function sendJson(response, status, data, requestId = randomUUID(), headers = {}) {
  response.writeHead(status, { 'cache-control': 'no-store', 'content-type': 'application/json; charset=utf-8', 'x-content-type-options': 'nosniff', 'x-request-id': requestId, ...headers });
  response.end(JSON.stringify({ ...data, requestId, version: schemaVersion }));
}

// Fields a client needs to recover from a specific conflict (technical spec, Endpoint contracts).
function problemExtras(error) {
  const extras = {};
  if (Number.isInteger(error?.currentPointerGeneration)) extras.currentPointerGeneration = error.currentPointerGeneration;
  if (typeof error?.currentAgentVersionId === 'string') extras.currentAgentVersionId = error.currentAgentVersionId;
  if (typeof error?.candidateId === 'string') extras.candidateId = error.candidateId;
  if (typeof error?.detailCode === 'string') extras.code = error.detailCode;
  return extras;
}

export function sendProblem(response, error, requestId = randomUUID()) {
  const status = Number.isInteger(error?.status) ? error.status : 500;
  const code = Number.isInteger(error?.status) && error?.code ? error.code : 'internal_error';
  const headers = { 'content-type': 'application/problem+json; charset=utf-8' };
  if (status === 429) headers['retry-after'] = String(error.retryAfter ?? 60);
  sendJson(response, status, {
    type: `https://frontline.invalid/problems/${code}`, title: code,
    detail: status >= 500 ? 'The request could not be completed.' : error.message, status,
    ...(typeof error?.reason === 'string' && status < 500 ? { reason: error.reason } : {}),
    ...(status < 500 ? problemExtras(error) : {}),
  }, requestId, headers);
}

// Per-process request budget. The database-backed limits are the authoritative
// controls; this only softens bursts, as the technical spec states.
/** @param {{limit: number, windowMs?: number, now?: () => number}} options */
export function createRateLimiter({ limit, windowMs = 60_000, now = Date.now }) {
  const hits = new Map();
  return (key) => {
    const time = now();
    const recent = (hits.get(key) ?? []).filter((at) => time - at < windowMs);
    if (recent.length >= limit) {
      hits.set(key, recent);
      throw Object.assign(problem(429, 'rate_limited', 'Too many requests. Try again shortly.'), { retryAfter: Math.ceil((windowMs - (time - recent[0])) / 1000) });
    }
    recent.push(time);
    hits.set(key, recent);
    if (hits.size > 5000) for (const [k, v] of hits) if (!v.some((at) => time - at < windowMs)) hits.delete(k);
  };
}
