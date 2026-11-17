import { problem } from './errors.js';
import { DEFAULT_RECEPTIONIST_NAME } from './receptionist-name.js';

// Owner-controlled workflows (technical spec PO-TD12, product spec capability table).
// WF-01 and WF-06 are always on. The server is the authority on this; the UI only mirrors it.

export const REQUIRED_WORKFLOWS = ['WF-01', 'WF-06'];
export const OPTIONAL_WORKFLOWS = ['WF-02', 'WF-03', 'WF-04', 'WF-05'];
export const WORKFLOW_TOOLS = {
  'WF-01': ['retrieve_facts', 'get_service_details'], 'WF-02': ['list_services', 'get_service_details'], 'WF-03': ['validate_request', 'save_request'],
  'WF-04': ['lookup_appointment'], 'WF-05': ['save_case'], 'WF-06': ['record_escalation', 'end_session'],
};

/** Plain-language description of what turning each optional workflow off means. */
export const WORKFLOW_NOTES = {
  'WF-02': (name) => `Off: ${name} stops suggesting services unprompted. ${name} still answers questions about services.`,
  'WF-03': (name) => `Off: ${name} explains that a service request cannot be taken, and nothing is saved. Appointment lookups will not offer a new request.`,
  'WF-04': (name) => `Off: ${name} explains that appointments cannot be looked up or changed.`,
  'WF-05': (name) => `Off: ${name} still listens and shows care, but does not save the complaint.`,
};

const fail = (status, code, message) => problem(status, code, message);

/** The workflow list from a manifest, always all six, defaulting to enabled (existing agents are all enabled). */
export function workflowList(manifest) {
  const stored = new Map((manifest?.workflowCapabilities ?? []).map((item) => [item.workflowId, item]));
  return Object.keys(WORKFLOW_TOOLS).map((workflowId) => ({
    workflowId, enabled: REQUIRED_WORKFLOWS.includes(workflowId) ? true : stored.get(workflowId)?.enabled !== false,
    allowedToolIds: stored.get(workflowId)?.allowedToolIds ?? WORKFLOW_TOOLS[workflowId],
  }));
}

export const enabledWorkflowIds = (manifest) => workflowList(manifest).filter((item) => item.enabled).map((item) => item.workflowId);

/** What the owner sees on the Capabilities screen. */
export function workflowView(manifest, name = DEFAULT_RECEPTIONIST_NAME) {
  return workflowList(manifest).map((item) => ({ workflowId: item.workflowId, enabled: item.enabled, required: REQUIRED_WORKFLOWS.includes(item.workflowId), note: WORKFLOW_NOTES[item.workflowId]?.(name) ?? null }));
}

/**
 * Applies the owner's toggles to the current manifest's workflows and returns the new list.
 * `toggles` may name only the optional workflows. Naming a required workflow as off is refused, and
 * naming anything else is refused, so a client can never widen what the receptionist may do.
 */
export function applyWorkflowToggles(manifest, toggles) {
  if (!toggles || typeof toggles !== 'object' || Array.isArray(toggles)) throw fail(400, 'invalid_field', 'workflows: send an object of workflow ids.');
  for (const [workflowId, value] of Object.entries(toggles)) {
    if (REQUIRED_WORKFLOWS.includes(workflowId)) {
      if (value !== true) throw fail(422, 'required_workflow_disabled', 'That workflow is always on.');
      continue;
    }
    if (!OPTIONAL_WORKFLOWS.includes(workflowId)) throw fail(400, 'unsupported_workflow', 'Choose a supported workflow.');
    if (typeof value !== 'boolean') throw fail(400, 'invalid_field', `workflows.${workflowId}: send true or false.`);
  }
  return workflowList(manifest).map((item) => ({ ...item, enabled: REQUIRED_WORKFLOWS.includes(item.workflowId) ? true : (typeof toggles[item.workflowId] === 'boolean' ? toggles[item.workflowId] : item.enabled) }));
}

/** The compiler's own check, independent of applyWorkflowToggles, so no other path can publish a bad manifest. */
export function assertRequiredWorkflowsEnabled(workflows) {
  for (const workflowId of REQUIRED_WORKFLOWS) {
    if (workflows.find((item) => item.workflowId === workflowId)?.enabled !== true) throw Object.assign(fail(422, 'compile_failed', 'A required workflow is disabled.'), { detailCode: 'required_workflow_disabled' });
  }
}

/** Behavior rules that follow from the enabled set (PO-TD12 dependency rules). */
export const constraintsFor = (workflows) => ({ offerNewRequestAllowed: workflows.find((item) => item.workflowId === 'WF-03')?.enabled === true });
