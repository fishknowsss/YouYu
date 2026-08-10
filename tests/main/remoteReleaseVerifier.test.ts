import { describe, expect, it } from 'vitest';
import {
  describeEffectiveProxy,
  getExpectedPublicAssetNames,
  parseCurlMetrics,
  resolveGitHubApiEndpoint,
  validateChannelMetadata,
  validateReleaseAssetNames
} from '../../scripts/verify-remote-release.mjs';

describe('remote release verifier', () => {
  it('describes a proxy route without exposing credentials', () => {
    expect(describeEffectiveProxy({ HTTPS_PROXY: 'http://secret-user:secret-pass@127.0.0.1:17890' })).toEqual({
      label: 'HTTPS_PROXY http://127.0.0.1:17890',
      proxyConfigured: true
    });
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

  it('validates each update channel installer path', () => {
    validateChannelMetadata(
      'latest-in.yml',
      'version: 1.7.4\npath: YouYu-1.7.4-x64-in.exe\nfiles:\n  - url: YouYu-1.7.4-x64-in.exe\n',
      '1.7.4'
    );
    expect(() =>
      validateChannelMetadata('latest-no.yml', 'version: 1.7.4\npath: YouYu-1.7.4-x64.exe\n', '1.7.4')
    ).toThrow('does not point to YouYu-1.7.4-x64-no.exe');
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
});
