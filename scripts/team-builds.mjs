import { copyFile, lstat, mkdtemp, readdir, rename, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export const teamBuildsDirectoryName = 'team-builds';

export function getTeamInstallerNames(version) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`Invalid package version: ${version}`);
  }

  return [`YouYu-${version}-x64-in.exe`, `YouYu-${version}-x64-no.exe`];
}

export async function refreshTeamBuilds({ root, sourceDir, version }) {
  const rootDir = resolve(root);
  const targetDir = join(rootDir, teamBuildsDirectoryName);
  const previousDir = join(rootDir, '.team-builds-previous');
  const installerNames = getTeamInstallerNames(version);

  await recoverInterruptedSwap(targetDir, previousDir);

  const stagingDir = await mkdtemp(join(rootDir, '.team-builds-staging-'));
  let previousMoved = false;
  let stagingMoved = false;

  try {
    for (const name of installerNames) {
      const sourcePath = join(sourceDir, name);
      const sourceStat = await lstat(sourcePath);
      if (!sourceStat.isFile() || sourceStat.size === 0) {
        throw new Error(`Invalid private team installer: ${sourcePath}`);
      }
      await copyFile(sourcePath, join(stagingDir, name));
    }

    const stagedEntries = (await readdir(stagingDir)).sort();
    if (stagedEntries.join('\n') !== [...installerNames].sort().join('\n')) {
      throw new Error('Team build staging directory contains unexpected files');
    }

    await rm(previousDir, { recursive: true, force: true });
    try {
      await rename(targetDir, previousDir);
      previousMoved = true;
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
    }

    try {
      await rename(stagingDir, targetDir);
      stagingMoved = true;
    } catch (error) {
      if (previousMoved) await rename(previousDir, targetDir);
      throw error;
    }

    await rm(previousDir, { recursive: true, force: true });
    return installerNames.map((name) => join(targetDir, name));
  } finally {
    if (!stagingMoved) await rm(stagingDir, { recursive: true, force: true });
  }
}

async function recoverInterruptedSwap(targetDir, previousDir) {
  const targetExists = await pathExists(targetDir);
  const previousExists = await pathExists(previousDir);

  if (!targetExists && previousExists) {
    await rename(previousDir, targetDir);
    return;
  }

  if (previousExists) await rm(previousDir, { recursive: true, force: true });
}

async function pathExists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isMissingPathError(error)) return false;
    throw error;
  }
}

function isMissingPathError(error) {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
