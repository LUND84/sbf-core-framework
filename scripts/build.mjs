import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

// Bundle browser-only package imports into a same-origin module.
// Reason: static serving alone cannot resolve npm package names in the browser.
await build({
  absWorkingDir: root,
  entryPoints: ['web/public/app.js'],
  outfile: 'web/public/app.bundle.js',
  bundle: true,
  platform: 'browser',
  format: 'esm',
  target: ['es2022'],
  sourcemap: false,
  legalComments: 'eof',
  logLevel: 'info',
});
