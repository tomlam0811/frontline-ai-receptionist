import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import Landing from './pages/Landing.jsx';
import Experience from './pages/Experience.jsx';
import DesignReview from './pages/DesignReview.jsx';
import PreparationProgress from './components/product/PreparationProgress.jsx';
import MeetBob from './components/product/MeetBob.jsx';
import BrowserVoice from './components/product/BrowserVoice.jsx';
import DemoResult from './components/product/DemoResult.jsx';
import ClaimAgent from './components/product/ClaimAgent.jsx';
import AgentSetup from './components/product/AgentSetup.jsx';
import AdditionalInfo from './pages/AdditionalInfo.jsx';
import { Logo } from './components/landing/Logo.jsx';
import { frontlineApi, preparationErrorStage } from './lib/frontline-api.js';
import { navigate, useLocation } from './pages/owner/router.jsx';
import './pages/trial.css';
import './pages/claim-setup.css';

const PREPARATION_KEY = 'frontline.preparationId';
const DEMO_KEY = 'frontline.demoId';
const SAVE_STEP_KEY = 'frontline.saveStep';
const SAVE_MODE_KEY = 'frontline.saveMode';
const CLAIMED_RESOURCE_KEY = 'frontline.claimedResource';
const GENERIC_SIGNIN_KEY = 'frontline.genericSignIn';
const FINAL_STATES = new Set(['ready', 'limited_ready', 'insufficient_context', 'failed_retryable', 'blocked']);
const ROUTE_BY_STAGE = {
  landing: '/',
  preparing: '/try/preparing',
  'preparation-error': '/try/preparing',
  meet: '/try/meet-bob',
  'starting-voice': '/try/meet-bob',
  voice: '/try/conversation',
  'loading-result': '/try/result',
  'result-error': '/try/result',
  result: '/try/result',
  claim: '/try/save',
};
const OwnerApp = lazy(() => import('./pages/owner/OwnerApp.jsx'));
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const OWNER_PATH = /^\/(app(\/.*)?|shared\/?)$/;
const OWNER_AGENT_PATH = new RegExp('^/app/agents/(' + UUID + ')(/|$)');

/** The owner and guest screens are mounted only in a build made with VITE_FRONTLINE_POST_ONBOARDING=on. Off by default. */
function ownerAppEnabled() {
  return ['1', 'on', 'true'].includes(String(import.meta.env.VITE_FRONTLINE_POST_ONBOARDING ?? '').toLowerCase());
}

/** Owner routes are everything under /app and /shared except the existing setup routes, which keep the current screens. */
function isOwnerPath(pathname) {
  return OWNER_PATH.test(pathname) && !RESOURCE_PATH.test(pathname);
}

/** Where a claim leads when the owner screens are mounted: the first-visit screen for an agent, Home for an unfinished workspace. */
function ownerDestination(resource) {
  return resource.kind === 'agent' ? '/app/agents/' + resource.id + '/welcome' : '/app';
}

/**
 * Sign-in for the owner screens. With a saved resource already in hand (the current /app/agents/:id page,
 * or one remembered from an earlier claim this session) it reuses the existing Google re-authentication for
 * that resource. With no resource known yet, such as a fresh "Sign in" from the landing page, it starts a
 * plain sign-in instead: the owner screens then look up everything already tied to the verified account.
 */
async function startOwnerSignIn() {
  let resource = null;
  const fromPath = window.location.pathname.match(OWNER_AGENT_PATH);
  if (fromPath) resource = { kind: 'agent', id: fromPath[1] };
  else {
    try { resource = JSON.parse(window.sessionStorage.getItem(CLAIMED_RESOURCE_KEY)); } catch { /* No saved pointer. */ }
  }
  const hasResource = ['agent', 'workspace'].includes(resource?.kind) && new RegExp('^' + UUID + '$').test(resource?.id ?? '');
  try {
    let response;
    if (hasResource) {
      window.sessionStorage.setItem(CLAIMED_RESOURCE_KEY, JSON.stringify(resource));
      response = await frontlineApi.reauthGoogle(resource.kind, resource.id);
    } else {
      window.sessionStorage.setItem(GENERIC_SIGNIN_KEY, '1');
      response = await frontlineApi.signInGoogle();
    }
    const url = new URL(response?.authorizationUrl || '', window.location.origin);
    if (url.origin !== 'https://accounts.google.com' || url.pathname !== '/o/oauth2/v2/auth') throw new Error('Google sign-in is unavailable.');
    window.location.assign(url.href);
  } catch {
    window.location.assign('/');
  }
}

