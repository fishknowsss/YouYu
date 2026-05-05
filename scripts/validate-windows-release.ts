import { access, readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

const root = process.cwd();
const releaseDir = join(root, 'release');
const internalBuild = process.argv.includes('--internal');
const noPetBuild = process.argv.includes('--no-pet');

const packageJson = (await import('../package.json', { with: { type: 'json' } })).default as {
  version?: string;
};

if (!packageJson.version) {
  throw new Error('Missing package version');
}

const expectedInstallerName = `YouYu-${packageJson.version}-x64${internalBuild ? '-in' : noPetBuild ? '-no' : ''}.exe`;
const expectedInstallerPath = join(releaseDir, expectedInstallerName);
const bundledSubscriptionPath = join(releaseDir, 'win-unpacked', 'resources', 'default-subscription.txt');

await access(expectedInstallerPath);

const entries = await readdir(releaseDir, { withFileTypes: true });
const exeEntries = entries
  .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.exe'))
  .map((entry) => entry.name);

if (exeEntries.length !== 1 || exeEntries[0] !== expectedInstallerName) {
  throw new Error(
    `Expected exactly one installer exe (${expectedInstallerName}), found: ${exeEntries.join(', ') || '<none>'}`
  );
}

if (!internalBuild && exeEntries.some((entry) => /-in\.exe$/i.test(entry))) {
  throw new Error(`Public release must not contain internal installer: ${exeEntries.join(', ')}`);
}
if (!noPetBuild && exeEntries.some((entry) => /-no\.exe$/i.test(entry))) {
  throw new Error(`Standard release must not contain no-pet installer: ${exeEntries.join(', ')}`);
}

const confusingEntries = entries
  .filter((entry) => /arm64|ia32/i.test(entry.name))
  .map((entry) => entry.name);

if (confusingEntries.length > 0) {
  throw new Error(`Unexpected non-x64 Windows release entries: ${confusingEntries.join(', ')}`);
}

const currentInstaller = await stat(expectedInstallerPath);
if (currentInstaller.size < 80 * 1024 * 1024) {
  throw new Error(`Installer is unexpectedly small: ${expectedInstallerName}`);
}

const bundledSubscription = (await readFile(bundledSubscriptionPath, 'utf8')).trim();
if (!internalBuild && bundledSubscription) {
  throw new Error('Public installer must not bundle a default subscription');
}
if (internalBuild && !bundledSubscription) {
  throw new Error('Internal installer is missing the bundled default subscription');
}

if (noPetBuild) {
  const rendererAssets = await readdir(join(root, 'out', 'renderer', 'assets'));
  const petAssets = rendererAssets.filter((entry) => /spritesheet/i.test(entry));
  if (petAssets.length > 0) {
    throw new Error(`No-pet build must not include pet spritesheets: ${petAssets.join(', ')}`);
  }
}

console.log(`validated Windows x64 installer: ${expectedInstallerName}`);
