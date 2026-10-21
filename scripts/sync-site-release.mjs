import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const { version } = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
const indexPath = new URL('docs/index.html', root);
const original = await readFile(indexPath, 'utf8');
let updated = original.replace(
  /(<span data-release-version>)[^<]+(<\/span>)/g,
  (_match, open, close) => `${open}${version}${close}`
);
// Keep static links usable when JavaScript is disabled.
updated = updated
  .replace(/("softwareVersion": ")[^"]+("[,\s])/g, (_match, open, close) => `${open}${version}${close}`)
  .replace(
    /\/releases\/download\/v\d+\.\d+\.\d+\/YouYu-\d+\.\d+\.\d+-x64/g,
    `/releases/download/v${version}/YouYu-${version}-x64`
  )
  .replace(/\/releases\/tag\/v\d+\.\d+\.\d+/g, `/releases/tag/v${version}`);
for (const asset of ['site.css', 'site.js']) {
  const content = (await readFile(new URL(`docs/assets/${asset}`, root), 'utf8')).replace(/\r\n/g, '\n');
  const digest = createHash('sha256').update(content).digest('hex').slice(0, 10);
  const escaped = asset.replace('.', '\\.');
  updated = updated.replace(new RegExp(`assets/${escaped}(?:\\?v=[a-f0-9]+)?`, 'g'), `assets/${asset}?v=${digest}`);
}
if (process.argv.includes('--check')) {
  if (updated !== original) {
    console.error('Website release information or asset revisions are stale. Run npm run site:sync.');
    process.exitCode = 1;
  } else console.log(`Website release v${version} and asset revisions are current.`);
} else {
  if (updated !== original) await writeFile(indexPath, updated);
  console.log(`Synced ${fileURLToPath(indexPath)} to v${version}.`);
}
