import React from 'react';
import { createRoot, hydrateRoot } from 'react-dom/client';
import App from './App.jsx';
import './styles.css';

const root = document.getElementById('root');
const app = <React.StrictMode><App /></React.StrictMode>;
// dist/index.html always carries the prerendered Landing markup (scripts/prerender-landing.mjs bakes it
// into the one shared HTML file that every route's SPA fallback serves), so `root` has child nodes on
// every route, not only on Landing. Hydrate only when the current route is the one that was actually
// prerendered; every other route clears that stale markup before mounting fresh. React 19's createRoot
// already clears a populated container's children on first render, but the explicit clear here keeps
// that guaranteed rather than relying on undocumented internal behavior.
//
// An `auth` query param on `/` (returning from a Google sign-in/claim/reauth redirect) is one such
// non-prerendered case: App.jsx's initial stage is `restoring`, not `landing`, for that URL (see its
// useState there), so the prerendered Landing markup would not match the first client render and
// hydration would fail. Matching that same condition here avoids hydrating against markup that was
// never built for this URL.
const isPrerenderedLanding = window.location.pathname === '/' && !new URLSearchParams(window.location.search).has('auth');
if (isPrerenderedLanding) hydrateRoot(root, app);
else {
  root.replaceChildren();
  createRoot(root).render(app);
}
