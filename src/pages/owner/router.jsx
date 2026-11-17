import { useEffect, useState } from 'react';

// A small history router for the owner routes. The onboarding app keeps its own routing; at connection
// (PO-C13) these routes are mounted next to it and this file is replaced by whatever the app then uses.

const CHANGE = 'owner:navigate';

/** `state` rides along in history, for example `{ startCall: true }` so the Talk screen starts the call on arrival. */
export function navigate(path, { replace = false, state = {} } = {}) {
  window.history[replace ? 'replaceState' : 'pushState'](state, '', path);
  window.dispatchEvent(new Event(CHANGE));
}

export function useLocation() {
  const [location, setLocation] = useState(() => ({ pathname: window.location.pathname, search: window.location.search }));
  useEffect(() => {
    const update = () => setLocation({ pathname: window.location.pathname, search: window.location.search });
    window.addEventListener('popstate', update);
    window.addEventListener(CHANGE, update);
    // A child's effect runs before this one, so a redirect made on first load (such as back from sign-in)
    // fires before this listener exists. Read the current address once to catch it.
    update();
    return () => { window.removeEventListener('popstate', update); window.removeEventListener(CHANGE, update); };
  }, []);
  return location;
}

/** A link that changes the route without a reload, and still works as a normal link (new tab, copy address). */
export function AppLink({ to, state = undefined, children, ...props }) {
  return <a href={to} {...props} onClick={(event) => {
    props.onClick?.(event);
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigate(to, { state });
  }}>{children}</a>;
}

const ID = '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';
/** @type {[string, RegExp][]} */
const ROUTES = [
  ['home', /^\/app\/?$/],
  ['businessKnowledge', /^\/app\/knowledge(?:\/([a-z_]+))?\/?$/],
  ['welcome', new RegExp(`^/app/agents/${ID}/welcome/?$`)],
  ['bob', new RegExp(`^/app/agents/${ID}/?$`)],
  ['knowledge', new RegExp(`^/app/agents/${ID}/knowledge/?$`)],
  ['capabilities', new RegExp(`^/app/agents/${ID}/capabilities/?$`)],
  ['conversation', new RegExp(`^/app/agents/${ID}/conversations/${ID}/?$`)],
  ['conversations', new RegExp(`^/app/agents/${ID}/conversations/?$`)],
  ['feedback', new RegExp(`^/app/agents/${ID}/feedback/?$`)],
  // /test is the old address of the same screen; earlier links still open it.
  ['talk', new RegExp(`^/app/agents/${ID}/(?:talk|test)/?$`)],
  ['share', new RegExp(`^/app/agents/${ID}/share/?$`)],
  ['account', /^\/app\/account\/?$/],
  ['guest', /^\/shared\/?$/],
];

/** @returns {{name: string, agentId?: string, extra?: string}} */
export function matchRoute(pathname) {
  for (const [name, pattern] of ROUTES) {
    const match = pathname.match(pattern);
    if (match) return name === 'businessKnowledge' ? { name, extra: match[1] } : { name, agentId: match[1], extra: match[2] };
  }
  return { name: 'notFound' };
}
