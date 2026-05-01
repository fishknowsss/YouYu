import { copyFile, mkdir, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { downloadArtifact } from '@electron/get';
import packageJson from '../package.json' with { type: 'json' };

const version = packageJson.devDependencies.electron;

if (!/^\d+\.\d+\.\d+(-.+)?$/.test(version)) {
  throw new Error(`Expected an exact Electron version, got ${version}`);
}

const zipPath = await downloadArtifact({
  version,
  artifactName: 'electron',
  platform: 'win32',
  arch: 'x64'
});

const stats = await stat(zipPath);
if (stats.size < 50 * 1024 * 1024) {
  throw new Error(`Electron cache file is unexpectedly small: ${zipPath}`);
}

const builderCachePath = join(getElectronCacheRoot(), `electron-v${version}-win32-x64.zip`);
if (resolve(zipPath) !== resolve(builderCachePath)) {
  await mkdir(dirname(builderCachePath), { recursive: true });
  await copyFile(zipPath, builderCachePath);
}

const builderCacheStats = await stat(builderCachePath);
if (builderCacheStats.size !== stats.size) {
  throw new Error(`Electron builder cache copy has the wrong size: ${builderCachePath}`);
}

console.log(`electron win32 x64 cached: ${zipPath}`);
console.log(`electron-builder cache ready: ${builderCachePath}`);

function getElectronCacheRoot() {
  if (process.env.ELECTRON_CACHE) {
    return process.env.ELECTRON_CACHE;
  }

  if (process.platform === 'win32') {
    return join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'electron', 'Cache');
  }

  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Caches', 'electron');
  }

  return join(process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'electron');
}
