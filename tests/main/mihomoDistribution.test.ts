import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertPackagedMihomoMatchesSource,
  hashFileSha256,
  mihomoResourceRelativePath,
  readMihomoManifest,
  resolveMihomoSourceReleaseAssetName,
  validateMihomoDistribution,
  type MihomoDistributionManifest
} from '../../scripts/mihomo-distribution.mjs';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('bundled Mihomo distribution', () => {
  it('pins the audited official v1.19.28 Windows amd64 with_gvisor asset', async () => {
    const result = await validateMihomoDistribution(join(process.cwd(), mihomoResourceRelativePath));

    expect(result.manifest).toMatchObject({
      project: 'MetaCubeX/mihomo',
      repositoryUrl: 'https://github.com/MetaCubeX/mihomo',
      version: '1.19.28',
      tag: 'v1.19.28',
      tagCommit: 'cbd11db1e13a75d8e680e0fe7742c95be4cba2be',
      platform: 'windows',
      architecture: 'amd64',
      buildTags: ['with_gvisor'],
      binary: {
        size: 47_898_112,
        sha256: '84f8bcd390ee146cba87746fe5447eb1bfa534c8f03c52dd965ef207ae4f0eeb'
      },
      upstreamAsset: {
        name: 'mihomo-windows-amd64-v1.19.28.zip',
        url: 'https://github.com/MetaCubeX/mihomo/releases/download/v1.19.28/mihomo-windows-amd64-v1.19.28.zip',
        size: 17_712_471,
        sha256: '27bdbd8f476dfb0f65a2a8ecf43cdf7edc0a132326efc7660308a1302c034a20'
      },
      sourceArchive: {
        upstreamUrl: 'https://codeload.github.com/MetaCubeX/mihomo/tar.gz/cbd11db1e13a75d8e680e0fe7742c95be4cba2be',
        size: 1_036_754,
        sha256: 'c5a42706220537f6067e74518a9befbbc451c12f5cae26c42f0f4debf92cef0a',
        releaseAssetNameTemplate: 'YouYu-${appVersion}-Mihomo-v1.19.28-source.tar.gz'
      },
      license: { spdx: 'GPL-3.0-only' }
    });
    expect(result.versionOutput).toContain('Mihomo Meta v1.19.28 windows amd64 with go1.26.5');
    expect(result.versionOutput).toContain('with_gvisor');
  });

  it('requires the manifest', async () => {
    const fixture = await createFixture();
    await rm(join(fixture.directory, 'manifest.json'));

    await expect(validateFixture(fixture)).rejects.toThrow('Mihomo manifest missing or unreadable');
  });

  it('rejects a binary whose SHA256 no longer matches the manifest', async () => {
    const fixture = await createFixture();
    const binaryPath = join(fixture.directory, fixture.manifest.binary.file);
    const tampered = await readFile(binaryPath);
    tampered[0] ^= 0xff;
    await writeFile(binaryPath, tampered);

    await expect(validateFixture(fixture)).rejects.toThrow('Mihomo binary SHA256 mismatch');
  });

  it('requires the complete GPL license', async () => {
    const fixture = await createFixture();
    await rm(join(fixture.directory, fixture.manifest.license.file));

    await expect(validateFixture(fixture)).rejects.toThrow('Mihomo GPL license missing or unreadable');
  });

  it('rejects a binary version that differs from the manifest', async () => {
    const fixture = await createFixture();

    await expect(
      validateMihomoDistribution(fixture.directory, {
        readVersionOutput: () => 'Mihomo Meta v1.19.27 windows amd64\nUse tags: with_gvisor'
      })
    ).rejects.toThrow('Mihomo version output mismatch');
  });

  it('derives a version-specific corresponding-source release asset name', async () => {
    const manifest = await readMihomoManifest(join(process.cwd(), mihomoResourceRelativePath));

    expect(resolveMihomoSourceReleaseAssetName(manifest, '1.6.8')).toBe('YouYu-1.6.8-Mihomo-v1.19.28-source.tar.gz');
    expect(() => resolveMihomoSourceReleaseAssetName(manifest, '../1.6.8')).toThrow('Invalid YouYu version');
  });

  it('packages the binary, manifest, license and source notice explicitly', async () => {
    const builderConfig = await readFile('electron-builder.yml', 'utf8');
    for (const path of ['mihomo.exe', 'manifest.json', 'LICENSE-GPL-3.0.txt', 'SOURCE.md']) {
      expect(builderConfig).toContain(`- win-x64/${path}`);
    }

    const releaseScript = await readFile('scripts/package-windows-release.mjs', 'utf8');
    expect(releaseScript).toContain("await run('node', ['scripts/prepare-mihomo-source.mjs']);");

    const sourceScript = await readFile('scripts/prepare-mihomo-source.mjs', 'utf8');
    expect(sourceScript).toContain('await validateMihomoSourceArchive(sourceCachePath, manifest)');
    expect(sourceScript).toContain('source-${manifest.sourceArchive.sha256}.tar.gz');

    for (const path of ['scripts/smoke-test.ts', 'scripts/validate-windows-release.ts']) {
      expect(await readFile(path, 'utf8'), path).toContain('validateMihomoDistribution');
    }

    const workflow = await readFile('.github/workflows/build-windows.yml', 'utf8');
    expect(workflow).toContain('npm run validate:mihomo');
    expect(workflow).toContain('Mihomo-*-source.tar.gz');
  });

  it('allows only a verified Authenticode envelope to change the packaged binary hash and size', async () => {
    const source = await readMihomoManifest(join(process.cwd(), mihomoResourceRelativePath));
    expect(assertPackagedMihomoMatchesSource(source, structuredClone(source))).toEqual({ signed: false });

    const packaged = structuredClone(source);
    packaged.binary = {
      ...packaged.binary,
      size: packaged.binary.size + 8192,
      sha256: 'a'.repeat(64),
      unsignedSize: source.binary.size,
      unsignedSha256: source.binary.sha256,
      authenticodeSubject: 'CN=118 Studio',
      authenticodeThumbprint: 'B'.repeat(40)
    };
    expect(assertPackagedMihomoMatchesSource(source, packaged)).toEqual({
      signed: true,
      signerSubject: 'CN=118 Studio',
      signerThumbprint: 'B'.repeat(40)
    });

    packaged.tagCommit = '0'.repeat(40);
    expect(() => assertPackagedMihomoMatchesSource(source, packaged)).toThrow(/differs outside/);
  });
});

