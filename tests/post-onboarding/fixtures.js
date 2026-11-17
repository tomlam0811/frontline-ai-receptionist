import { Readable } from 'node:stream';
import { randomBytes, randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { fromPglite } from '../../server/api/post-onboarding/database.js';
import { createOwnerResolver } from '../../server/api/post-onboarding/owner-context.js';
import { createPostOnboardingHandler } from '../../server/api/post-onboarding/routes.js';
import { DEFAULT_GUEST_CONFIG } from '../../server/api/post-onboarding/guest.js';
import { compileGroupedProfile } from '../../server/research/grouped-profile.js';

export const hash = (value) => createHash('sha256').update(value).digest('hex');
export const hex64 = () => randomBytes(32).toString('hex');

/** Runs fn as the database owner (fixture setup, backdating rows), then returns to the runtime role. */
export async function asOwner(db, fn) {
  await db.exec('RESET ROLE');
  try { return await fn(); } finally { await db.exec('SET ROLE frontline_app'); }
}

/** Rows a real claim would leave behind: tenant scope, membership, session, claimed target, agent state. */
export const seedClaimedOwner = (db, options) => asOwner(db, () => insertClaimedOwner(db, options));
async function insertClaimedOwner(db, { subject = `google:${randomUUID().slice(0, 12)}`, researched = false } = {}) {
  const scopeId = randomUUID();
  const agentId = randomUUID();
  const workspaceId = scopeId;
  const authToken = hex64();
  const tenant = (await db.query('INSERT INTO frontline_tenants DEFAULT VALUES RETURNING id')).rows[0].id;
  await db.query("INSERT INTO ownership_scopes(id, kind, secret_hash, state, expires_at, tenant_id) VALUES ($1,'tenant',$2,'claimed',NULL,$3)", [scopeId, hex64(), tenant]);
  await db.query("INSERT INTO frontline_memberships(tenant_id, provider_subject, role) VALUES ($1,$2,'owner')", [tenant, subject]);
  await db.query("INSERT INTO frontline_auth_sessions(secret_hash, provider_subject, provider_session_id, expires_at) VALUES ($1,$2,'google-oidc', now() + interval '1 hour')", [hash(authToken), subject]);
  await db.query("INSERT INTO frontline_claimed_targets(target_kind, target_id, owner_scope_id, tenant_id) VALUES ('agent',$1,$2,$3)", [agentId, scopeId, tenant]);
  const state = {
    workspaces: { [workspaceId]: { id: workspaceId, state: 'claimed' } },
    agents: { [agentId]: { id: agentId, workspaceId, knowledgeRevisionId: randomUUID(), createdAt: new Date().toISOString() } },
    preparations: { [randomUUID()]: { agentVersionId: agentId, profile: { businessName: 'Riverside Dental' } } },
    knowledge: { secret: { facts: ['PRIVATE-KNOWLEDGE-SENTINEL'] } },
    demos: {},
  };
  if (researched) addResearch(state, agentId, workspaceId);
  await db.query('INSERT INTO scoped_workspace_states(owner_scope_id, state) VALUES ($1,$2::jsonb)', [scopeId, JSON.stringify(state)]);
  return { subject, scopeId, agentId, authToken, tenant, state };
}

/**
 * Website research as the onboarding flow leaves it: passages, accepted facts (shaped like admitExtractedFacts output),
 * the grouped profile from the real compiler, and the legacy fact list. Stable ids so tests can name entries.
 */
export const RESEARCH_IDS = { hours: 'f-hours', service: 'f-service-clean', service2: 'f-service-fill', name: 'f-name', unknown: 'f-price' };
function addResearch(state, agentId, workspaceId) {
  const url = 'https://riverside.example/about';
  const passages = [{ passageId: 'p1', text: 'Riverside Dental. Open Monday to Friday 9am to 5pm. Teeth cleaning and fillings. Cleaning is $80.', source: { sourceId: 'src-p1', url, retrievedAt: '2026-09-01T00:00:00.000Z' } }];
  const fact = (factId, group, value, extra = {}) => ({ factId, group, value, passageIds: ['p1'], applicableServiceIds: [], applicableLocationIds: [], eligibility: 'eligible', eligibilityReason: null, observedAt: '2026-09-01T00:00:00.000Z', ...extra });
  const groupedFacts = [
    fact(RESEARCH_IDS.name, 'identity_contact', 'Riverside Dental'), fact(RESEARCH_IDS.hours, 'office_hours', 'Monday to Friday 9am to 5pm'),
    fact(RESEARCH_IDS.service, 'services', 'Teeth cleaning'), fact(RESEARCH_IDS.service2, 'services', 'Fillings'),
    fact(RESEARCH_IDS.unknown, 'pricing_quote_policy', 'Cleaning is $80', { eligibility: 'unknown', eligibilityReason: 'stale_source' }),
  ];
  const profile = compileGroupedProfile(groupedFacts, passages, '2026-09-01T00:00:00.000Z');
  const knowledgeId = profile.knowledgeRevisionId;
  const legacy = (predicate, value) => ({ id: `legacy-${predicate}-${value}`, predicate, value, sourceUrl: url, evidence: passages[0].text, status: 'eligible_for_demo' });
  state.knowledge[knowledgeId] = {
    id: knowledgeId, workspaceId, facts: [legacy('business_name', 'Riverside Dental'), legacy('hours', 'Monday to Friday 9am to 5pm'), legacy('service', 'Teeth cleaning'), legacy('service', 'Fillings')],
    groupedFacts, groupedProfile: JSON.parse(JSON.stringify(profile)), classifiedPassages: passages, sources: [], expiresAt: null,
  };
  Object.assign(state.agents[agentId], { knowledgeRevisionId: knowledgeId, profileRevisionId: profile.profileRevisionId, capabilityManifest: { knowledgeCoverage: 'sourced', actionReadiness: 'intake_only', capabilities: [], limits: [], workflowCapabilities: profile.capabilities, profileRevisionId: profile.profileRevisionId }, expiresAt: null });
}

/** A signed-in person who is not a claimed owner (for builder and cross-owner tests). */
export const seedSession = (db, options) => asOwner(db, () => insertSession(db, options));
async function insertSession(db, { subject = `google:${randomUUID().slice(0, 12)}`, builder = false } = {}) {
  const authToken = hex64();
  await db.query("INSERT INTO frontline_auth_sessions(secret_hash, provider_subject, provider_session_id, expires_at) VALUES ($1,$2,'google-oidc', now() + interval '1 hour')", [hash(authToken), subject]);
  if (builder) await db.query('INSERT INTO frontline_builder_subjects(provider_subject, note) VALUES ($1,$2) ON CONFLICT DO NOTHING', [subject, 'test']);
  return { subject, authToken };
}

/**
 * The real request handler and the real database, driven without a network socket
 * (some sandboxes forbid binding ports). `fetch` builds a Node request from the same
 * inputs a browser or CLI sends and returns a standard Response.
 */
/** @param {any} pglite @param {Record<string, any>} [options] context overrides for the handler; `enabled` toggles the feature flag */
export function startServer(pglite, { enabled = true, ...context } = {}) {
  const db = fromPglite(pglite);
  const handler = createPostOnboardingHandler({ enabled: () => enabled, db, owner: createOwnerResolver({ db }), appBaseUrl: 'http://frontline.test', guestConfig: { ...DEFAULT_GUEST_CONFIG, dailyCapCents: 10_000, reservedCents: 100, globalConcurrent: 5 }, ...context });
  const baseUrl = 'http://frontline.test';
  async function appFetch(input, init = {}) {
    const url = new URL(String(input), baseUrl);
    const body = init.body == null ? [] : [Buffer.from(init.body)];
    const headers = Object.fromEntries(Object.entries({ host: url.host, ...(init.headers ?? {}) }).map(([key, value]) => [key.toLowerCase(), String(value)]));
    const request = Object.assign(Readable.from(body), { method: init.method ?? 'GET', headers, url: url.pathname + url.search, socket: { remoteAddress: '127.0.0.1' } });
    let status; let responseHeaders; const chunks = [];
    const done = new Promise((resolve) => {
      const response = { writeHead(code, hdrs) { status = code; responseHeaders = hdrs; }, end(chunk) { if (chunk) chunks.push(Buffer.from(chunk)); resolve(); } };
      Promise.resolve(handler(request, response, url)).then((handled) => { if (!handled) { status = 404; responseHeaders = {}; resolve(); } });
    });
    await done;
    return new Response(status === 204 ? null : Buffer.concat(chunks), { status, headers: responseHeaders });
  }
  return { baseUrl, fetch: appFetch, idle: () => handler.idle(), close: async () => {} };
}

/** A browser-like client: cookie jar for fl_auth and the CSRF double-submit pair. */
export function browserClient(app, authToken) {
  const csrf = hex64();
  /** @param {string} method @param {string} path @param {{body?: unknown, headers?: Record<string, string>}} [options] */
  const request = (method, path, { body, headers = {} } = {}) => app.fetch(`${app.baseUrl}${path}`, {
    method,
    headers: { origin: app.baseUrl, cookie: `${authToken ? `fl_auth=${authToken}; ` : ''}fl_csrf=${csrf}`, 'x-frontline-csrf': csrf, ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { request, csrf };
}

export const bearer = (app, token) => (method, path, body) => app.fetch(`${app.baseUrl}${path}`, {
  method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined,
});

/**
 * Stand-in for the paid LiveKit provider only. It records calls and can fail on demand;
 * the database, handler and share/guest logic around it are real.
 */
/** @param {{failStart?: boolean, failEnd?: boolean}} [options] */
export function fakeVoice({ failStart = false, failEnd = false } = {}) {
  const voice = {
    started: [], ended: [], tokens: 0, failStart, failEnd,
    isConfigured: () => true,
    async start(demo) {
      voice.started.push(demo.id);
      if (voice.failStart) throw new Error('provider down');
      return { roomName: demo.roomName, participantIdentity: `visitor-${demo.id}`, participantToken: `token-${voice.started.length}`, livekitUrl: 'wss://voice.test', dispatchId: `dispatch-${voice.started.length}`, tokenExpiresAt: new Date(Date.now() + 5 * 60_000).toISOString() };
    },
    async end(demo) { voice.ended.push(demo.id); if (voice.failEnd) throw new Error('cannot delete room'); },
    async issueParticipantToken() { voice.tokens += 1; return { livekitUrl: 'wss://voice.test', participantToken: `reconnect-${voice.tokens}`, tokenExpiresAt: new Date(Date.now() + 5 * 60_000).toISOString() }; },
  };
  return voice;
}