const RESOURCE_PATH = /^\/app\/(agents|workspaces)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/setup$/;

function resourceFromPath(pathname) {
  const match = pathname.match(RESOURCE_PATH);
  return match ? { kind: match[1] === 'agents' ? 'agent' : 'workspace', id: match[2] } : null;
}

function routeForFlow(stage, claimedResource) {
  if (stage === 'setup' && claimedResource?.id) {
    const group = claimedResource.kind === 'agent' ? 'agents' : 'workspaces';
    return '/app/' + group + '/' + claimedResource.id + '/setup';
  }
  return ROUTE_BY_STAGE[stage] ?? null;
}

function pause(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new DOMException('Aborted', 'AbortError')); return; }
    const timer = window.setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      window.clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    }, { once: true });
  });
}

async function settledDemoResult(id, signal) {
  const deadline = Date.now() + 45_000;
  let result = await frontlineApi.getDemoResult(id, signal);
  while (result?.state === 'ending' && Date.now() < deadline) {
    await pause(750, signal);
    result = await frontlineApi.getDemoResult(id, signal);
  }
  if (result?.state === 'ending') throw new Error('The call is still ending. Try again in a moment.');
  if (!['ended', 'failed'].includes(result?.state)) throw new Error('The call is still going. End it to see the result.');
  return result;
}

async function restoreDemoResult(id, signal) {
  const status = await frontlineApi.getDemoResult(id, signal);
  if (!['ending', 'ended', 'failed'].includes(status?.state)) {
    // A page reload loses the ephemeral voice token. Close the still-running
    // demo before displaying its result instead of presenting active work as done.
    await frontlineApi.endDemo(id, signal);
  }
  return settledDemoResult(id, signal);
}

function TrialFrame({ children, onHome = undefined }) {
  return <div className="trial-shell">
    <header className="trial-header">
      <a className="trial-header__brand" href="/" aria-label="Frontline home" onClick={onHome}><Logo /></a>
    </header>
    {children}
  </div>;
}

