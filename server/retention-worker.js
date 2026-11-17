import { createAnonymousRetention } from './api/retention.js';

// Foreground process. A deployment supervisor starts and monitors this worker;
// the web server does not implicitly run cleanup or gate API traffic on it.
let worker;
let stopping = false;

async function stop(failed = false) {
  if (stopping) return;
  stopping = true;
  if (failed) process.exitCode = 1;
  try { await worker?.close(); }
  catch { process.exitCode = 1; }
}

try {
  worker = createAnonymousRetention({
    onSweepError: () => {
      console.error('Anonymous retention sweep failed.');
      void stop(true);
    },
  });
  process.once('SIGTERM', () => { void stop(); });
  process.once('SIGINT', () => { void stop(); });
  await worker.start({ keepAlive: true });
  console.log('Anonymous retention worker ready.');
} catch {
  console.error('Anonymous retention worker could not start.');
  await stop(true);
}
