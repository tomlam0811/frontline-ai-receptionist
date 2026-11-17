import { OwnerApiError, ownerApi } from '../../lib/owner-api.js';

// Owner routes answer 404 to a signed-out visitor: the server cannot tell "not your agent" from "not signed in".
// A 404 is therefore checked against the session before a screen claims the agent is missing.

export const isSignInError = (error) => error?.code === 'sign_in_required' || error?.status === 401;

/** True when the error means the person has to sign in again. Checks the session on a 404. */
export async function isSignedOut(error, signal) {
  if (isSignInError(error)) return true;
  if (error?.status !== 404) return false;
  try { await ownerApi.listMyAgents(signal); return false; } catch (probe) { return isSignInError(probe); }
}

/** Runs a request and turns a signed-out failure into a `sign_in_required` error, so screens have one case to handle. */
export async function withSessionCheck(run, signal) {
  try { return await run(); } catch (error) {
    if (error?.name === 'AbortError') throw error;
    if (await isSignedOut(error, signal)) throw new OwnerApiError('Sign in again to continue.', 'sign_in_required', 401);
    throw error;
  }
}
