import { createHash } from 'node:crypto';

const idFor = (text) => createHash('sha256').update(text).digest('hex').slice(0, 24);

export const frontlineProductKnowledge = Object.freeze([
  { id: 'frontline-demo-scope', predicate: 'demo_scope', value: 'Frontline demonstrates an AI customer-service assistant named Blake. The browser demo can answer supported questions and collect appointment or complaint details.', source: 'Frontline product specification v1', evidence: 'Browser demo is an AI customer-service demonstration.' },
  { id: 'frontline-demo-limits', predicate: 'demo_limit', value: 'The demo cannot book an appointment, send a request to a business, or connect a caller to a person.', source: 'Frontline product specification v1', evidence: 'Demo actions are simulated and no integration is enabled.' },
  { id: 'frontline-activation', predicate: 'activation', value: 'A business phone number is not active until provider ownership and inbound routing are confirmed.', source: 'Frontline product specification v1', evidence: 'Activation requires provider confirmation.' },
]);

export function compileBusinessKnowledge(prepared) {
  const { profile, evidence = {}, readiness } = prepared;
  if (!['ready', 'limited_ready'].includes(readiness) || !profile?.businessName || !profile.services?.length) return null;
  const facts = [];
  const add = (predicate, value, sourceUrl, excerpt) => {
    if (!value || !sourceUrl || !excerpt) return;
    facts.push({ id: idFor(`${predicate}:${value}:${sourceUrl}:${excerpt}`), predicate, value, sourceUrl, evidence: excerpt, status: 'eligible_for_demo' });
  };
  const structured = Boolean(prepared.sourceKnowledge);
  const groupedFacts = prepared.groupedFacts ?? [];
  const classifiedPassages = prepared.sourceKnowledge?.classifiedPassages ?? [];
  const groupedProfile = prepared.groupedProfile ?? null;
  if (structured) {
    // Rich research is authoritative: an older regex result cannot revive an ineligible fact.
    for (const fact of groupedFacts.filter((fact) => fact.eligibility === 'eligible')) {
      const passage = classifiedPassages.find(({ passageId }) => fact.passageIds.includes(passageId));
      if (!passage) continue;
      const predicate = prepared.sourceKnowledge.identityFactIds?.includes(fact.factId) ? 'business_name'
        : fact.group === 'services' ? 'service' : fact.group === 'office_hours' ? 'hours' : fact.group;
      add(predicate, String(fact.value), passage.source.url, passage.text);
    }
  } else {
    const identity = evidence.identity?.[0];
    add('business_name', profile.businessName, identity?.sourceUrl, identity?.quote);
    for (const service of profile.services) add('service', service.name, service.sourceUrl, service.evidence);
    if (profile.hours) add('hours', profile.hours.label, profile.hours.sourceUrl, profile.hours.evidence);
  }
  if (!facts.some((fact) => fact.predicate === 'business_name') || !facts.some((fact) => fact.predicate === 'service')) return null;
  const context = profile.location ? `${profile.businessName}, ${profile.location}` : profile.businessName;
  const manifest = {
    knowledgeCoverage: readiness === 'ready' ? 'sourced' : 'partial',
    actionReadiness: 'intake_only',
    capabilities: [
      { topic: 'Published services and hours', context, canDoNow: 'Answer questions supported by the cited website information.', cannotDecide: 'Cannot invent prices, availability, policies, diagnoses, or services that were not published.', handoff: 'Say what is unknown and offer the cited public contact route.' },
      { topic: 'Appointment requests', context, canDoNow: 'Collect service and preferred appointment details as a simulated request.', cannotDecide: 'Cannot check a calendar, book a slot, or send the request to the business.', handoff: 'Explain that the request is not booked or sent and suggest contacting the business directly.' },
      { topic: 'Complaints', context, canDoNow: 'Listen and collect a concern and desired outcome in the demo.', cannotDecide: 'Cannot determine fault, authorize compensation, or promise a response.', handoff: 'Offer the business’s cited public contact route when available.' },
      { topic: 'Human help', context, canDoNow: 'Recognize a request for a person and explain the demo limit.', cannotDecide: 'Cannot connect or call a person in this browser demo.', handoff: 'Offer cited public contact information when available.' },
    ],
    limits: ['Demo only', 'Appointment requests are not booked or sent', 'No live human transfer'],
  };
  manifest.workflowCapabilities = groupedProfile?.capabilities ?? [
    ['WF-01', ['retrieve_facts', 'get_service_details']], ['WF-02', ['list_services', 'get_service_details']], ['WF-03', ['validate_request', 'save_request']],
    ['WF-04', ['lookup_appointment']], ['WF-05', ['save_case']], ['WF-06', ['record_escalation', 'end_session']],
  ].map(([workflowId, allowedToolIds]) => ({ workflowId, enabled: true, allowedToolIds }));
  manifest.profileRevisionId = groupedProfile?.profileRevisionId ?? null;
  return { facts, manifest, groupedFacts, groupedProfile, classifiedPassages };
}

export function lookupBusinessFacts(facts, question) {
  const eligible = (Array.isArray(facts) ? facts : []).filter((fact) => fact?.status === 'eligible_for_demo' && fact.sourceUrl && fact.evidence);
  const query = String(question ?? '').toLowerCase().slice(0, 200);
  if (!query.trim()) return [];
  if (/\b(price|cost|fee|warranty|guarantee|availability|available slot|diagnos|refund|policy)\b/.test(query)) return [];
  if (/\b(hours?|open|clos(?:e|ing)|weekend)\b/.test(query)) return eligible.filter((fact) => fact.predicate === 'hours').slice(0, 3);
  if (/\b(name|who are you|which business)\b/.test(query)) return eligible.filter((fact) => fact.predicate === 'business_name').slice(0, 1);
  const services = eligible.filter((fact) => fact.predicate === 'service');
  if (/^(?:services?)$/.test(query.trim()) || /^(?:what services|which services|what do you (?:offer|provide)|(?:list|show)(?: your)? services)\b/.test(query)) return services.slice(0, 5);
  const tokens = query.match(/[a-z]{3,}/g)?.map((word) => word.replace(/(?:ing|es|s)$/, '')) ?? [];
  const stop = new Set(['what', 'which', 'your', 'that', 'this', 'with', 'about', 'have', 'does', 'could', 'would', 'please', 'service', 'offer', 'provide', 'help', 'when', 'where', 'business']);
  const meaningful = tokens.filter((token) => !stop.has(token));
  if (!meaningful.length) return [];
  return services.filter((fact) => {
    const value = String(fact.value).toLowerCase();
    return meaningful.some((token) => value.includes(token));
  }).slice(0, 5);
}
