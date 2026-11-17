// The guest link secret lives in the URL fragment (`/shared#t=<token>`). It is read once, removed from the
// address bar right away, and held in memory only: never in storage, a cookie, a title or a log.

let held = null;

/** Reads `#t=` from the address bar, removes it with history.replaceState, and returns the token (or null). */
export function takeGuestToken() {
  const hash = window.location.hash;
  if (hash) {
    const token = new URLSearchParams(hash.replace(/^#/, '')).get('t');
    if (token) held = token;
    // Drop the whole fragment, not only the token, so nothing about the link stays in the address bar or history.
    window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search);
  }
  return held;
}

/** Called once the link has been exchanged (or refused for good). Later retries do not need the secret. */
export function forgetGuestToken() { held = null; }
