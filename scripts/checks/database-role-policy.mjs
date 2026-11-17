// Check database credential placement by role only. Never return or print a URL.
const has = (variables, name) => Object.hasOwn(variables, name);
const loginOf = (value) => {
  try { return decodeURIComponent(new URL(value).username); }
  catch { return null; }
};

export function inspectDatabaseRoleAssignments({ api, voice, retention }) {
  if (!api || !voice || !retention) return { status: 'unknown', evidence: 'API, voice, and retention variable data were not all readable' };
  const problems = [];
  if (loginOf(api.DATABASE_URL ?? '') !== 'frontline_app') problems.push('API DATABASE_URL does not use the frontline_app login');
  if (has(api, 'FRONTLINE_CLEANUP_DATABASE_URL')) problems.push('FRONTLINE_CLEANUP_DATABASE_URL is set on the API');
  if (has(voice, 'DATABASE_URL') || has(voice, 'FRONTLINE_CLEANUP_DATABASE_URL')) problems.push('voice worker has a database URL');
  if (loginOf(retention.FRONTLINE_CLEANUP_DATABASE_URL ?? '') !== 'frontline_cleanup') problems.push('retention FRONTLINE_CLEANUP_DATABASE_URL does not use the frontline_cleanup login');
  if (has(retention, 'DATABASE_URL')) problems.push('DATABASE_URL is set on the retention worker');
  for (const [name, variables] of [['API', api], ['voice worker', voice], ['retention worker', retention]]) {
    if (has(variables, 'DIRECT_DATABASE_URL')) problems.push('DIRECT_DATABASE_URL is set on the ' + name);
  }
  return {
    status: problems.length ? 'fail' : 'pass',
    evidence: problems.length ? problems.join('; ') : 'API, voice, and retention database credential roles match the least-privilege policy'
  };
}
