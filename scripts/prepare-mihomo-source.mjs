import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  mihomoResourceRelativePath,
  resolveMihomoSourceReleaseAssetName,
  validateMihomoDistribution,
  validateMihomoSourceArchive
} from './mihomo-distribution.mjs';

const root = process.cwd();
const releaseDir = join(root, 'release');
const appVersion = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version;
const { manifest } = await validateMihomoDistribution(join(root, mihomoResourceRelativePath));
const assetName = resolveMihomoSourceReleaseAssetName(manifest, appVersion);
const targetPath = join(releaseDir, assetName);
const sourceCachePath = join(getReleaseCacheRoot(), 'mihomo', `source-${manifest.sourceArchive.sha256}.tar.gz`);

await mkdir(releaseDir, { recursive: true });

if (await exists(targetPath)) {
  await validateMihomoSourceArchive(targetPath, manifest);
  console.log(`Mihomo source archive already valid: ${targetPath}`);
  process.exit(0);
}

const temporaryPath = join(releaseDir, `.${assetName}.${process.pid}.${randomUUID()}.tmp`);
try {
  if (await exists(sourceCachePath)) {
    await validateMihomoSourceArchive(sourceCachePath, manifest);
    await copyFile(sourceCachePath, temporaryPath, fsConstants.COPYFILE_EXCL);
    await validateMihomoSourceArchive(temporaryPath, manifest);
    await rename(temporaryPath, targetPath);
    console.log(`prepared Mihomo source archive from verified cache: ${targetPath}`);
  } else {
    const bytes = await downloadPinnedSource(manifest.sourceArchive.upstreamUrl, manifest.sourceArchive.size);
    await writeFile(temporaryPath, bytes, { flag: 'wx' });
    await validateMihomoSourceArchive(temporaryPath, manifest);
    await persistVerifiedSourceCache(temporaryPath, sourceCachePath, manifest);
    await rename(temporaryPath, targetPath);
    console.log(`prepared Mihomo source archive: ${targetPath}`);
  }
} finally {
  await rm(temporaryPath, { force: true });
}

async function downloadPinnedSource(url, expectedSize) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        redirect: 'follow',
        headers: { 'User-Agent': 'YouYu-release-packaging' },
        signal: AbortSignal.timeout(120_000)
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const declaredSize = Number(response.headers.get('content-length'));
      if (Number.isFinite(declaredSize) && declaredSize > 0 && declaredSize !== expectedSize) {
        throw new Error(`unexpected Content-Length ${declaredSize}; expected ${expectedSize}`);
      }

      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length !== expectedSize) {
        throw new Error(`downloaded ${bytes.length} bytes; expected ${expectedSize}`);
      }
      return bytes;
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise((resolveDelay) => setTimeout(resolveDelay, attempt * 1000));
    }
  }
  throw new Error(`Unable to download pinned Mihomo source archive from ${url}`, { cause: lastError });
}

async function exists(path) {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function persistVerifiedSourceCache(sourcePath, cachePath, sourceManifest) {
  await mkdir(dirname(cachePath), { recursive: true });
  try {
    await copyFile(sourcePath, cachePath, fsConstants.COPYFILE_EXCL);
  } catch (error) {
    if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'EEXIST') throw error;
  }
  await validateMihomoSourceArchive(cachePath, sourceManifest);
}

function getReleaseCacheRoot() {
  if (process.env.YOUYU_RELEASE_CACHE) return process.env.YOUYU_RELEASE_CACHE;
  if (process.platform === 'win32') {
    return join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'YouYu', 'ReleaseCache');
  }
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Caches', 'YouYu', 'release');
  return join(process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'youyu', 'release');
}
