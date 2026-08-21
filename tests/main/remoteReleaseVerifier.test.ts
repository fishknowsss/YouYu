import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createReleaseSha256Manifest } from '../../scripts/release-sha256-manifest.mjs';
import {
  describeEffectiveProxy,
  getExpectedPublicAssetNames,
  parseCurlMetrics,
  resolveCurlRuntime,
  resolveGitHubApiEndpoint,
  resolveReleaseSourceArchiveName,
  validateChannelMetadata,
  validateReleaseAssetNames,
  verifyRemoteRelease
} from '../../scripts/verify-remote-release.mjs';

async function createReleaseFixture(version = '1.7.4') {
  const directory = await mkdtemp(join(tmpdir(), 'youyu-remote-release-fixture-'));
  const sourceName = `YouYu-${version}-Mihomo-v1.19.28-source.tar.gz`;
  const installers = [`YouYu-${version}-x64.exe`, `YouYu-${version}-x64-in.exe`, `YouYu-${version}-x64-no.exe`];
  for (const name of [...installers, ...installers.map((name) => `${name}.blockmap`), sourceName]) {
    await writeFile(join(directory, name), `fixture:${name}`, 'utf8');
  }
  for (const [metadataName, installerName] of [
    ['latest.yml', installers[0]],
    ['latest-in.yml', installers[1]],
    ['latest-no.yml', installers[2]]
  ] as const) {
    const bytes = await readFile(join(directory, installerName));
    const sha512 = createHash('sha512').update(bytes).digest('base64');
    await writeFile(
      join(directory, metadataName),
      `version: ${version}\npath: ${installerName}\nsha512: ${sha512}\nfiles:\n  - url: ${installerName}\n    sha512: ${sha512}\n    size: ${bytes.length}\n`,
      'utf8'
    );
  }
  await createReleaseSha256Manifest({ releaseDir: directory, version });
  return { directory, sourceName, version };
}

async function createRemoteVerificationHarness({ tamperAsset } = { tamperAsset: false }) {
  const fixture = await createReleaseFixture();
  const root = await mkdtemp(join(tmpdir(), 'youyu-remote-release-root-'));
  const remoteDirectory = await mkdtemp(join(tmpdir(), 'youyu-remote-release-assets-'));
  await cp(fixture.directory, join(root, 'release'), { recursive: true });
  await cp(fixture.directory, remoteDirectory, { recursive: true });
  if (tamperAsset) {
    await writeFile(join(remoteDirectory, `YouYu-${fixture.version}-x64.exe`), 'tampered remote installer', 'utf8');
  }

  const names = (await readdir(remoteDirectory)).sort();
  const assets = await Promise.all(
    names.map(async (name) => ({
      name,
      size: (await stat(join(remoteDirectory, name))).size,
      browser_download_url: `https://github.com/fishknowsss/YouYu/releases/download/v${fixture.version}/${name}`
    }))
  );
  const downloads: string[] = [];
  return {
    fixture,
    root,
    remoteDirectory,
    downloads,
    dependencies: {
      preflightReleaseCdn: async () => ({
        httpCode: 206,
        bytes: 2 * 1024 * 1024,
        bytesPerSecond: 2 * 1024 * 1024,
        route: 'local fixture',
        assetName: `YouYu-${fixture.version}-x64.exe`
      }),
      downloadGitHubApiFile: async (_url: string, destination: string) => {
        await writeFile(
          destination,
          JSON.stringify({ tag_name: `v${fixture.version}`, draft: false, prerelease: false, assets }),
          'utf8'
        );
      },
      downloadLargeFile: async (url: string, destination: string) => {
        const name = basename(new URL(url).pathname);
        downloads.push(name);
        await cp(join(remoteDirectory, name), destination);
      }
    },
    cleanup: async () => {
      await Promise.all(
        [fixture.directory, root, remoteDirectory].map((path) => rm(path, { recursive: true, force: true }))
      );
    }
  };
}

