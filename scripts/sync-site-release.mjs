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
for (const asset of ['site.css', 'site.js', 'showcase.js']) {
  const content = (await readFile(new URL(`docs/assets/${asset}`, root), 'utf8')).replace(/\r\n/g, '\n');
  const digest = createHash('sha256').update(content).digest('hex').slice(0, 10);
  const escaped = asset.replace('.', '\\.');
  updated = updated.replace(new RegExp(`assets/${escaped}(?:\\?v=[a-f0-9]+)?`, 'g'), `assets/${asset}?v=${digest}`);
}
const entries = JSON.parse(await readFile(new URL('docs/demo/entries.json', root), 'utf8'));
const petEntry = entries['pet.tsx'].file;
const petAtlas = entries['../src/renderer/assets/pet/youyu/main-spritesheet.webp'].file;
const demoVersion = JSON.parse(await readFile(new URL('docs/demo/version.json', root), 'utf8')).version;
if (demoVersion !== version) throw new Error('Website demo version is stale. Run npm run site:build.');
const demoHtml = (await readFile(new URL('docs/demo/index.html', root), 'utf8')).replace(/\r\n/g, '\n');
const demoDigest = createHash('sha256').update(demoHtml).digest('hex').slice(0, 10);
updated = updated
  .replace(/data-sprite-src="[^"]+"/, `data-sprite-src="demo/${petAtlas}"`)
  .replace(/data-pet-src="[^"]+"/, `data-pet-src="demo/${petEntry}"`)
  .replace(/data-demo-src="[^"]+"/, `data-demo-src="demo/index.html?v=${demoDigest}"`);
if (process.argv.includes('--check')) {
  if (updated !== original) {
    console.error('Website release information or asset revisions are stale. Run npm run site:sync.');
    process.exitCode = 1;
  } else console.log(`Website release v${version} and asset revisions are current.`);
} else {
  if (updated !== original) await writeFile(indexPath, updated);
  console.log(`Synced ${fileURLToPath(indexPath)} to v${version}.`);
}
