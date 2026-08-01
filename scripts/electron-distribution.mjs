import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import electronDistribution from './electron-win-x64.json' with { type: 'json' };

export { electronDistribution };

export function assertElectronDistributionManifest(version) {
  if (!/^\d+\.\d+\.\d+(-.+)?$/.test(version)) {
    throw new Error(`Expected an exact Electron version, got ${version}`);
  }
  if (
    electronDistribution.version !== version ||
    electronDistribution.platform !== 'win32' ||
    electronDistribution.arch !== 'x64' ||
    electronDistribution.assetName !== `electron-v${version}-win32-x64.zip` ||
    !/^[a-f0-9]{64}$/.test(electronDistribution.sha256) ||
    !Number.isSafeInteger(electronDistribution.size) ||
    electronDistribution.size < 50 * 1024 * 1024
  ) {
    throw new Error(`Electron distribution manifest does not match ${version} win32 x64`);
  }
}

export function getElectronCacheRoot({
  environment = process.env,
  platform = process.platform,
  userHome = homedir()
} = {}) {
  if (environment.ELECTRON_CACHE) {
    return resolve(environment.ELECTRON_CACHE);
  }

  if (platform === 'win32') {
    return join(environment.LOCALAPPDATA ?? join(userHome, 'AppData', 'Local'), 'electron', 'Cache');
  }

  if (platform === 'darwin') {
    return join(userHome, 'Library', 'Caches', 'electron');
  }

  return join(environment.XDG_CACHE_HOME ?? join(userHome, '.cache'), 'electron');
}

export function getElectronArchivePath(options) {
  return join(getElectronCacheRoot(options), electronDistribution.assetName);
}

export async function validateElectronArchive(path) {
  const stats = await stat(path);
  if (stats.size !== electronDistribution.size) {
    throw new Error(`Electron archive size mismatch: expected ${electronDistribution.size}, got ${stats.size}`);
  }

  const sha256 = await hashFileSha256(path);
  if (sha256 !== electronDistribution.sha256) {
    throw new Error(`Electron archive SHA256 mismatch: expected ${electronDistribution.sha256}, got ${sha256}`);
  }
}

async function hashFileSha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
