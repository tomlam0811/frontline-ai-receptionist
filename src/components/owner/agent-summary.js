import { OwnerApiError, ownerApi } from '../../lib/owner-api.js';

/**
 * The summary of one Bob. The server answers 404 both for someone else's agent and for a request with no
 * sign-in (it never says which). A 404 is therefore checked against the sign-in: if the person is signed
 * out, the error becomes `sign_in_required` so the screen can offer "Sign in".
 * @param {string} agentId @param {AbortSignal} [signal]
 */
export async function getSummaryOrSignIn(agentId, signal) {
  try {
    return await ownerApi.getSummary(agentId, signal);
  } catch (error) {
    if (error?.status !== 404) throw error;
    const signedIn = await ownerApi.listMyAgents(signal).then(() => true, (cause) => cause?.status !== 401);
    if (!signedIn) throw new OwnerApiError('Sign in again to continue.', 'sign_in_required', 401);
    throw error;
  }
}
