import { describe, expect, it } from 'vitest';
import { createPreparationQueue } from '../server/api/preparation-queue.js';
import { errorMessage } from '../src/pages/owner/error-copy.js';

// Tom (2026-10-01): when a provider runs out of credit, people see "contact the Frontline team" instead of a retry loop.
describe('provider account failures', () => {
  it('owner messages for unavailable calls point to the Frontline team', () => {
    for (const code of ['voice_limit_reached', 'voice_unavailable', 'feature_disabled']) {
      expect(errorMessage({ code })).toMatch(/contact the Frontline team/);
    }
    expect(errorMessage({ code: 'test_limit_reached' })).toBe("You've used today's 3 test calls. The limit resets at midnight Pacific time.");
  });

  it('a preparation refused for credit says to contact the Frontline team, and other failures keep the retry message', async () => {
    /** @type {Array<[Error, RegExp]>} */
    const cases = [
      [Object.assign(new Error('structured_extraction_unavailable'), { accountUnavailable: true }), /contact the Frontline team/],
      [Object.assign(new Error('Exa could not retrieve this website.'), { code: 'exa_account_unavailable' }), /contact the Frontline team/],
      [new Error('timeout'), /could not be prepared/],
    ];
    for (const [error, expected] of cases) {
      const state = { preparations: { p1: { state: 'researching', expiresAt: new Date(Date.now() + 60_000).toISOString() } } };
      const store = { transaction: async (fn) => fn(state) };
      const queue = createPreparationQueue({ store, prepare: async () => { throw error; } });
      await queue.enqueue({ id: 'p1', workspaceId: 'w1', clientKey: 'c1', url: 'https://example.com' });
      await expect.poll(() => state.preparations.p1.state).toBe('failed_retryable');
      expect(state.preparations.p1.error?.message ?? '').toMatch(expected);
    }
  });
});