async function createFixture(): Promise<{ directory: string; manifest: MihomoDistributionManifest }> {
  const directory = await mkdtemp(join(tmpdir(), 'youyu-mihomo-distribution-test-'));
  temporaryDirectories.push(directory);
  await mkdir(directory, { recursive: true });

  const manifest = structuredClone(
    await readMihomoManifest(join(process.cwd(), mihomoResourceRelativePath))
  ) as MihomoDistributionManifest;
  const binary = Buffer.from('test Mihomo binary');
  const binaryPath = join(directory, manifest.binary.file);
  await writeFile(binaryPath, binary);
  manifest.binary.size = binary.length;
  manifest.binary.sha256 = await hashFileSha256(binaryPath);
  manifest.binary.versionOutput = 'Mihomo Meta v1.19.28 windows amd64 with go1.26.5\nUse tags: with_gvisor';

  const license = [
    'GNU GENERAL PUBLIC LICENSE',
    'Version 3, 29 June 2007',
    'x'.repeat(30_000),
    'END OF TERMS AND CONDITIONS'
  ].join('\n');
  await writeFile(join(directory, manifest.license.file), license);
  await writeFile(join(directory, manifest.license.sourceNoticeFile), JSON.stringify(manifest, null, 2));
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2));

  return { directory, manifest };
}

async function validateFixture(fixture: { directory: string; manifest: MihomoDistributionManifest }) {
  return validateMihomoDistribution(fixture.directory, {
    readVersionOutput: () => fixture.manifest.binary.versionOutput
  });
}
