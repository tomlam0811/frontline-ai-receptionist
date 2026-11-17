import { validateInspectionUrl } from './website-inspection.js';

const EXA_CONTENTS_URL = 'https://api.exa.ai/contents';
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const MAX_PAGES = 10;
const MAX_PAGE_CHARACTERS = 12_000;
const MAX_TOTAL_CHARACTERS = MAX_PAGES * MAX_PAGE_CHARACTERS;
const EXA_TIMEOUT_MS = 30_000;
// The durable preparation queue owns retries (three total attempts per job).
const EXA_MAX_ATTEMPTS = 1;
// PostgreSQL jsonb cannot store U+0000. Remove it at the untrusted source
// boundary so citations and model inputs use the same safe text we persist.
const researchText = (value) => value.replaceAll('\u0000', '');

export class ExaResearchError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ExaResearchError';
    this.code = code;
  }
}

function sameBusinessHost(requested, candidate) {
  return requested.hostname.replace(/^www\./, '') === candidate.hostname.replace(/^www\./, '');
}

async function boundedJson(response) {
  const reader = response.body?.getReader();
  if (!reader) throw new ExaResearchError('exa_invalid_response', 'Exa returned no response body.');
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new ExaResearchError('exa_response_too_large', 'Exa returned too much content.');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new ExaResearchError('exa_invalid_response', 'Exa returned invalid JSON.'); }
}

/** Fetch only the submitted website and its relevant pages through Exa. */
export async function researchWebsiteWithExa(input, options = {}) {
  const requested = validateInspectionUrl(input);
  const apiKey = options.apiKey ?? process.env.EXA_API_KEY;
  if (!apiKey) throw new ExaResearchError('exa_not_configured', 'Exa is not configured for business research.');

  const fetcher = options.fetch ?? fetch;
  let response;
  for (let attempt = 0; attempt < EXA_MAX_ATTEMPTS; attempt += 1) {
    try {
      response = await fetcher(EXA_CONTENTS_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify({
        urls: [requested.toString()],
        text: { maxCharacters: MAX_PAGE_CHARACTERS },
        maxAgeHours: 0,
        livecrawlTimeout: 15_000,
        subpages: MAX_PAGES - 1,
        subpageTarget: ['services', 'hours', 'contact', 'about', 'locations', 'faq'],
      }),
        signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(EXA_TIMEOUT_MS)]) : AbortSignal.timeout(EXA_TIMEOUT_MS),
      });
      if (response.ok || ![408, 429, 500, 502, 503, 504].includes(response.status) || attempt === EXA_MAX_ATTEMPTS - 1) break;
    } catch {
      if (attempt === EXA_MAX_ATTEMPTS - 1) throw new ExaResearchError('exa_unavailable', 'Exa could not retrieve this website.');
    }
  }
  if (!response.ok) {
    const code = response.status === 429 ? 'exa_rate_limited' : response.status === 401 || response.status === 402
      ? 'exa_account_unavailable' : 'exa_unavailable';
    throw new ExaResearchError(code, 'Exa could not retrieve this website.');
  }

  const payload = await boundedJson(response);
  if (!Array.isArray(payload.results)) throw new ExaResearchError('exa_invalid_response', 'Exa returned an invalid result.');

  const pages = [];
  const seen = new Set();
  let admittedCharacters = 0;
  let origin = requested.origin;
  // Contents returns requested pages at the top level and discovered pages
  // under each result. Apply the same source checks to both shapes.
  const candidates = payload.results.flatMap((result) => [
    result, ...(Array.isArray(result?.subpages) ? result.subpages : []),
  ]);
  for (const result of candidates) {
    if (pages.length >= MAX_PAGES) break;
    let source;
    try { source = validateInspectionUrl(result?.url); }
    catch { continue; }
    if (!sameBusinessHost(requested, source)) continue;
    if (!pages.length) origin = source.origin;
    if (source.origin !== origin || seen.has(source.toString())) continue;
    if (typeof result.text !== 'string' || !researchText(result.text).trim()) continue;
    const remaining = MAX_TOTAL_CHARACTERS - admittedCharacters;
    if (remaining <= 0) break;
    const excerpt = researchText(result.text).trim().slice(0, Math.min(MAX_PAGE_CHARACTERS, remaining));
    if (!excerpt) continue;
    seen.add(source.toString());
    admittedCharacters += excerpt.length;
    pages.push({
      finalUrl: source.toString(),
      title: typeof result.title === 'string' ? researchText(result.title).slice(0, 200) : '',
      description: '',
      excerpt,
      retrievedAt: new Date(options.now?.() ?? Date.now()).toISOString(),
    });
  }
  return {
    requestedUrl: requested.toString(), origin, pages, provider: 'exa', requestId: payload.requestId ?? null,
    retrieval: { state: pages.length ? 'retrieved' : 'missing', discoveredCount: candidates.length, admittedCount: pages.length, characterCount: admittedCharacters, exhaustive: false },
  };
}
