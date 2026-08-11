import { access, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  assertPackagedMihomoMatchesSource,
  mihomoResourceRelativePath,
  resolveMihomoSourceReleaseAssetName,
  validateMihomoDistribution,
  validateMihomoSourceArchive
} from './mihomo-distribution.mjs';

const requiredPaths = [
  'package.json',
  'electron-builder.yml',
  'src/main/index.ts',
  'src/preload/index.ts',
  'src/renderer/App.tsx',
  'youyu.png',
  'src/renderer/assets/youyu-icon.png',
  'build/source-icon.png',
  'build/icon.ico',
  'build/tray-icon.png',
  'build/installerSidebar.bmp',
  'build/installer.nsh',
  'build/update-elevated-installer.ps1',
  'resources/generated/default-subscription.txt',
  'resources/generated/windows-fullscreen-probe.exe',
  'resources/mihomo/win-x64/mihomo.exe'
];

const root = process.cwd();

for (const path of requiredPaths) {
  await assertExists(path);
}

const sourceMihomo = await validateMihomoDistribution(join(root, mihomoResourceRelativePath));

const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as {
  main?: string;
  version?: string;
};

if (packageJson.main !== 'out/main/index.js') {
  throw new Error(`Unexpected Electron main entry: ${packageJson.main ?? '<missing>'}`);
}

for (const path of ['out/main/index.js', 'out/preload/index.cjs', 'out/renderer/index.html']) {
  await assertExists(path);
}

const unpackedDir = join(root, 'release/win-unpacked');
if (await exists(unpackedDir)) {
  for (const path of [
    'release/win-unpacked/YouYu.exe',
    'release/win-unpacked/resources/app.asar',
    'release/win-unpacked/resources/default-subscription.txt',
    'release/win-unpacked/resources/windows-fullscreen-probe.exe',
    'release/win-unpacked/resources/update-elevated-installer.ps1',
    'release/win-unpacked/resources/assets/icon.png',
    'release/win-unpacked/resources/assets/tray-icon.png',
    'release/win-unpacked/resources/mihomo/win-x64/mihomo.exe'
  ]) {
    await assertExists(path);
  }

  const packagedMihomo = await validateMihomoDistribution(join(unpackedDir, 'resources', 'mihomo', 'win-x64'));
  assertPackagedMihomoMatchesSource(sourceMihomo.manifest, packagedMihomo.manifest);
}

const publicChannelMetadata = ['latest.yml', 'latest-in.yml', 'latest-no.yml'].map((name) =>
  join(root, 'release', name)
);
if ((await Promise.all(publicChannelMetadata.map(exists))).every(Boolean)) {
  if (!packageJson.version) throw new Error('Missing package version for Mihomo source archive');
  const sourceAssetName = resolveMihomoSourceReleaseAssetName(sourceMihomo.manifest, packageJson.version);
  await validateMihomoSourceArchive(join(root, 'release', sourceAssetName), sourceMihomo.manifest);
}

const installerPath = `release/YouYu-${packageJson.version}-x64.exe`;
if (await exists(join(root, installerPath))) {
  const installer = await stat(join(root, installerPath));
  if (installer.size < 80 * 1024 * 1024) {
    throw new Error(`Installer is unexpectedly small: ${installerPath}`);
  }
  await assertExists(`${installerPath}.blockmap`);
}

console.log('smoke ok');

async function assertExists(path: string): Promise<void> {
  await access(join(root, path));
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
