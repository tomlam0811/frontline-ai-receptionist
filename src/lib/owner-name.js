// What sign-in knows about the owner (PO-S18). Sign-in leaves each value Google verified in a readable cookie that ends
// with the session (server/api/auth-claims.js). Nothing is stored on the server, so a session from before a cookie
// existed simply has no value for it.
const PROFILE_COOKIES = /** @type {const} */ ([['firstName', 'fl_first_name', 40], ['lastName', 'fl_last_name', 40], ['email', 'fl_email', 254]]);

const browserCookies = () => (typeof document === 'undefined' ? '' : document.cookie);

/** @param {string} cookieText @param {string} name @param {number} max */
function readCookie(cookieText, name, max) {
  const pair = cookieText.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));
  if (!pair) return '';
  try { return decodeURIComponent(pair.slice(name.length + 1)).trim().slice(0, max); } catch { return ''; }
}

/**
 * The signed-in owner's first name for the greeting, or '' when it is not known.
 * @param {string} [cookieText]
 */
export function ownerFirstName(cookieText = browserCookies()) {
  return readCookie(cookieText, 'fl_first_name', 40);
}

/**
 * First name, last name and email as sign-in left them. Each is '' when it is not known.
 * @param {string} [cookieText]
 * @returns {{firstName: string, lastName: string, email: string}}
 */
export function ownerProfile(cookieText = browserCookies()) {
  const profile = { firstName: '', lastName: '', email: '' };
  for (const [key, name, max] of PROFILE_COOKIES) profile[key] = readCookie(cookieText, name, max);
  return profile;
}

/** Removes the readable profile cookies from this browser (sign-out and account deletion also clear them on the server). */
export function clearOwnerProfile() {
  if (typeof document === 'undefined') return;
  const secure = typeof location !== 'undefined' && location.protocol === 'https:' ? '; Secure' : '';
  for (const [, name] of PROFILE_COOKIES) document.cookie = `${name}=; Path=/; Max-Age=0; SameSite=Strict${secure}`;
}
