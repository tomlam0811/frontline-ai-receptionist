import { uuidFor } from './passages.js';

const GROUP_KEYS = { identity_contact: 'identityContact', locations_service_area: 'locationsServiceArea', services: 'services', office_hours: 'officeHours', service_hours: 'serviceHours', appointment_hours: 'appointmentHours', pricing_quote_policy: 'pricingQuotePolicy', booking_cancellation_policy: 'bookingCancellationPolicy', faq: 'faqs' };
const TOOLS = { 'WF-01': ['retrieve_facts', 'get_service_details'], 'WF-02': ['list_services', 'get_service_details'], 'WF-03': ['validate_request', 'save_request'], 'WF-04': ['lookup_appointment'], 'WF-05': ['save_case'], 'WF-06': ['record_escalation', 'end_session'] };
const deepFreeze = (value) => { if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.freeze(value); Object.values(value).forEach(deepFreeze); } return value; };

export function compileGroupedProfile(facts, passages, createdAt = new Date().toISOString()) {
  const groups = Object.fromEntries([...Object.values(GROUP_KEYS), 'unresolvedConflicts'].map((key) => [key, []]));
  for (const fact of facts) {
    const key = fact.eligibility === 'conflicting' ? 'unresolvedConflicts' : GROUP_KEYS[fact.group];
    if (key && ['eligible', 'conflicting'].includes(fact.eligibility)) groups[key].push(fact.factId);
  }
  const fingerprint = JSON.stringify({ facts, passageIds: passages.map(({ passageId }) => passageId) });
  return deepFreeze({
    profileRevisionId: uuidFor(`profile:${fingerprint}`), knowledgeRevisionId: uuidFor(`knowledge:${fingerprint}`), businessId: uuidFor(`business:${facts.find((fact) => fact.group === 'identity_contact')?.value ?? fingerprint}`), createdAt,
    groups, capabilities: Object.entries(TOOLS).map(([workflowId, allowedToolIds]) => ({ workflowId, enabled: true, allowedToolIds })), sourcePassageIds: passages.map(({ passageId }) => passageId),
  });
}
