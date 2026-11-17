export const schemaVersion = '1.0';

export function requireObject(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw problem(400, 'invalid_body', 'Send a JSON object.');
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw problem(400, 'unknown_field', `Unknown field: ${key}.`);
  return value;
}

export function problem(status, code, detail) {
  return Object.assign(new Error(detail), { status, code });
}

export function publicPreparation(record) {
  return {
    preparationId: record.id,
    state: record.state,
    readiness: ['ready', 'limited_ready', 'insufficient_context'].includes(record.state) ? record.state : null,
    revision: record.revision,
    profile: record.profile ?? null,
    gaps: record.gaps ?? [],
    businessFit: record.businessFit ? { verdict: record.businessFit.verdict, businessType: record.businessFit.businessType } : null,
    capabilityManifest: record.capabilityManifest ?? null,
    availableModes: record.state === 'ready' || record.state === 'limited_ready' ? ['business_demo'] : record.state === 'insufficient_context' ? ['frontline_qa'] : [],
    knowledgeRevisionId: record.knowledgeRevisionId ?? null,
    agentVersionId: record.agentVersionId ?? null,
    error: record.error ?? null,
    expiresAt: record.expiresAt,
    version: schemaVersion,
  };
}
