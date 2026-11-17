import { useCallback, useEffect, useState } from 'react';
import { frontlineApi } from '../../lib/frontline-api.js';
import { receptionistName } from '../../lib/receptionist-name.js';
import OwnerHistory from './OwnerHistory.jsx';

const MAX_CONTEXT = 8000;

function setupError(error) {
  if (error?.status === 401 || error?.status === 403 || error?.status === 404) return 'Sign in with the account that saved this demo.';
  if (error?.status === 503) return "Setup isn't available right now. Please contact the Frontline team.";
  return error?.message || "Couldn't load your receptionist. Try again.";
}

function confirmedNumber(agent) {
  const activation = agent?.activation;
  return activation?.status === 'active' && activation.providerConfirmed === true && typeof activation.phoneNumber === 'string' && activation.phoneNumber.trim();
}

export default function AgentSetup({ resource, onRestart, ownerApp = false }) {
  const [agent, setAgent] = useState(null);
  const [selected, setSelected] = useState([]);
  const [context, setContext] = useState('');
  const [state, setState] = useState('loading');
  const [message, setMessage] = useState('');
  const [needsSignIn, setNeedsSignIn] = useState(false);
  const name = receptionistName(agent);
  const draftKey = resource?.id && ['agent', 'workspace'].includes(resource.kind)
    ? `frontline.setupDraft.${resource.kind}.${resource.id}` : null;

  const load = useCallback(async (signal) => {
    setState('loading');
    setMessage('');
    try {
      if (!resource?.id || !['agent', 'workspace'].includes(resource.kind)) throw new Error("Couldn't find this saved setup.");
      const response = resource.kind === 'agent'
        ? await frontlineApi.getAgent(resource.id, signal)
        : await frontlineApi.getWorkspace(resource.id, signal);
      const confirmedId = resource.kind === 'agent' ? response?.agentId : response?.workspaceId;
      if (confirmedId !== resource.id || response.claimState !== 'claimed') throw new Error("Couldn't confirm this saved setup.");
      setAgent(response);
      const saved = response.setup?.selectedCapabilityIds;
      const recommended = response.setup?.recommendedUseCase?.id;
      let draft = null;
      try { draft = draftKey ? JSON.parse(window.sessionStorage.getItem(draftKey)) : null; }
      catch { /* Ignore invalid tab-local drafts. */ }
      const savedSelected = Array.isArray(saved) ? saved : recommended ? [recommended] : [];
      setSelected(Array.isArray(draft?.selected) && draft.selected.every((id) => typeof id === 'string') ? draft.selected : savedSelected);
      setContext(typeof draft?.context === 'string' ? draft.context : typeof response.setup?.missingContext === 'string' ? response.setup.missingContext : '');
      if (draft) setMessage('Changes from before are back in the form. Review them, then save.');
      setNeedsSignIn(false);
      setState('ready');
    } catch (error) {
      if (signal?.aborted) return;
      setNeedsSignIn([401, 403, 404].includes(error?.status));
      setState('error');
      setMessage(setupError(error));
    }
  }, [resource?.id, resource?.kind, draftKey]);

  async function signInAgain() {
    if (!resource?.id || !['agent', 'workspace'].includes(resource.kind)) return;
    setState('reauth');
    setMessage('');
    try {
      if (draftKey && agent) window.sessionStorage.setItem(draftKey, JSON.stringify({ selected, context }));
      const response = await frontlineApi.reauthGoogle(resource.kind, resource.id);
      const url = new URL(response?.authorizationUrl || '', window.location.origin);
      if (!response?.authorizationUrl || url.origin !== 'https://accounts.google.com' || url.pathname !== '/o/oauth2/v2/auth') throw new Error("Google sign-in isn't available right now. Try again.");
      window.location.assign(url.href);
    } catch (error) {
      setState('error');
      setMessage(setupError(error));
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  function toggleCapability(id) {
    setSelected((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  }

  async function saveSetup(event) {
    event.preventDefault();
    if (!agent || state === 'saving') return;
    if (context.trim().length > MAX_CONTEXT) { setMessage(`The business details are ${context.trim().length.toLocaleString('en-US')} characters. Shorten them to ${MAX_CONTEXT.toLocaleString('en-US')} or fewer and save again.`); return; }
    setState('saving');
    setMessage('');
    try {
      const response = resource.kind === 'agent'
        ? await frontlineApi.saveAgentSetup(resource.id, { expectedVersion: agent.setupVersion, selectedCapabilityIds: selected, missingContext: context.trim() })
        : await frontlineApi.saveWorkspaceContext(resource.id, { expectedVersion: agent.setupVersion, missingContext: context.trim() });
      const confirmedId = resource.kind === 'agent' ? response?.agentId : response?.workspaceId;
      if (confirmedId !== resource.id || response?.setup?.state !== 'saved' || !response?.setupVersion) throw new Error("Couldn't confirm that the setup was saved. Refresh to check.");
      if (draftKey) window.sessionStorage.removeItem(draftKey);
      setAgent(response);
      setState('ready');
      setMessage(resource.kind === 'workspace' ? 'Business details saved. No receptionist is active yet.' : (ownerApp ? 'Setup saved.' : "Setup saved. Phone numbers aren't available yet."));
    } catch (error) {
      const expired = [401, 403, 404].includes(error?.status);
      setNeedsSignIn(expired);
      setState(expired ? 'error' : 'ready');
      setMessage(setupError(error));
    }
  }

  if (state === 'loading') return <main className="bob-page setup-page"><p className="bob-eyebrow">{resource?.kind === 'workspace' ? 'Setup' : 'Receptionist'}</p><h1>{resource?.kind === 'workspace' ? 'Loading your saved setup…' : 'Loading your receptionist…'}</h1></main>;
  if (state === 'reauth') return <main className="bob-page setup-page"><p role="status">Opening Google sign-in…</p></main>;
  if (state === 'error') return <main className="bob-page setup-page"><p className="bob-eyebrow">Saved progress</p><h1>{"Couldn't open setup."}</h1><p role="alert">{message}</p><div className="bob-actions">{needsSignIn && <button type="button" className="bob-button bob-button--primary" onClick={signInAgain}>Sign in</button>}<button type="button" className="bob-button bob-button--secondary" onClick={() => load()}>Try again</button><button type="button" className="bob-button bob-button--secondary" onClick={onRestart}>Start over</button></div></main>;

  if (resource.kind === 'workspace') return <main className="bob-page setup-page" aria-labelledby="workspace-title">
    <section className="bob-intro"><p className="bob-eyebrow">Setup</p><h1 id="workspace-title">Add business details.</h1><p>This conversation is saved. Add details about the business to get a receptionist ready.</p></section>
    <form className="setup-card" onSubmit={saveSetup}><p className="setup-card__label">Missing details</p><h2>{`What should ${name} know about the business?`}</h2><p>Start with the website, services, location, and hours. {"New details are checked before they're used."}</p><label className="setup-context" htmlFor="workspace-context">Business details</label><textarea id="workspace-context" rows="6" value={context} onChange={(event) => setContext(event.target.value)} disabled={state === 'saving'} placeholder="Paste your website or type details about the business." />{context.length > MAX_CONTEXT * 0.8 && <p className="setup-caution" role="status">{context.length.toLocaleString('en-US')} of {MAX_CONTEXT.toLocaleString('en-US')} characters{context.length > MAX_CONTEXT ? '. Shorten this to save.' : '.'}</p>}<div className="bob-actions"><button className="bob-button bob-button--primary" disabled={state === 'saving'}>{state === 'saving' ? 'Saving…' : 'Save details'}</button><button type="button" className="bob-button bob-button--secondary" onClick={() => load()} disabled={state === 'saving'}>Refresh</button></div>{message && <p className="claim-message" role="status">{message}</p>}</form>
    {ownerApp ? <section className="setup-card"><p className="setup-card__label">Receptionist</p><h2>Not ready yet</h2><p>The receptionist is ready once business details are added.</p><a className="bob-button bob-button--secondary" href="/app">Open receptionist</a></section> : <section className="setup-card setup-activation"><p className="setup-card__label">Phone number</p><h2>No phone number yet</h2><p>A number shows here once setup is finished and the number is ready.</p></section>}
    <OwnerHistory resource={resource} />
  </main>;

  const activeNumber = confirmedNumber(agent);
  const capabilities = Array.isArray(agent.setup?.supportedCapabilities) ? agent.setup.supportedCapabilities.filter((item) => typeof item?.id === 'string' && typeof item?.label === 'string') : [];

  if (activeNumber) return <main className="bob-page setup-page" aria-labelledby="agent-home-title">
    <p className="bob-eyebrow">Receptionist</p><h1 id="agent-home-title">{name} is active.</h1>
    <section className="setup-card"><p className="setup-card__label">Phone number</p><p className="setup-phone">{activeNumber}</p><p>{`Call this number to talk to ${name} before sharing it with customers.`}</p></section>
    <section className="setup-card"><h2>Improvements</h2><p>Check Knowledge after each call.</p></section>
    <OwnerHistory resource={resource} />
  </main>;

  return <main className="bob-page setup-page" aria-labelledby="setup-title">
    <section className="bob-intro"><p className="bob-eyebrow">Setup</p><h1 id="setup-title">{`Set up ${name} for ${agent.businessName || 'your business'}.`}</h1><p>{`Pick what ${name} helps with, then add anything missing.`}</p></section>
    <form onSubmit={saveSetup} className="setup-card">
      <p className="setup-card__label">Recommended</p>
      {agent.setup?.recommendedUseCase?.label ? <><h2>{agent.setup.recommendedUseCase.label}</h2><p>{agent.setup.recommendedUseCase.reason || 'Check this recommendation before saving.'}</p></> : <p>No recommendation yet.</p>}
      {capabilities.length > 0 && <fieldset className="setup-options"><legend>{`What ${name} helps with`}</legend>{capabilities.map((item) => <label key={item.id}><input type="checkbox" checked={selected.includes(item.id)} onChange={() => toggleCapability(item.id)} disabled={state === 'saving'} /><span><strong>{item.label}</strong>{item.description && <small>{item.description}</small>}</span></label>)}</fieldset>}
      <label className="setup-context" htmlFor="setup-context">Business details</label><textarea id="setup-context" rows="5" value={context} onChange={(event) => setContext(event.target.value)} disabled={state === 'saving'} placeholder={`Add details like services or policies ${name} should know.`} />{context.length > MAX_CONTEXT * 0.8 && <p className="setup-caution" role="status">{context.length.toLocaleString('en-US')} of {MAX_CONTEXT.toLocaleString('en-US')} characters{context.length > MAX_CONTEXT ? '. Shorten this to save.' : '.'}</p>}
      <p className="setup-caution">{"New details stay a draft until they're checked and applied. Adding details doesn't unlock actions or appointment times."}</p>
      <div className="bob-actions"><button className="bob-button bob-button--primary" disabled={state === 'saving'}>{state === 'saving' ? 'Saving…' : 'Save setup'}</button><button type="button" className="bob-button bob-button--secondary" onClick={() => load()} disabled={state === 'saving'}>Refresh</button></div>
      {message && <p className="claim-message" role="status">{message}</p>}
    </form>
    {ownerApp ? <section className="setup-card"><p className="setup-card__label">Receptionist</p><h2>Setup saved</h2><p>Open the receptionist to talk to it and share it.</p><a className="bob-button bob-button--primary" href="/app">Open receptionist</a></section> : <section className="setup-card setup-activation"><p className="setup-card__label">Phone number</p><h2>No phone number yet</h2><p>A number shows here once setup is finished and the number is ready.</p>{agent.activation?.status === 'failed' && <p role="alert">{"Couldn't get a phone number. Refresh to check again."}</p>}{agent.activation?.status === 'pending' && <p role="status">Getting the phone number ready. Refresh to check.</p>}</section>}
    <OwnerHistory resource={resource} />
  </main>;
}