describe('remote release verifier', () => {
  it('describes a proxy route without exposing credentials', () => {
    expect(describeEffectiveProxy({ HTTPS_PROXY: 'http://secret-user:secret-pass@127.0.0.1:17890' })).toEqual({
      label: 'HTTPS_PROXY http://127.0.0.1:17890',
      proxyConfigured: true
    });
  });

  it('derives the Mihomo source archive from the downloaded release instead of the current checkout manifest', () => {
    expect(
      resolveReleaseSourceArchiveName(['YouYu-1.7.4-Mihomo-v1.18.9-source.tar.gz', 'SHA256SUMS.txt'], '1.7.4')
    ).toBe('YouYu-1.7.4-Mihomo-v1.18.9-source.tar.gz');
    expect(() =>
      resolveReleaseSourceArchiveName(
        ['YouYu-1.7.4-Mihomo-v1.18.9-source.tar.gz', 'YouYu-1.7.4-Mihomo-v1.19.28-source.tar.gz'],
        '1.7.4'
      )
    ).toThrow('exactly one');
  });

  it('requires the exact public asset set', () => {
    const expected = getExpectedPublicAssetNames('1.7.4', 'YouYu-1.7.4-Mihomo-v1.19.28-source.tar.gz');
    expect(expected).toHaveLength(11);
    expect(
      validateReleaseAssetNames(
        { draft: false, prerelease: false, assets: expected.map((name) => ({ name })) },
        expected
      )
    ).toHaveLength(11);
    expect(() =>
      validateReleaseAssetNames(
        { draft: false, prerelease: false, assets: expected.slice(1).map((name) => ({ name })) },
        expected
      )
    ).toThrow('Remote release asset list mismatch');
  });

  it('requires complete size and credential-free download metadata for all 11 remote assets', () => {
    const version = '1.7.4';
    const tag = `v${version}`;
    const expected = getExpectedPublicAssetNames(version, `YouYu-${version}-Mihomo-v1.19.28-source.tar.gz`);
    const assets = expected.map((name) => ({
      name,
      size: 128,
      browser_download_url: `https://github.com/fishknowsss/YouYu/releases/download/${tag}/${name}`
    }));

    expect(
      validateReleaseAssetNames({ tag_name: tag, draft: false, prerelease: false, assets }, expected, tag)
    ).toHaveLength(11);
    expect(() =>
      validateReleaseAssetNames(
        { tag_name: tag, draft: false, prerelease: false, assets: [{ ...assets[0], size: 0 }, ...assets.slice(1)] },
        expected,
        tag
      )
    ).toThrow('size');
    expect(() =>
      validateReleaseAssetNames(
        {
          tag_name: tag,
          draft: false,
          prerelease: false,
          assets: [
            {
              ...assets[0],
              browser_download_url: `https://token@github.com/fishknowsss/YouYu/releases/download/${tag}/${assets[0].name}`
            },
            ...assets.slice(1)
          ]
        },
        expected,
        tag
      )
    ).toThrow('download URL');
  });

  it('validates each update channel installer path', () => {
    const installer = Buffer.from('internal installer bytes');
    const digest = createHash('sha512').update(installer).digest('base64');
    const expected = { sha512: digest, size: installer.length };
    validateChannelMetadata(
      'latest-in.yml',
      `version: 1.7.4\npath: YouYu-1.7.4-x64-in.exe\nsha512: ${digest}\nfiles:\n  - url: YouYu-1.7.4-x64-in.exe\n    sha512: ${digest}\n    size: ${installer.length}\n`,
      '1.7.4',
      expected
    );
    expect(() =>
      validateChannelMetadata('latest-no.yml', 'version: 1.7.4\npath: YouYu-1.7.4-x64.exe\n', '1.7.4', expected)
    ).toThrow('does not point to YouYu-1.7.4-x64-no.exe');
    expect(() =>
      validateChannelMetadata(
        'latest-in.yml',
        'version: 1.7.4\npath: YouYu-1.7.4-x64-in.exe\nfiles:\n  - url: YouYu-1.7.4-x64.exe\n',
        '1.7.4',
        expected
      )
    ).toThrow('files do not contain only YouYu-1.7.4-x64-in.exe');
    expect(() =>
      validateChannelMetadata(
        'latest-in.yml',
        `version: 1.7.4\npath: YouYu-1.7.4-x64-in.exe\nsha512: wrong\nfiles:\n  - url: YouYu-1.7.4-x64-in.exe\n    sha512: ${digest}\n    size: ${installer.length}\n`,
        '1.7.4',
        expected
      )
    ).toThrow('top-level SHA512');
  });

  it('uses the platform curl command without sending a Schannel-only option to Linux runners', () => {
    expect(resolveCurlRuntime('win32')).toEqual({ command: 'curl.exe', platformArgs: ['--ssl-no-revoke'] });
    expect(resolveCurlRuntime('linux')).toEqual({ command: 'curl', platformArgs: [] });
  });

  it('parses curl range metrics', () => {
    expect(parseCurlMetrics('http=206 bytes=2097152 speed=3041382')).toEqual({
      httpCode: 206,
      bytes: 2097152,
      bytesPerSecond: 3041382
    });
  });

  it('accepts only credential-free HTTPS GitHub API URLs', () => {
    expect(resolveGitHubApiEndpoint('https://api.github.com/repos/fishknowsss/YouYu/releases/latest')).toBe(
      'repos/fishknowsss/YouYu/releases/latest'
    );
    expect(() => resolveGitHubApiEndpoint('https://token@api.github.com/repos/example')).toThrow('invalid');
    expect(() => resolveGitHubApiEndpoint('https://github.com/repos/example')).toThrow('invalid');
  });

  it('executes the complete 11-asset, manifest, and three-channel verification state machine with local downloads', async () => {
    const harness = await createRemoteVerificationHarness();
    try {
      await expect(
        verifyRemoteRelease({
          version: harness.fixture.version,
          root: harness.root,
          dependencies: harness.dependencies
        })
      ).resolves.toEqual({ version: harness.fixture.version, assetCount: 11, manifestAssetCount: 10 });
      expect(harness.downloads).toHaveLength(11);
      expect(harness.downloads.sort()).toEqual((await readdir(harness.remoteDirectory)).sort());
    } finally {
      await harness.cleanup();
    }
  });

  it('rejects a remotely tampered asset through the complete local verification state machine', async () => {
    const harness = await createRemoteVerificationHarness({ tamperAsset: true });
    try {
      await expect(
        verifyRemoteRelease({
          version: harness.fixture.version,
          root: harness.root,
          dependencies: harness.dependencies
        })
      ).rejects.toThrow('SHA256 mismatch');
      expect(harness.downloads).toHaveLength(11);
    } finally {
      await harness.cleanup();
    }
  });
});
