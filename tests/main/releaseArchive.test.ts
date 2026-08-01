import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { archiveWindowsRelease } from '../../scripts/archive-windows-release.mjs';
import { createReleaseSha256Manifest } from '../../scripts/release-sha256-manifest.mjs';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('Windows release archive', () => {
  it('preserves all 11 public assets under original names and prunes only old version directories', async () => {
    const root = await makeTemporaryDirectory();
    const releaseDir = join(root, 'release');
    const archiveRoot = join(root, 'release-archive');
    await createFixtureRelease(releaseDir, '1.6.9');
    for (const version of ['1.6.6', '1.6.7', '1.6.8']) {
      await mkdir(join(archiveRoot, version), { recursive: true });
      await writeFile(join(archiveRoot, version, 'marker.txt'), version, 'utf8');
    }
    await writeFile(join(archiveRoot, 'legacy-flat-file.txt'), 'preserved', 'utf8');

    const result = await archiveWindowsRelease({ releaseDir, archiveRoot, version: '1.6.9' });
    const archivedNames = (await readdir(result.archiveDirectory)).sort();

    expect(result.assetCount).toBe(11);
    expect(result.removedVersions).toEqual(['1.6.6']);
    expect(archivedNames).toHaveLength(11);
    expect(archivedNames).toContain('SHA256SUMS.txt');
    expect(archivedNames).toContain('latest.yml');
    expect(archivedNames).toContain('latest-in.yml');
    expect(archivedNames).toContain('latest-no.yml');
    await expect(readFile(join(archiveRoot, 'legacy-flat-file.txt'), 'utf8')).resolves.toBe('preserved');
    await expect(readdir(join(archiveRoot, '1.6.6'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('fails closed without changing the archive when a future version directory is present', async () => {
    const root = await makeTemporaryDirectory();
    const releaseDir = join(root, 'release');
    const archiveRoot = join(root, 'release-archive');
    await createFixtureRelease(releaseDir, '1.6.9');
    for (const version of ['1.6.8', '1.6.10']) {
      await mkdir(join(archiveRoot, version), { recursive: true });
      await writeFile(join(archiveRoot, version, 'marker.txt'), version, 'utf8');
    }

    await expect(archiveWindowsRelease({ releaseDir, archiveRoot, version: '1.6.9' })).rejects.toThrow(
      'Windows release archive contains version(s) newer than 1.6.9: 1.6.10'
    );

    await expect(readFile(join(archiveRoot, '1.6.8', 'marker.txt'), 'utf8')).resolves.toBe('1.6.8');
    await expect(readFile(join(archiveRoot, '1.6.10', 'marker.txt'), 'utf8')).resolves.toBe('1.6.10');
    await expect(readdir(join(archiveRoot, '1.6.9'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

async function makeTemporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), 'youyu-release-archive-test-'));
  temporaryDirectories.push(directory);
  return directory;
}

async function createFixtureRelease(releaseDir: string, version: string) {
  await mkdir(releaseDir, { recursive: true });
  const names = [
    `YouYu-${version}-x64.exe`,
    `YouYu-${version}-x64.exe.blockmap`,
    `YouYu-${version}-x64-in.exe`,
    `YouYu-${version}-x64-in.exe.blockmap`,
    `YouYu-${version}-x64-no.exe`,
    `YouYu-${version}-x64-no.exe.blockmap`,
    'latest.yml',
    'latest-in.yml',
    'latest-no.yml',
    `YouYu-${version}-Mihomo-v1.19.28-source.tar.gz`
  ];
  await Promise.all(names.map((name) => writeFile(join(releaseDir, name), `fixture:${name}\n`, 'utf8')));
  await createReleaseSha256Manifest({ releaseDir, version });
}
