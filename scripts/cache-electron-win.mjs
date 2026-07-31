import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { downloadArtifact } from '@electron/get';
import packageJson from '../package.json' with { type: 'json' };
import electronDistribution from './electron-win-x64.json' with { type: 'json' };

const version = packageJson.devDependencies.electron;

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

const builderCachePath = join(getElectronCacheRoot(), `electron-v${version}-win32-x64.zip`);
let zipPath = builderCachePath;

if (await isVerifiedElectronArchive(builderCachePath)) {
  console.log(`using verified Electron cache: ${builderCachePath}`);
} else {
  zipPath = await retryDownload(() =>
    downloadArtifact({
      version,
      artifactName: 'electron',
      platform: 'win32',
      arch: 'x64'
    })
  );
  await validateElectronArchive(zipPath);

  if (resolve(zipPath) !== resolve(builderCachePath)) {
    await mkdir(dirname(builderCachePath), { recursive: true });
    await copyFile(zipPath, builderCachePath);
  }
}

await validateElectronArchive(builderCachePath);

console.log(`electron win32 x64 cached: ${zipPath}`);
console.log(`electron-builder cache ready: ${builderCachePath}`);

async function isVerifiedElectronArchive(path) {
  try {
    await validateElectronArchive(path);
    return true;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return false;
    console.warn(`Ignoring unverified Electron cache ${path}: ${formatError(error)}`);
    return false;
  }
}

async function validateElectronArchive(path) {
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

async function retryDownload(download, attempts = 4) {
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await download();
    } catch (error) {
      lastError = error;
      if (attempt === attempts) break;

      const delayMs = 1000 * 2 ** (attempt - 1);
      console.warn(
        `Electron download attempt ${attempt}/${attempts} failed; retrying in ${delayMs}ms: ${formatError(error)}`
      );
      await new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs));
    }
  }

  throw lastError;
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}

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
