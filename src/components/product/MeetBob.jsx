import { useState } from 'react';
import { receptionistName } from '../../lib/receptionist-name.js';
import './meet-bob.css';

const WORKFLOW_COPY = {
  'WF-01': ['Questions', 'Ask about the business.'],
  'WF-02': ['Service choice', 'Find a service that fits your needs.'],
  'WF-03': ['New requests', 'Leave your details for review.'],
  'WF-04': ['Existing requests', 'Check a cancellation or reschedule request.'],
  'WF-05': ['Complaints', 'Record feedback for the owner.'],
  'WF-06': ['Human help', 'Leave a request for human help.'],
};

// The intro reads "ready to help with things like gutter cleaning". Some websites give services as whole marketing
// sentences ("Harbor Plastics delivers industrial plastic materials ... facilities."), which read badly there, so only a
// short name is used, and the clause is left out when there is none.
const INTRO_SERVICE_WORDS = 5;

function introServiceName(services) {
  const name = services.map((service) => service.name.trim()).find((candidate) => candidate.split(/\s+/).length <= INTRO_SERVICE_WORDS && !/[.!?;:]/.test(candidate));
  if (!name) return null;
  // Lowercase capitalized words ("Full-Service Fabrication" becomes "full-service fabrication") but keep acronyms ("CNC").
  return name.replace(/\b[A-Z][a-z]+\b/g, (word) => word.toLowerCase());
}

// Frontline serves US small and medium service businesses (Tom, 2026-10-03). The server labels other businesses
// not_fit; they see what Frontline offers today and can still try the demo.
const CONTACT_EMAIL = import.meta.env.VITE_FRONTLINE_CONTACT_EMAIL || 'hello@frontline.example';

// "Harbor Plastics' customers", not "Harbor Plastics's". A trailing "(BPW)" reads badly mid-sentence, so sentences drop it;
// the label above the heading keeps the full name.
function possessiveName(businessName) {
  const plain = businessName.replace(/\s*\([^)]*\)\s*$/, '') || businessName;
  return /s$/i.test(plain) ? `${plain}'` : `${plain}'s`;
}

function normalizeService(item) {
  if (typeof item === 'string') return { name: item };
  return item && typeof item === 'object' ? item : null;
}

