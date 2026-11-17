import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { ownerDevPlugin } from './scripts/owner-dev/plugin.mjs';

// Development harness for the owner and guest screens. Run: npx vite --config vite.owner-dev.config.mjs
export default defineConfig({
  plugins: [react(), ownerDevPlugin()],
  server: { port: 5188, host: 'localhost' },
});
