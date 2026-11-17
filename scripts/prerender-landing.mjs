import { readFile, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import React from 'react';
import { renderToString } from 'react-dom/server';

const outputPath = resolve('dist/index.html');
const serverModulePath = resolve('dist/.landing-ssr.mjs');

try {
  await build({
    entryPoints: [resolve('src/pages/Landing.jsx')],
    outfile: serverModulePath,
    bundle: true,
    format: 'esm',
    jsx: 'automatic',
    packages: 'external',
    platform: 'node',
    plugins: [{
      name: 'ignore-page-css',
      setup(bundle) {
        bundle.onResolve({ filter: /\.css$/ }, (args) => ({ path: args.path, namespace: 'page-css' }));
        bundle.onLoad({ filter: /.*/, namespace: 'page-css' }, () => ({ contents: '', loader: 'js' }));
      },
    }],
  });

  const { default: Landing } = await import(pathToFileURL(serverModulePath).href);
  const markup = renderToString(React.createElement(React.StrictMode, null, React.createElement(Landing)));
  const template = await readFile(outputPath, 'utf8');
  const mount = '<div id="root"></div>';
  if (!template.includes(mount)) throw new Error('Built HTML is missing the React mount point.');
  await writeFile(outputPath, template.replace(mount, `<div id="root">${markup}</div>`));
} finally {
  await unlink(serverModulePath).catch(() => {});
}
