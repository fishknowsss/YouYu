import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { downloadArtifact } from '@electron/get';
import packageJson from '../package.json' with { type: 'json' };
import {
  assertElectronDistributionManifest,
  getElectronArchivePath,
  validateElectronArchive
} from './electron-distribution.mjs';

const version = packageJson.devDependencies.electron;

assertElectronDistributionManifest(version);

const builderCachePath = getElectronArchivePath();
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
