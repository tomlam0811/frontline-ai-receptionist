import { readDemo, updateDemo } from '../../server/api/post-onboarding/demo-store.js';
import { fromPglite, inOwnerScope } from '../../server/api/post-onboarding/database.js';
import { createOwnerResolver } from '../../server/api/post-onboarding/owner-context.js';
import { createPostOnboardingHandler } from '../../server/api/post-onboarding/routes.js';
import { DEFAULT_GUEST_CONFIG } from '../../server/api/post-onboarding/guest.js';
import { createMigratedDatabase } from '../../tests/post-onboarding/database.js';
import { seedClaimedOwner } from '../../tests/post-onboarding/fixtures.js';
import { addReceptionist } from '../../tests/post-onboarding/ui-helpers.js';
import { seedConversations } from '../../tests/post-onboarding/ui-conversations-fixtures.js';
import { heuristicExtract } from './heuristic-extractor.mjs';
import { devConversationSeeds } from './conversations.mjs';
import { randomBytes } from 'node:crypto';

// Serves the new owner and guest screens against the real request handler and a real (in-process) Postgres with
// the real migrations. Only the paid voice provider and the text-reading model are stand-ins, and the sign-in is
// a development shortcut: open /dev/login to become the seeded owner. Nothing here runs in production.

const DEV_FIRST_NAME = 'Tom';
const DEV_LAST_NAME = 'Lam';
const DEV_EMAIL = 'owner@example.com';

const devVoice = {
  started: 0,
  isConfigured: () => true,
  async start(demo) {
    devVoice.started += 1;
    return { roomName: demo.roomName, participantIdentity: `visitor-${demo.id}`, participantToken: 'dev-token', livekitUrl: 'wss://voice.dev.invalid', dispatchId: `dev-${devVoice.started}`, tokenExpiresAt: new Date(Date.now() + 5 * 60_000).toISOString() };
  },
  async end() {},
  async issueParticipantToken() { return { livekitUrl: 'wss://voice.dev.invalid', participantToken: 'dev-token', tokenExpiresAt: new Date(Date.now() + 5 * 60_000).toISOString() }; },
};

// Stands in for the recap model: a fixed-shape recap from the transcript, so the Summary section has real length.
async function devRecap(transcript, { name }) {
  const callerLines = transcript.filter((entry) => entry.speaker === 'caller').map((entry) => entry.text);
  if (!callerLines.length) return null;
  return `The caller opened with "${callerLines[0]}" and spoke ${callerLines.length} times. ${name} answered from what the business has on file. This is the local stand-in for the written recap.`;
}

export function ownerDevPlugin() {
  return {
    name: 'frontline-owner-dev',
    async configureServer(server) {
      const pg = await createMigratedDatabase();
      const owner = await seedClaimedOwner(pg, { researched: true });
      await seedConversations(pg, owner, devConversationSeeds());
      await pg.exec('SET ROLE frontline_app');
      const db = fromPglite(pg);
      const origin = () => `http://${server.config.server.host || 'localhost'}:${server.config.server.port ?? 5188}`;

      async function endDemo({ scopeId, demoId }) {
        const demo = await readDemo(db, scopeId, demoId);
        if (!demo) return { state: 'ended' };
        if (!['ended', 'failed'].includes(demo.state)) {
          await inOwnerScope(db, scopeId, (tx) => tx.query("SELECT settle_voice_start($1::uuid,'completed')", [demo.reservationId]));
          await updateDemo(db, scopeId, demoId, (current) => ({ state: 'ended', endedAt: new Date().toISOString(), terminalReason: 'caller_ended', startedAt: current.startedAt ?? current.createdAt, voiceCleanupCompleted: true }));
        }
        return { state: 'ended' };
      }
      const handler = createPostOnboardingHandler({
        enabled: () => true, db, owner: createOwnerResolver({ db }), appBaseUrl: origin(), voice: devVoice, endOwnerDemo: endDemo, endGuestDemo: endDemo,
        guestConfig: { ...DEFAULT_GUEST_CONFIG, dailyCapCents: 1_000_000, reservedCents: 100, globalConcurrent: 20, scopeDailyMax: 3 },
        extraction: { available: { text: true }, extract: async ({ inputRef }) => ({ proposed: heuristicExtract(inputRef.text) }) },
        writeRecap: devRecap,
      });

      server.middlewares.use(async (request, response, next) => {
        const url = new URL(request.url ?? '/', 'http://localhost');
        if (url.pathname === '/dev/login') {
          // The first name, last name and email are what real sign-in leaves for the greeting and the Account page (server/api/auth-claims.js): a readable cookie.
          response.writeHead(302, { location: '/app', 'set-cookie': [`fl_auth=${owner.authToken}; Path=/; HttpOnly; SameSite=Lax`, `fl_first_name=${encodeURIComponent(DEV_FIRST_NAME)}; Path=/; SameSite=Lax`, `fl_last_name=${encodeURIComponent(DEV_LAST_NAME)}; Path=/; SameSite=Lax`, `fl_email=${encodeURIComponent(DEV_EMAIL)}; Path=/; SameSite=Lax`] });
          response.end();
          return;
        }
        if (url.pathname === '/dev/add-receptionist') {
          // A second receptionist that uses the same sources as the first, for looking at the library and Choose knowledge. Add a source first.
          try {
            await addReceptionist({ pg }, owner, { name: url.searchParams.get('name') || 'Sam', sourceIds: 'all' });
            response.writeHead(302, { location: '/app/knowledge' });
            response.end();
          } catch (error) {
            response.writeHead(409, { 'content-type': 'text/plain' });
            response.end(error.message);
          }
          return;
        }
        if (url.pathname === '/v1/session') {
          const csrf = randomBytes(32).toString('hex');
          response.writeHead(200, { 'content-type': 'application/json', 'set-cookie': `fl_csrf=${csrf}; Path=/; SameSite=Strict`, 'cache-control': 'no-store' });
          response.end(JSON.stringify({ csrfToken: csrf }));
          return;
        }
        if (url.pathname.startsWith('/v1/') && await handler(request, response, url)) return;
        if (request.method === 'GET' && (url.pathname === '/app' || url.pathname.startsWith('/app/') || url.pathname === '/shared')) request.url = '/owner.html';
        next();
      });
      server.httpServer?.once('listening', () => {
        console.log(`\nOwner dev harness ready. Open ${origin()}/dev/login to sign in as the seeded owner (Riverside Dental).`);
        console.log('Real handler, real migrations, in-process Postgres. Voice and text reading are stand-ins; sign-in is a shortcut.\n');
      });
    },
  };
}
