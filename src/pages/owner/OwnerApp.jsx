import { lazy, Suspense } from 'react';
import { matchRoute, useLocation } from './router.jsx';
import { AppLink } from './router.jsx';
import { EmptyState, Loading, Shell } from '../../components/owner/ui.jsx';
import Home from './Home.jsx';
import './styles.js';

// The owner and guest screens behind one entry (design spec: Screens). At connection (PO-C13) the app mounts this
// for /app/* (except the existing /setup routes) and /shared. Screens are loaded on demand.
const Welcome = lazy(() => import('./Welcome.jsx'));
const Bob = lazy(() => import('./Bob.jsx'));
const ReceptionistKnowledge = lazy(() => import('./ReceptionistKnowledge.jsx'));
const BusinessKnowledge = lazy(() => import('./BusinessKnowledge.jsx'));
const Capabilities = lazy(() => import('./Capabilities.jsx'));
const Conversations = lazy(() => import('./Conversations.jsx'));
const Feedback = lazy(() => import('./Feedback.jsx'));
const Talk = lazy(() => import('./Talk.jsx'));
const Account = lazy(() => import('./Account.jsx'));
const Guest = lazy(() => import('./Guest.jsx'));

/** @param {{signIn?: () => void}} props `signIn` starts the existing Google sign-in; connection supplies it. */
export default function OwnerApp({ signIn = () => window.location.assign('/') }) {
  const { search, pathname } = useLocation();
  const route = matchRoute(pathname);
  const params = new URLSearchParams(search);
  const common = { signIn };
  let screen;
  switch (route.name) {
    case 'home': screen = <Home {...common} />; break;
    case 'welcome': screen = <Welcome {...common} agentId={route.agentId} />; break;
    case 'bob': screen = <Bob {...common} agentId={route.agentId} />; break;
    case 'knowledge': screen = <ReceptionistKnowledge {...common} agentId={route.agentId} />; break;
    case 'businessKnowledge': screen = <BusinessKnowledge {...common} category={route.extra} notice={params.get('notice')} agentId={params.get('agent')} />; break;
    case 'capabilities': screen = <Capabilities {...common} agentId={route.agentId} />; break;
    case 'conversations': screen = <Conversations {...common} agentId={route.agentId} />; break;
    case 'conversation': screen = <Conversations {...common} agentId={route.agentId} conversationId={route.extra} />; break;
    case 'feedback': screen = <Feedback {...common} agentId={route.agentId} conversationId={params.get('conversation')} category={params.get('category')} topic={params.get('topic')} />; break;
    case 'talk': screen = <Talk {...common} agentId={route.agentId} />; break;
    case 'share': screen = <Bob {...common} agentId={route.agentId} shareOpen />; break;
    case 'account': screen = <Account {...common} />; break;
    case 'guest': screen = <Guest {...common} />; break;
    default: screen = <Shell><h1>{"Couldn't find that page."}</h1><EmptyState title="Go back to your receptionist." action={<AppLink className="bob-button bob-button--primary" to="/app">Open receptionist</AppLink>} /></Shell>;
  }
  return <Suspense key={pathname} fallback={<Shell><Loading>Loading</Loading></Shell>}>{screen}</Suspense>;
}
