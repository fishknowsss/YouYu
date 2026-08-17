import { describe, expect, it } from 'vitest';
import {
  assertPublicReleaseDirectory,
  buildReleaseUploadArgs,
  selectStarterAssetIds
} from '../../scripts/publish-github-release.mjs';

describe('publish-github-release', () => {
  it('uploads only the public 11 assets and clobbers incomplete starter files', () => {
    const files = [
      'C:/tmp/release/YouYu-1.7.10-x64.exe',
      'C:/tmp/release/YouYu-1.7.10-x64-in.exe',
      'C:/tmp/release/YouYu-1.7.10-x64-no.exe'
    ];
    expect(buildReleaseUploadArgs('v1.7.10', files)).toEqual(['release', 'upload', 'v1.7.10', '--clobber', ...files]);
  });

  it('refuses team-builds as a public upload source', () => {
    expect(() => assertPublicReleaseDirectory('C:/Users/me/YouYu/team-builds')).toThrow('team-builds');
    expect(() => assertPublicReleaseDirectory('C:/Users/me/YouYu/release')).not.toThrow();
  });

  it('selects only starter assets that would block a retry', () => {
    expect(
      selectStarterAssetIds(
        [
          { id: 1, name: 'YouYu-1.7.10-x64-no.exe', state: 'starter' },
          { id: 2, name: 'YouYu-1.7.10-x64-in.exe', state: 'uploaded' },
          { id: 3, name: 'notes.md', state: 'starter' }
        ],
        ['YouYu-1.7.10-x64-no.exe', 'YouYu-1.7.10-x64-in.exe']
      )
    ).toEqual([1]);
  });
});
