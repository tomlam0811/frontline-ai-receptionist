import { problem } from '../contracts.js';

export { problem };

// Maps the fixed messages raised by the post-onboarding SQL functions to the
// problem+json codes in the technical spec's error catalog. Unknown errors are
// rethrown unchanged so they surface as 500 without leaking database detail.
const DATABASE_MESSAGES = {
  'owner scope mismatch': [404, 'not_found', 'Not found.'],
  idempotency_conflict: [409, 'idempotency_conflict', 'This request key was already used with different content.'],
  builder_forbidden: [403, 'builder_forbidden', 'Builder access is required.'],
  credential_invalid: [401, 'credential_invalid', 'The credential is missing, expired or revoked.'],
  not_found: [404, 'not_found', 'Not found.'],
  stale_revision: [409, 'stale_revision', 'This record changed. Refresh and try again.'],
  invalid_transition: [422, 'invalid_transition', 'That status change is not allowed.'],
};

export function mapDatabaseError(error) {
  if (Number.isInteger(error?.status) && error?.code) return error;
  const entry = DATABASE_MESSAGES[String(error?.message ?? '')];
  return entry ? problem(entry[0], entry[1], entry[2]) : error;
}