export default function MeetBob({
  profile,
  readiness = 'insufficient_context',
  capabilities: suppliedCapabilities = undefined,
  capabilityManifest = undefined,
  availableModes = undefined,
  onTalkToBob = undefined,
  onRetryResearch = undefined,
  onAskFrontline = undefined,
  name = receptionistName(),
  businessFit = null,
  contactEmail = CONTACT_EMAIL,
}) {
  const [triesAnyway, setTriesAnyway] = useState(false);
  const businessName = typeof profile?.businessName === 'string' ? profile.businessName.trim() : '';
  const location = typeof profile?.location === 'string' ? profile.location.trim() : '';
  const services = (Array.isArray(profile?.services) ? profile.services : [])
    .map(normalizeService)
    .filter((service) => typeof service?.name === 'string' && service.name.trim());
  const manifestItems = Array.isArray(capabilityManifest?.capabilities) ? capabilityManifest.capabilities : null;
  const listedCapabilities = Array.isArray(suppliedCapabilities) ? suppliedCapabilities : profile?.capabilities;
  // Legacy prepared profiles predate workflow IDs. Business-demo eligibility still
  // comes from server readiness/modes; presentation uses the approved six paths.
  const hasCapabilities = manifestItems ? manifestItems.length > 0 : Array.isArray(listedCapabilities) && listedCapabilities.length > 0;
  const canonicalItems = manifestItems?.filter((item) => WORKFLOW_COPY[item?.workflowId]);
  const workflowIds = canonicalItems?.length
    ? canonicalItems.filter((item) => item.enabled === true).map((item) => item.workflowId)
    : hasCapabilities ? Object.keys(WORKFLOW_COPY) : [];
  const capabilityCount = new Set(workflowIds).size;
  const manifestReady = !capabilityManifest || (capabilityManifest.actionReadiness === 'intake_only' && ['sourced', 'partial'].includes(capabilityManifest.knowledgeCoverage)) || capabilityCount > 0;
  const modeReady = !availableModes || (Array.isArray(availableModes) && availableModes.includes('business_demo'));
  const isBusinessReady = (readiness === 'ready' || readiness === 'limited_ready') && businessName && services.length > 0 && capabilityCount > 0 && manifestReady && modeReady;
  const isLimited = readiness === 'limited_ready';
  const isInsufficient = readiness === 'insufficient_context';

  if (businessFit?.verdict === 'not_fit' && !triesAnyway) return (
    <div className="bob-page">
      <section className="bob-intro" aria-labelledby="bob-title">
        <p className="bob-eyebrow">{businessName || 'Website'}</p>
        <h1 id="bob-title">Frontline is built for small service businesses</h1>
        <p>Right now, Frontline offers AI customer service for small and medium service businesses in the US, like salons, barbershops, cleaning, landscaping, auto care and home services.</p>
        <p>{`If you'd like ${name} for your business, contact the Frontline team for a consultation.`}</p>
        <div className="bob-actions">
          {contactEmail && <a className="bob-button bob-button--primary" href={`mailto:${contactEmail}?subject=${encodeURIComponent('Frontline consultation')}`}>Contact the Frontline team</a>}
          <button className={`bob-button ${contactEmail ? 'bob-button--secondary' : 'bob-button--primary'}`} type="button" onClick={() => setTriesAnyway(true)}>{`Try ${name} anyway`}</button>
          {onRetryResearch && <button className="bob-button bob-button--quiet" type="button" onClick={onRetryResearch}>Try another website</button>}
        </div>
      </section>
    </div>
  );

  if (!isBusinessReady) return (
    <div className="bob-page">
      <section className="bob-intro" aria-labelledby="bob-title">
        <p className="bob-eyebrow">Website</p>
        <h1 id="bob-title">{name} needs more business information.</h1>
        <p>{`Couldn't confirm the business or its services from that website. ${name} won't guess.`}</p>
      </section>
      <section className="bob-fallback" aria-labelledby="bob-fallback-title">
        <div className="bob-avatar" aria-hidden="true">B</div>
        <div>
          <h2 id="bob-fallback-title">{isInsufficient ? 'Ask about Frontline' : 'Try another website'}</h2>
          <p>{isInsufficient ? `${name} can explain Frontline. Questions about the business and appointment requests aren't available here.` : `${name} needs a page that lists your services. Try another website.`}</p>
          <div className="bob-actions">
            {isInsufficient && onAskFrontline && <button className="bob-button bob-button--primary" type="button" onClick={onAskFrontline}>{`Ask ${name}`}</button>}
            {onRetryResearch && <button className={`bob-button ${isInsufficient ? 'bob-button--secondary' : 'bob-button--primary'}`} type="button" onClick={onRetryResearch}>Try again</button>}
          </div>
        </div>
      </section>
    </div>
  );

  const topService = introServiceName(services);

  return (
    <div className="bob-page bob-meet" aria-labelledby="bob-title">
      <section className="bob-meet__card" aria-labelledby="bob-title">
        <div className="bob-meet__identity">
          <div className="bob-avatar" aria-hidden="true">B</div>
          <div>
            <p className="bob-identity__label">{businessName}{location ? ` · ${location}` : ''}</p>
            <h1 id="bob-title">{`Meet ${name}`}</h1>
          </div>
        </div>
        <p className="bob-meet__intro-copy">
          {`${name} is ${possessiveName(businessName)} AI receptionist${topService ? `, ready to help with things like ${topService}` : ''}.`}
          {' '}It answers questions, helps callers pick a service, and takes a request when no one is free to pick up.
        </p>
        <p className="bob-meet__role-instruction">{`Talk to ${name} the way ${possessiveName(businessName)} customers would.`}</p>
        {isLimited && <p className="bob-meet__limited" role="status">Some business details are missing.</p>}
        <div className="bob-actions bob-meet__actions">
          <button className="bob-button bob-button--primary" type="button" onClick={onTalkToBob} disabled={!onTalkToBob}>{`Talk to ${name}`}</button>
        </div>
      </section>
    </div>
  );
}
