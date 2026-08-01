import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { releaseSha256ManifestName, verifyReleaseSha256Manifest } from './release-sha256-manifest.mjs';

export async function archiveWindowsRelease({ releaseDir, archiveRoot, version, retainCount = 3 }) {
  assertVersion(version);
  if (!Number.isSafeInteger(retainCount) || retainCount < 1 || retainCount > 10) {
    throw new Error(`Invalid Windows release archive retention: ${String(retainCount)}`);
  }

  const verification = await verifyReleaseSha256Manifest({ releaseDir, version });
  if (verification.assetCount !== 10) throw new Error('Expected 10 public assets in SHA256SUMS.txt');
  const assetNames = await readManifestAssetNames(join(releaseDir, releaseSha256ManifestName));
  await mkdir(archiveRoot, { recursive: true });
  await assertNoFutureVersionDirectories(archiveRoot, version);
  const stagingDirectory = await mkdtemp(join(archiveRoot, `.${version}-staging-`));
  let stagingMoved = false;

  try {
    for (const name of [...assetNames, releaseSha256ManifestName]) {
      await copyFile(join(releaseDir, name), join(stagingDirectory, name));
    }
    await verifyReleaseSha256Manifest({ releaseDir: stagingDirectory, version });

    const targetDirectory = join(archiveRoot, version);
    const backupDirectory = join(archiveRoot, `.${version}-backup-${randomUUID()}`);
    let previousArchived = false;
    try {
      await rename(targetDirectory, backupDirectory);
      previousArchived = true;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }

    try {
      await rename(stagingDirectory, targetDirectory);
      stagingMoved = true;
    } catch (error) {
      if (previousArchived) await rename(backupDirectory, targetDirectory);
      throw error;
    }
    if (previousArchived) await rm(backupDirectory, { recursive: true, force: true });

    const removedVersions = await pruneArchivedVersions(archiveRoot, version, retainCount);
    return { archiveDirectory: targetDirectory, assetCount: assetNames.length + 1, removedVersions };
  } finally {
    if (!stagingMoved) await rm(stagingDirectory, { recursive: true, force: true });
  }
}

async function readManifestAssetNames(manifestPath) {
  const source = await readFile(manifestPath, 'utf8');
  return source
    .trimEnd()
    .split('\n')
    .map((line, index) => {
      const match = line.match(/^[a-f0-9]{64} {2}([^/\\]+)$/);
      if (!match) throw new Error(`Invalid SHA256 manifest line ${index + 1}`);
      return match[1];
    });
}

async function readArchivedVersions(archiveRoot) {
  const entries = await readdir(archiveRoot, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && /^\d+\.\d+\.\d+$/.test(entry.name))
    .map((entry) => entry.name);
}

async function assertNoFutureVersionDirectories(archiveRoot, currentVersion) {
  const futureVersions = (await readArchivedVersions(archiveRoot))
    .filter((version) => compareVersions(version, currentVersion) > 0)
    .sort(compareVersionsDescending);
  if (futureVersions.length > 0) {
    throw new Error(
      `Windows release archive contains version(s) newer than ${currentVersion}: ${futureVersions.join(', ')}`
    );
  }
}

async function pruneArchivedVersions(archiveRoot, currentVersion, retainCount) {
  const versions = await readArchivedVersions(archiveRoot);
  const futureVersions = versions.filter((version) => compareVersions(version, currentVersion) > 0);
  if (futureVersions.length > 0) {
    throw new Error(
      `Windows release archive contains version(s) newer than ${currentVersion}: ${futureVersions
        .sort(compareVersionsDescending)
        .join(', ')}`
    );
  }
  const anchoredVersions = versions
    .filter((version) => compareVersions(version, currentVersion) <= 0)
    .sort(compareVersionsDescending);
  if (!anchoredVersions.includes(currentVersion)) {
    throw new Error(`Windows release archive is missing the current version after promotion: ${currentVersion}`);
  }
  const removedVersions = anchoredVersions.slice(retainCount);
  const resolvedRoot = resolve(archiveRoot);
  for (const version of removedVersions) {
    const target = resolve(archiveRoot, version);
    if (!target.startsWith(`${resolvedRoot}${sep}`)) throw new Error(`Unsafe archive removal target: ${target}`);
    await rm(target, { recursive: true, force: true });
  }
  return removedVersions;
}

function compareVersionsDescending(left, right) {
  return compareVersions(right, left);
}

function compareVersions(left, right) {
  const leftParts = left.split('.').map(Number);
  const rightParts = right.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] - rightParts[index];
  }
  return 0;
}

function assertVersion(version) {
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`Invalid Windows release archive version: ${String(version)}`);
  }
}

async function run() {
  const root = process.cwd();
  const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const result = await archiveWindowsRelease({
    releaseDir: join(root, 'release'),
    archiveRoot: join(root, 'release-archive'),
    version: packageJson.version
  });
  console.log(
    `archived Windows release ${packageJson.version}: ${result.assetCount} assets${
      result.removedVersions.length > 0 ? `; removed ${result.removedVersions.join(', ')}` : ''
    }`
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await run();
