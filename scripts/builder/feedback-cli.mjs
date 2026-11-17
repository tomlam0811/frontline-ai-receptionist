#!/usr/bin/env node
// Builder feedback CLI. See docs/builder-feedback-cli.md. Run as:
//   FRONTLINE_API_URL=https://... node scripts/builder/feedback-cli.mjs feedback search --query "hours" --json
import { spawn } from 'node:child_process';
import { runCli } from './lib/cli.mjs';

const openBrowser = (url) => new Promise((resolve) => {
  const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  const child = spawn(opener, args, { stdio: 'ignore', detached: true });
  child.on('error', () => resolve(false));
  child.on('spawn', () => { child.unref(); resolve(true); });
});

process.exitCode = await runCli(process.argv.slice(2), { openBrowser });
