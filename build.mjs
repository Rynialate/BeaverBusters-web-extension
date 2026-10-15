// Builds browser-specific packages from src/: dist/chrome, dist/firefox and a .zip of each.
// Usage: node build.mjs            (both)    node build.mjs firefox   (one)
import { cpSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const base = JSON.parse(readFileSync(join(root, 'src/manifest.json'), 'utf8'));
const targets = process.argv.slice(2).length ? process.argv.slice(2) : ['chrome', 'firefox'];

const perBrowser = {
  chrome: m => ({
    ...m,
    background: { service_worker: 'background.js', type: 'module' },
    minimum_chrome_version: '116',
  }),
  firefox: m => ({
    ...m,
    background: { scripts: ['background.js'], type: 'module' },
    browser_specific_settings: {
      gecko: {
        id: 'beaverbusters-checker@netherportal3.com',
        strict_min_version: '128.0',
        data_collection_permissions: { required: ['browsingActivity', 'websiteContent'] },
      },
    },
  }),
};

for (const t of targets) {
  if (!perBrowser[t]) throw new Error('Unknown target ' + t);
  const out = join(root, 'dist', t);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  cpSync(join(root, 'src'), out, { recursive: true });
  writeFileSync(join(out, 'manifest.json'), JSON.stringify(perBrowser[t](base), null, 2) + '\n');
  const zip = join(root, 'dist', `beaverbusters-checker-${t}-${base.version}.zip`);
  if (existsSync(zip)) rmSync(zip);
  execFileSync('zip', ['-qr', '-X', zip, '.'], { cwd: out });
  console.log(`built ${t}: dist/${t}  ->  ${zip.slice(root.length + 1)}`);
}
