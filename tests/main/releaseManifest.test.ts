import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createReleaseSha256Manifest, verifyReleaseSha256Manifest } from '../../scripts/release-sha256-manifest.mjs';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('public release SHA256 manifest', () => {
  it('covers every public channel asset in stable name order and detects tampering', async () => {
    const releaseDir = await mkdtemp(join(tmpdir(), 'youyu-release-manifest-'));
    temporaryDirectories.push(releaseDir);
    const version = '1.2.3';
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
      `YouYu-${version}-Mihomo-v1.0.0-source.tar.gz`
    ];

    for (const name of names) await writeFile(join(releaseDir, name), `content:${name}`, 'utf8');
    await writeFile(join(releaseDir, 'unrelated.txt'), 'ignored', 'utf8');

    const result = await createReleaseSha256Manifest({ releaseDir, version });
    const source = await readFile(result.manifestPath, 'utf8');
    const listedNames = source
      .trim()
      .split('\n')
      .map((line) => line.slice(66));

    expect(listedNames).toEqual([...names].sort());
    expect(source).not.toContain('unrelated.txt');
    await expect(verifyReleaseSha256Manifest({ releaseDir, version })).resolves.toEqual({
      manifestPath: result.manifestPath,
      assetCount: names.length
    });

    await writeFile(join(releaseDir, names[0]), 'tampered', 'utf8');
    await expect(verifyReleaseSha256Manifest({ releaseDir, version })).rejects.toThrow(/SHA256 mismatch/);
  });

  it('uses lowercase SHA256 hex values rather than update metadata SHA512 values', async () => {
    const releaseDir = await mkdtemp(join(tmpdir(), 'youyu-release-manifest-'));
    temporaryDirectories.push(releaseDir);
    const version = '4.5.6';
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
      `YouYu-${version}-Mihomo-v2.0.0-source.tar.gz`
    ];
    for (const name of names) await writeFile(join(releaseDir, name), name, 'utf8');

    const { manifestPath } = await createReleaseSha256Manifest({ releaseDir, version });
    const firstLine = (await readFile(manifestPath, 'utf8')).split('\n')[0];
    const firstName = [...names].sort()[0];
    const expected = createHash('sha256').update(firstName).digest('hex');
    expect(firstLine).toBe(`${expected}  ${firstName}`);
  });
});