function OnboardingApp() {
  const reviewMode = import.meta.env.DEV && new URLSearchParams(window.location.search).has('review');
  const [reviewOpen, setReviewOpen] = useState(reviewMode);
  const [flow, setFlow] = useState({ stage: !reviewMode && (window.location.pathname !== '/' || new URLSearchParams(window.location.search).has('auth')) ? 'restoring' : 'landing', website: '', preparationId: null, preparation: null, demo: null, result: null, claimedResource: null, error: '', errorCode: '' });
  const [resumeId, setResumeId] = useState(null);
  const [resumeDemoId, setResumeDemoId] = useState(null);
  const requestRef = useRef(null);
  const voiceStartRef = useRef(null);
  const homeAfterVoiceStartRef = useRef(false);
  const resultRequestRef = useRef(null);

  useEffect(() => {
    if (reviewMode || flow.stage === 'restoring') return;
    const route = routeForFlow(flow.stage, flow.claimedResource);
    if (route && window.location.pathname !== route) {
      const suffix = flow.stage === 'claim' ? window.location.search : '';
      window.history.replaceState(null, '', route + suffix);
    }
  }, [flow.stage, flow.claimedResource, reviewMode]);

  useEffect(() => {
    const reloadRoute = () => {
      if (flow.stage === 'starting-voice' && voiceStartRef.current) {
        window.history.pushState(null, '', '/try/meet-bob');
        homeAfterVoiceStartRef.current = true;
        setFlow((current) => ({ ...current, error: 'Finishing the connection before leaving…' }));
        return;
      }
      if (flow.stage !== 'voice' || !flow.demo?.demoId) {
        window.location.reload();
        return;
      }
      void frontlineApi.endDemo(flow.demo.demoId).then(() => {
        window.location.reload();
      }).catch(() => {
        window.history.pushState(null, '', '/try/conversation');
        setFlow((current) => ({ ...current, error: "Couldn't close the call. End it before leaving." }));
      });
    };
    window.addEventListener('popstate', reloadRoute);
    return () => window.removeEventListener('popstate', reloadRoute);
  }, [flow.stage, flow.demo?.demoId]);

  useEffect(() => {
    if (reviewMode || (window.location.pathname === '/' && !new URLSearchParams(window.location.search).has('auth'))) return;
    const pathResource = resourceFromPath(window.location.pathname);
    const savedResource = window.sessionStorage.getItem(CLAIMED_RESOURCE_KEY);
    const returningFromClaim = new URLSearchParams(window.location.search).has('auth')
      && window.sessionStorage.getItem(SAVE_STEP_KEY) === 'claim';
    const returningFromGenericSignIn = new URLSearchParams(window.location.search).has('auth')
      && window.sessionStorage.getItem(GENERIC_SIGNIN_KEY) === '1';
    if (returningFromGenericSignIn) {
      // Back from a plain "Sign in" with no known resource: send the owner screens to look up
      // everything tied to the now-verified account, instead of continuing an onboarding flow.
      // Google sign-in completion can fail server-side (expired state, provider error, a claim
      // that could not be created) — the callback still redirects here either way, so check which
      // outcome it reports instead of assuming success. Landing into /app on a failed sign-in left
      // no session cookie, so GET /v1/me/agents would 401 and the owner Home screen would ask the
      // visitor to sign in again, which looked like an endless loop.
      const signInSucceeded = new URLSearchParams(window.location.search).get('auth') === 'google-complete';
      window.sessionStorage.removeItem(GENERIC_SIGNIN_KEY);
      const currentUrl = new URL(window.location.href);
      currentUrl.searchParams.delete('auth');
      window.history.replaceState(null, '', `${currentUrl.pathname}${currentUrl.search}${currentUrl.hash}`);
      if (signInSucceeded && ownerAppEnabled()) { navigate('/app', { replace: true }); return; }
      setFlow((current) => ({ ...current, stage: 'landing', error: signInSucceeded ? '' : "Sign-in didn't finish. Try again." }));
      return;
    }
    if (pathResource || (savedResource && !window.location.pathname.startsWith('/try/') && !returningFromClaim)) {
      try {
        const resource = pathResource ?? JSON.parse(savedResource);
        if (['agent', 'workspace'].includes(resource?.kind) && typeof resource.id === 'string' && /^[0-9a-f-]{36}$/.test(resource.id)) {
          const currentUrl = new URL(window.location.href);
          const fromSignIn = currentUrl.searchParams.has('auth');
          if (currentUrl.searchParams.has('auth')) {
            currentUrl.searchParams.delete('auth');
            window.history.replaceState(null, '', `${currentUrl.pathname}${currentUrl.search}${currentUrl.hash}`);
          }
          if (pathResource === null && ownerAppEnabled() && fromSignIn) {
            // Back from Google sign-in started on an owner screen: return to the owner screens.
            navigate('/app', { replace: true });
            return;
          }
          setFlow((current) => ({ ...current, stage: 'setup', claimedResource: resource }));
          return;
        }
      } catch { /* Stale local pointer; server remains authoritative. */ }
      window.sessionStorage.removeItem(CLAIMED_RESOURCE_KEY);
    }
    const saved = window.sessionStorage.getItem(PREPARATION_KEY);
    const savedDemo = window.sessionStorage.getItem(DEMO_KEY);
    if (savedDemo && /^[0-9a-f-]{36}$/.test(savedDemo)) setResumeDemoId(savedDemo);
    else if (saved && /^[0-9a-f-]{36}$/.test(saved)) setResumeId(saved);
    else setFlow((current) => ({ ...current, stage: 'landing' }));
  }, [reviewMode]);

  useEffect(() => {
    if (!resumeDemoId || reviewMode) return undefined;
    const controller = new AbortController();
    const savedPreparation = window.sessionStorage.getItem(PREPARATION_KEY);
    const savedMode = window.sessionStorage.getItem(SAVE_MODE_KEY);
    if (window.sessionStorage.getItem(SAVE_STEP_KEY) === 'claim' && ['business_demo', 'frontline_qa'].includes(savedMode)) {
      // Claim can already be committed even when its 201 response was lost.
      // Mount the idempotent claim recovery before anonymous demo reads.
      setFlow((current) => ({ ...current, stage: 'claim', preparationId: savedPreparation,
        demo: { demoId: resumeDemoId, mode: savedMode }, result: { mode: savedMode }, error: '' }));
      return () => controller.abort();
    }
    setFlow((current) => ({ ...current, stage: 'loading-result', demo: { demoId: resumeDemoId }, preparationId: savedPreparation, error: '' }));
    Promise.all([
      restoreDemoResult(resumeDemoId, controller.signal),
      savedPreparation ? frontlineApi.getPreparation(savedPreparation, controller.signal) : Promise.resolve(null),
    ]).then(([result, preparation]) => {
      if (controller.signal.aborted) return;
      setFlow((current) => ({ ...current, stage: window.sessionStorage.getItem(SAVE_STEP_KEY) === 'claim' ? 'claim' : 'result', preparationId: savedPreparation, preparation, demo: { demoId: resumeDemoId, mode: result?.mode }, result, error: '' }));
    }).catch((error) => {
      if (controller.signal.aborted) return;
      if (['not_found', 'workspace_expired'].includes(error?.code)) {
        window.sessionStorage.removeItem(DEMO_KEY);
        window.sessionStorage.removeItem(SAVE_STEP_KEY);
      }
      setFlow((current) => ({ ...current, stage: 'result-error', error: error?.message || "Couldn't bring back the last call. Start a new demo." }));
    });
    return () => controller.abort();
  }, [resumeDemoId, reviewMode]);

  async function runPreparation({ website = '', preparationId = null, controller }) {
    setFlow((current) => ({ ...current, stage: 'preparing', website, preparationId, preparation: null, demo: null, result: null, error: '', errorCode: '' }));
    try {
      let id = preparationId;
      if (!id) {
        const created = await frontlineApi.createPreparation(website, controller.signal);
        if (controller.signal.aborted) return;
        if (!created?.preparationId) throw new Error("Couldn't start reading the website. Try again.");
        id = created.preparationId;
        window.sessionStorage.setItem(PREPARATION_KEY, id);
        setFlow((current) => ({ ...current, preparationId: id }));
      }
      const deadline = Date.now() + 100_000;
      while (!controller.signal.aborted) {
        const preparation = await frontlineApi.getPreparation(id, controller.signal);
        if (controller.signal.aborted) return;
        if (FINAL_STATES.has(preparation?.state)) {
          if (preparation.state === 'failed_retryable' || preparation.state === 'blocked') {
            setFlow((current) => ({ ...current, stage: 'preparation-error', preparationId: id, preparation, error: preparation.error?.message || "Couldn't finish reading this website." }));
          } else {
            setFlow((current) => ({ ...current, stage: 'meet', preparationId: id, preparation, error: '' }));
          }
          return;
        }
        if (Date.now() >= deadline) throw new Error('This is taking longer than expected. Check again.');
        await pause(1200, controller.signal);
      }
    } catch (error) {
      if (controller.signal.aborted || error?.name === 'AbortError') return;
      if (error?.code === 'workspace_expired' || error?.code === 'not_found') window.sessionStorage.removeItem(PREPARATION_KEY);
      setFlow((current) => ({ ...current, stage: 'preparation-error', error: error?.message || "Couldn't read this website.", errorCode: error?.code || '' }));
    } finally {
      if (requestRef.current === controller) requestRef.current = null;
    }
  }

  useEffect(() => {
    if (!resumeId || reviewMode) return undefined;
    const controller = new AbortController();
    requestRef.current = controller;
    void runPreparation({ preparationId: resumeId, controller });
    return () => {
      controller.abort();
      if (requestRef.current === controller) requestRef.current = null;
    };
  }, [resumeId, reviewMode]);

  const beginPreparation = (website) => {
    requestRef.current?.abort();
    setResumeId(null);
    window.history.pushState(null, '', '/try/preparing');
    const controller = new AbortController();
    requestRef.current = controller;
    void runPreparation({ website, controller });
  };

  function afterClaim(claimedResource) {
    if (ownerAppEnabled()) { navigate(ownerDestination(claimedResource), { replace: true }); return; }
    setFlow((current) => ({ ...current, stage: 'setup', claimedResource }));
  }

  const changeWebsite = () => {
    requestRef.current?.abort();
    voiceStartRef.current?.abort();
    resultRequestRef.current?.abort();
    if (flow.claimedResource?.id && ['agent', 'workspace'].includes(flow.claimedResource.kind)) {
      window.sessionStorage.removeItem(`frontline.setupDraft.${flow.claimedResource.kind}.${flow.claimedResource.id}`);
    }
    window.sessionStorage.removeItem(PREPARATION_KEY);
    window.sessionStorage.removeItem(DEMO_KEY);
    window.sessionStorage.removeItem(SAVE_STEP_KEY);
    window.sessionStorage.removeItem(SAVE_MODE_KEY);
    window.sessionStorage.removeItem(CLAIMED_RESOURCE_KEY);
    setResumeId(null);
    setResumeDemoId(null);
    window.history.replaceState(null, '', '/');
    setFlow((current) => ({ stage: 'landing', website: current.website, preparationId: null, preparation: null, demo: null, result: null, claimedResource: null, error: '' }));
  };

  const returnToClaimResult = async () => {
    window.sessionStorage.removeItem(SAVE_STEP_KEY);
    window.sessionStorage.removeItem(SAVE_MODE_KEY);
    if (flow.result?.demoId) { setFlow((current) => ({ ...current, stage: 'result' })); return; }
    const demoId = flow.demo?.demoId;
    if (!demoId) { changeWebsite(); return; }
    const controller = new AbortController();
    resultRequestRef.current = controller;
    setFlow((current) => ({ ...current, stage: 'loading-result', error: '' }));
    try {
      const [result, preparation] = await Promise.all([
        frontlineApi.getDemoResult(demoId, controller.signal),
        flow.preparationId ? frontlineApi.getPreparation(flow.preparationId, controller.signal) : Promise.resolve(null),
      ]);
      if (!controller.signal.aborted) setFlow((current) => ({ ...current, stage: 'result', result, preparation, error: '' }));
    } catch (error) {
      if (!controller.signal.aborted) setFlow((current) => ({ ...current, stage: 'result-error', errorSource: 'claim-return',
        error: error?.message || "Couldn't bring back the call result. Try again." }));
    } finally {
      if (resultRequestRef.current === controller) resultRequestRef.current = null;
    }
  };

  const retryPreparation = () => {
    if (flow.preparationId && flow.error.includes('taking longer')) {
      requestRef.current?.abort();
      const controller = new AbortController();
      requestRef.current = controller;
      void runPreparation({ website: flow.website, preparationId: flow.preparationId, controller });
    } else if (flow.website) beginPreparation(flow.website);
    else changeWebsite();
  };

  const startVoice = async (mode) => {
    const preparation = flow.preparation;
    if (!flow.preparationId || !Number.isInteger(preparation?.revision)) return;
    voiceStartRef.current?.abort();
    const controller = new AbortController();
    voiceStartRef.current = controller;
    setFlow((current) => ({ ...current, stage: 'starting-voice', error: '' }));
    try {
      const demo = await frontlineApi.startDemo(flow.preparationId, preparation.revision, mode, controller.signal);
      if (controller.signal.aborted) return;
      if (!demo?.demoId || !demo?.livekitUrl || !demo?.participantToken) throw new Error("Couldn't connect the call. Try again.");
      window.sessionStorage.setItem(DEMO_KEY, demo.demoId);
      window.sessionStorage.removeItem(SAVE_STEP_KEY);
      if (homeAfterVoiceStartRef.current) {
        homeAfterVoiceStartRef.current = false;
        try {
          await frontlineApi.endDemo(demo.demoId);
          window.location.assign('/');
        } catch {
          setFlow((current) => ({ ...current, stage: 'voice', demo, error: "Couldn't close the call. End it before leaving." }));
        }
        return;
      }
      setFlow((current) => ({ ...current, stage: 'voice', demo, error: '' }));
    } catch (error) {
      if (controller.signal.aborted || error?.name === 'AbortError') return;
      if (homeAfterVoiceStartRef.current) {
        homeAfterVoiceStartRef.current = false;
        window.location.assign('/');
        return;
      }
      setFlow((current) => ({ ...current, stage: 'meet', error: error?.code === 'voice_unavailable'
        ? "Calling isn't available right now. Please contact the Frontline team."
        : error?.message || "Couldn't start the call. Try again." }));
    } finally {
      if (voiceStartRef.current === controller) voiceStartRef.current = null;
    }
  };

  const finishVoice = async () => {
    const id = flow.demo?.demoId;
    if (!id || resultRequestRef.current) return;
    const controller = new AbortController();
    resultRequestRef.current = controller;
    try {
      await frontlineApi.endDemo(id, controller.signal);
      const result = await settledDemoResult(id, controller.signal);
      setFlow((current) => ({ ...current, stage: 'result', result, error: '' }));
    } catch (error) {
      if (controller.signal.aborted) return;
      setFlow((current) => ({ ...current, stage: 'result-error', error: error?.message || "Couldn't load the call result." }));
    } finally {
      if (resultRequestRef.current === controller) resultRequestRef.current = null;
    }
  };

  const leaveVoice = async () => {
    const id = flow.demo?.demoId;
    if (id) {
      try { await frontlineApi.endDemo(id); }
      catch {
        setFlow((current) => ({ ...current, stage: 'result-error', error: "Couldn't close the call. Try ending it again." }));
        return;
      }
    }
    window.sessionStorage.removeItem(DEMO_KEY);
    setFlow((current) => ({ ...current, stage: 'meet', demo: null, error: "The call ended. Start another when you're ready." }));
  };

  const goHome = (event) => {
    if (flow.stage === 'starting-voice' && voiceStartRef.current) {
      event.preventDefault();
      homeAfterVoiceStartRef.current = true;
      setFlow((current) => ({ ...current, error: 'Finishing the connection before leaving…' }));
      return;
    }
    if (flow.stage !== 'voice' || !flow.demo?.demoId) return;
    event.preventDefault();
    void frontlineApi.endDemo(flow.demo.demoId).then(() => {
      window.location.assign('/');
    }).catch(() => {
      setFlow((current) => ({ ...current, error: "Couldn't close the call. End it before leaving." }));
    });
  };

  if (reviewOpen) return <Experience entry={null} onExit={() => setReviewOpen(false)} />;
  if (flow.stage === 'landing') return <Landing initialWebsite={flow.website} onPrepare={beginPreparation} signInError={flow.error} />;
  if (flow.stage === 'restoring') return <TrialFrame><main className="bob-page" role="status">Loading your progress…</main></TrialFrame>;

  const preparation = flow.preparation;
  const availableModes = preparation?.availableModes ?? [];
  return <TrialFrame onHome={goHome}>
    {flow.stage === 'preparing' && <main><PreparationProgress stage="researching" onCancel={changeWebsite} /></main>}
    {flow.stage === 'preparation-error' && <main><PreparationProgress stage={preparation?.state === 'blocked' ? 'blocked' : preparationErrorStage(flow.errorCode)} message={flow.error} onRetry={retryPreparation} onCancel={changeWebsite} /></main>}
    {(flow.stage === 'meet' || flow.stage === 'starting-voice') && <main>
      {flow.error && <div className="trial-notice" role="alert">{flow.error}</div>}
      {flow.stage === 'starting-voice' && <div className="trial-notice" role="status">Starting the call…</div>}
      <MeetBob
        profile={preparation?.profile}
        readiness={preparation?.readiness}
        capabilityManifest={preparation?.capabilityManifest}
        businessFit={preparation?.businessFit}
        availableModes={availableModes}
        onTalkToBob={flow.stage === 'meet' && availableModes.includes('business_demo') ? () => startVoice('business_demo') : undefined}
        onAskFrontline={flow.stage === 'meet' && availableModes.includes('frontline_qa') ? () => startVoice('frontline_qa') : undefined}
        onRetryResearch={flow.stage === 'meet' ? changeWebsite : undefined}
      />
    </main>}
    {flow.stage === 'voice' && <main>{flow.error && <div className="trial-notice" role="alert">{flow.error}</div>}<BrowserVoice connection={flow.demo} businessName={preparation?.profile?.businessName} mode={flow.demo.mode} onEnd={finishVoice} onBack={leaveVoice} /></main>}
    {flow.stage === 'loading-result' && <main><PreparationProgress stage="compiling" message="Loading the call result…" /></main>}
    {flow.stage === 'result-error' && <main><PreparationProgress stage="failed_retryable" message={flow.error} onRetry={flow.errorSource === 'claim-return' ? returnToClaimResult : flow.demo?.demoId ? finishVoice : changeWebsite} onCancel={changeWebsite} /></main>}
    {flow.stage === 'result' && <DemoResult result={flow.result} onBack={() => setFlow((current) => ({ ...current, stage: 'meet' }))} onStartAgain={changeWebsite} onSave={() => { window.sessionStorage.setItem(SAVE_STEP_KEY, 'claim'); window.sessionStorage.setItem(SAVE_MODE_KEY, flow.result?.mode); setFlow((current) => ({ ...current, stage: 'claim' })); }} />}
    {flow.stage === 'claim' && <ClaimAgent demoId={flow.demo?.demoId} mode={flow.demo?.mode ?? flow.result?.mode} businessName={preparation?.profile?.businessName} onBack={returnToClaimResult} onRestart={changeWebsite} onClaimed={(claimedResource) => { window.sessionStorage.removeItem(SAVE_STEP_KEY); window.sessionStorage.removeItem(SAVE_MODE_KEY); window.sessionStorage.setItem(CLAIMED_RESOURCE_KEY, JSON.stringify(claimedResource)); if (ownerAppEnabled() && claimedResource.kind === 'agent') { setFlow((current) => ({ ...current, stage: 'additional-info', claimedResource })); return; } afterClaim(claimedResource); }} />}
    {flow.stage === 'additional-info' && <AdditionalInfo agentId={flow.claimedResource?.id} onDone={() => afterClaim(flow.claimedResource)} />}
    {flow.stage === 'setup' && <AgentSetup resource={flow.claimedResource} onRestart={changeWebsite} ownerApp={ownerAppEnabled()} />}
  </TrialFrame>;
}

/** Mounts the owner and guest screens next to the onboarding flow. Only used when the build enables them. */
function AppWithOwnerRoutes() {
  const { pathname } = useLocation();
  if (!isOwnerPath(pathname)) return <OnboardingApp />;
  return <Suspense fallback={null}><OwnerApp signIn={startOwnerSignIn} /></Suspense>;
}

export default function App() {
  if (import.meta.env.DEV && window.location.pathname === '/design-review') return <DesignReview />;
  return ownerAppEnabled() ? <AppWithOwnerRoutes /> : <OnboardingApp />;
}
