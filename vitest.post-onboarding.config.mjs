import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Scaffold-only runner so tests/post-onboarding/** runs without editing vite.config.js.
// Run it with `npm run test:post-onboarding` (PO-C15). The main config is left alone so `npm test` is unchanged.
// Each test file starts an in-process Postgres, so hooks get the same generous timeout as tests.
// Browser tests opt into jsdom with `// @vitest-environment jsdom` at the top of the file.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'node',
    include: ['tests/post-onboarding/**/*.test.{js,jsx}'],
    setupFiles: ['./tests/post-onboarding/ui-setup.js'],
    testTimeout: 60000,
    hookTimeout: 60000,
  },
});
