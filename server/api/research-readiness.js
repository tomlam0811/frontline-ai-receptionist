export function researchConfiguration(env = process.env) {
  const missing = [];
  if (typeof env.EXA_API_KEY !== 'string' || !env.EXA_API_KEY.trim()) missing.push('EXA_API_KEY');
  const dailyLimit = Number(env.FRONTLINE_EXA_DAILY_MAX_PREPARATIONS);
  if (!Number.isSafeInteger(dailyLimit) || dailyLimit < 1 || dailyLimit > 10_000) {
    missing.push('FRONTLINE_EXA_DAILY_MAX_PREPARATIONS');
  }
  return { ready: missing.length === 0, missing };
}
