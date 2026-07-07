import { access, readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

const root = process.cwd();
const releaseDir = join(root, 'release');
const internalBuild = process.argv.includes('--internal');
const noPetBuild = process.argv.includes('--no-pet');
const publicUpdateBuild = process.argv.includes('--public-update');
const bundledSubscriptionBuild = (internalBuild || noPetBuild) && !publicUpdateBuild;

const packageJson = (await import('../package.json', { with: { type: 'json' } })).default as {
  version?: string;
};

if (!packageJson.version) {
  throw new Error('Missing package version');
}

const expectedInstallerName = `YouYu-${packageJson.version}-x64${internalBuild ? '-in' : noPetBuild ? '-no' : ''}.exe`;
const expectedInstallerPath = join(releaseDir, expectedInstallerName);
const expectedBlockmapPath = join(releaseDir, `${expectedInstallerName}.blockmap`);
const expectedUpdateMetadataName = internalBuild ? 'latest-in.yml' : noPetBuild ? 'latest-no.yml' : 'latest.yml';
const expectedUpdateMetadataPath = join(releaseDir, expectedUpdateMetadataName);
const bundledSubscriptionPath = join(releaseDir, 'win-unpacked', 'resources', 'default-subscription.txt');
const trafficApiUrlPath = join(releaseDir, 'win-unpacked', 'resources', 'traffic-api-url.txt');

await access(expectedInstallerPath);
await access(expectedBlockmapPath);
await access(expectedUpdateMetadataPath);

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
if (!bundledSubscriptionBuild && bundledSubscription) {
  throw new Error('Public installer must not bundle a default subscription');
}
if (bundledSubscriptionBuild && !bundledSubscription) {
  throw new Error(`${internalBuild ? 'Internal' : 'No-pet'} installer is missing the bundled default subscription`);
}
if (publicUpdateBuild && bundledSubscription) {
  throw new Error('Public update installer must not bundle a default subscription');
}

const trafficApiUrl = (await readFile(trafficApiUrlPath, 'utf8')).trim();
if (!/^https:\/\/\S+$/i.test(trafficApiUrl)) {
  throw new Error('Windows installer is missing a valid traffic API URL');
}

if (noPetBuild) {
  const rendererAssets = await readdir(join(root, 'out', 'renderer', 'assets'));
  const petAssets = rendererAssets.filter((entry) => /spritesheet/i.test(entry));
  if (petAssets.length > 0) {
    throw new Error(`No-pet build must not include pet spritesheets: ${petAssets.join(', ')}`);
  }
}

console.log(`validated Windows x64 installer: ${expectedInstallerName}`);
