import { researchConfiguration } from '../server/api/research-readiness.js';

const config = researchConfiguration();
const missing = [...config.missing];
if (process.env.FRONTLINE_START_POSTGRES_PREPARATION_WORKER === '1' && !process.env.DATABASE_URL) {
  missing.push('DATABASE_URL');
}
if (missing.length) {
  console.error(`Frontline website research is not configured. Missing or invalid settings: ${missing.join(', ')}.`);
  console.error('Connect this checkout to the Frontline Secret Manager project and run the appropriate dev command again.');
  process.exit(1);
}

console.log('Frontline website research settings are present.');
