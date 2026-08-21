import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertPublicReleaseDirectory,
  buildReleaseUploadArgs,
  createReleaseArtifactProvenance,
  downloadVerifiedRunArtifact,
  publishGitHubRelease,
  releaseArtifactProvenanceName,
  resolveTagCommitSha,
  selectStarterAssetIds,
  validateBuildWindowsRun,
  validateRunArtifactMetadata,
  verifyDownloadedReleaseArtifact
} from '../../scripts/publish-github-release.mjs';
import { createReleaseSha256Manifest } from '../../scripts/release-sha256-manifest.mjs';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function createPublicReleaseFixture(version = '1.7.10') {
  const releaseDir = await mkdtemp(join(tmpdir(), 'youyu-publish-artifact-'));
  temporaryDirectories.push(releaseDir);
  const sourceName = `YouYu-${version}-Mihomo-v1.19.28-source.tar.gz`;
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
    sourceName
  ];
  for (const name of names.filter((candidate) => !candidate.endsWith('.yml'))) {
    await writeFile(join(releaseDir, name), name, 'utf8');
  }
  for (const name of ['latest.yml', 'latest-in.yml', 'latest-no.yml']) {
    const installer =
      name === 'latest-in.yml'
        ? `YouYu-${version}-x64-in.exe`
        : name === 'latest-no.yml'
          ? `YouYu-${version}-x64-no.exe`
          : `YouYu-${version}-x64.exe`;
    const installerBytes = await readFile(join(releaseDir, installer));
    const sha512 = createHash('sha512').update(installerBytes).digest('base64');
    await writeFile(
      join(releaseDir, name),
      `version: ${version}\nfiles:\n  - url: ${installer}\n    sha512: ${sha512}\n    size: ${installerBytes.length}\npath: ${installer}\nsha512: ${sha512}\n`,
      'utf8'
    );
  }
  await createReleaseSha256Manifest({ releaseDir, version });
  return { releaseDir, names, sourceName, version };
}

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

  it('resolves the requested tag to its peeled commit and rejects a different ref', async () => {
    const commitSha = 'a'.repeat(40);
    const annotatedTagSha = 'b'.repeat(40);
    const runApi = async (args: string[]) => {
      const endpoint = args[1];
      if (endpoint.endsWith('/git/ref/tags/v1.7.10')) {
        return JSON.stringify({ ref: 'refs/tags/v1.7.10', object: { type: 'tag', sha: annotatedTagSha } });
      }
      if (endpoint.endsWith(`/git/tags/${annotatedTagSha}`)) {
        return JSON.stringify({ object: { type: 'commit', sha: commitSha } });
      }
      throw new Error(`unexpected endpoint ${endpoint}`);
    };

    await expect(resolveTagCommitSha('v1.7.10', runApi)).resolves.toBe(commitSha);
    await expect(
      resolveTagCommitSha('v1.7.10', async () =>
        JSON.stringify({ ref: 'refs/tags/v1.7.9', object: { type: 'commit', sha: commitSha } })
      )
    ).rejects.toThrow('tag reference');
  });

  it('accepts only a successful Build Windows run bound to the requested tag commit', () => {
    const run = {
      id: 4242,
      name: 'Build Windows',
      path: '.github/workflows/build-windows.yml',
      event: 'push' as const,
      status: 'completed',
      conclusion: 'success',
      head_branch: 'v1.7.10',
      head_sha: 'a'.repeat(40),
      run_attempt: 2
    };

    expect(
      validateBuildWindowsRun(run, {
        runId: '4242',
        tag: 'v1.7.10',
        commitSha: 'a'.repeat(40)
      })
    ).toMatchObject({ id: 4242, run_attempt: 2 });

    for (const patch of [
      { path: '.github/workflows/validate.yml' },
      { conclusion: 'failure' },
      { head_branch: 'main' },
      { head_sha: 'b'.repeat(40) }
    ]) {
      expect(() =>
        validateBuildWindowsRun({ ...run, ...patch }, { runId: '4242', tag: 'v1.7.10', commitSha: 'a'.repeat(40) })
      ).toThrow();
    }
  });

  it('accepts only the unexpired artifact created by the same run and commit', () => {
    const artifact = {
      id: 73,
      name: 'youyu-windows-x64-1.7.10',
      expired: false,
      size_in_bytes: 1024,
      workflow_run: {
        id: 4242,
        head_branch: 'v1.7.10',
        head_sha: 'a'.repeat(40)
      }
    };
    const expected = {
      runId: '4242',
      tag: 'v1.7.10',
      commitSha: 'a'.repeat(40),
      artifactName: 'youyu-windows-x64-1.7.10'
    };

    expect(validateRunArtifactMetadata({ total_count: 1, artifacts: [artifact] }, expected)).toEqual(artifact);
    expect(() =>
      validateRunArtifactMetadata({ total_count: 1, artifacts: [{ ...artifact, expired: true }] }, expected)
    ).toThrow('expired');
    expect(() =>
      validateRunArtifactMetadata(
        {
          total_count: 1,
          artifacts: [{ ...artifact, workflow_run: { ...artifact.workflow_run, head_sha: 'b'.repeat(40) } }]
        },
        expected
      )
    ).toThrow('commit');
  });

  it('verifies downloaded provenance, the SHA256 manifest, and all three update channels before upload', async () => {
    const { releaseDir, version, names } = await createPublicReleaseFixture();
    const expected = {
      releaseDir,
      version,
      tag: `v${version}`,
      commitSha: 'a'.repeat(40),
      runId: '4242',
      runAttempt: 2,
      event: 'push' as const
    };

    await createReleaseArtifactProvenance(expected);
    await expect(verifyDownloadedReleaseArtifact(expected)).resolves.toMatchObject({
      publicAssetCount: 11,
      manifestAssetCount: 10
    });

    const provenancePath = join(releaseDir, releaseArtifactProvenanceName);
    const provenance = JSON.parse(await readFile(provenancePath, 'utf8')) as Record<string, unknown>;
    await writeFile(
      provenancePath,
      `${JSON.stringify({ ...provenance, commitSha: 'b'.repeat(40) }, null, 2)}\n`,
      'utf8'
    );
    await expect(verifyDownloadedReleaseArtifact(expected)).rejects.toThrow('provenance commit');

    await createReleaseArtifactProvenance(expected);
    await writeFile(join(releaseDir, names[0]), 'tampered after artifact download', 'utf8');
    await expect(verifyDownloadedReleaseArtifact(expected)).rejects.toThrow('SHA256 mismatch');
  });

  it('rejects semantically tampered channel metadata even when its manifest is freshly regenerated', async () => {
    const fixture = await createPublicReleaseFixture();
    await writeFile(
      join(fixture.releaseDir, 'latest-in.yml'),
      `version: ${fixture.version}\npath: YouYu-${fixture.version}-x64-in.exe\nfiles:\n  - url: YouYu-${fixture.version}-x64-in.exe\n  - url: YouYu-${fixture.version}-x64.exe\n`,
      'utf8'
    );
    await createReleaseSha256Manifest({ releaseDir: fixture.releaseDir, version: fixture.version });

    await expect(
      createReleaseArtifactProvenance({
        releaseDir: fixture.releaseDir,
        version: fixture.version,
        tag: `v${fixture.version}`,
        commitSha: 'a'.repeat(40),
        runId: '4242',
        runAttempt: 1,
        event: 'push'
      })
    ).rejects.toThrow('files do not contain only');
  });

  it('writes artifact provenance through the real CLI process boundary', async () => {
    const fixture = await createPublicReleaseFixture();
    const result = spawnSync(
      process.execPath,
      [
        'scripts/publish-github-release.mjs',
        '--write-provenance',
        '--tag',
        `v${fixture.version}`,
        '--dir',
        fixture.releaseDir,
        '--run-id',
        '4242',
        '--run-attempt',
        '2',
        '--commit',
        'a'.repeat(40),
        '--event',
        'push'
      ],
      { cwd: process.cwd(), encoding: 'utf8', windowsHide: true }
    );

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(await readFile(join(fixture.releaseDir, releaseArtifactProvenanceName), 'utf8'))).toMatchObject({
      runId: 4242,
      runAttempt: 2,
      tag: `v${fixture.version}`,
      commitSha: 'a'.repeat(40),
      publicAssets: expect.arrayContaining(['latest.yml', 'latest-in.yml', 'latest-no.yml'])
    });
  });

  it('downloads only after run, tag, commit, and artifact metadata agree, then verifies extracted bytes', async () => {
    const fixture = await createPublicReleaseFixture();
    const destination = await mkdtemp(join(tmpdir(), 'youyu-downloaded-artifact-'));
    temporaryDirectories.push(destination);
    const commitSha = 'a'.repeat(40);
    await createReleaseArtifactProvenance({
      releaseDir: fixture.releaseDir,
      version: fixture.version,
      tag: `v${fixture.version}`,
      commitSha,
      runId: '4242',
      runAttempt: 2,
      event: 'push' as const
    });
    const calls: string[][] = [];
    const runApi = async (args: string[]) => {
      calls.push(args);
      const endpoint = args[1];
      if (args[0] === 'api' && endpoint.endsWith(`/git/ref/tags/v${fixture.version}`)) {
        return JSON.stringify({ ref: `refs/tags/v${fixture.version}`, object: { type: 'commit', sha: commitSha } });
      }
      if (args[0] === 'api' && endpoint.endsWith('/actions/runs/4242')) {
        return JSON.stringify({
          id: 4242,
          name: 'Build Windows',
          path: '.github/workflows/build-windows.yml',
          event: 'push' as const,
          status: 'completed',
          conclusion: 'success',
          head_branch: `v${fixture.version}`,
          head_sha: commitSha,
          run_attempt: 2
        });
      }
      if (args[0] === 'api' && endpoint.includes('/actions/runs/4242/artifacts?')) {
        return JSON.stringify({
          total_count: 1,
          artifacts: [
            {
              id: 73,
              name: `youyu-windows-x64-${fixture.version}`,
              expired: false,
              size_in_bytes: 1024,
              workflow_run: { id: 4242, head_branch: `v${fixture.version}`, head_sha: commitSha }
            }
          ]
        });
      }
      if (args[0] === 'run' && args[1] === 'download') {
        const target = args[args.indexOf('--dir') + 1];
        for (const name of await readdir(fixture.releaseDir)) {
          await cp(join(fixture.releaseDir, name), join(target, name), { recursive: true });
        }
        return '';
      }
      throw new Error(`unexpected gh call: ${args.join(' ')}`);
    };

    await expect(
      downloadVerifiedRunArtifact(
        { runId: '4242', tag: `v${fixture.version}`, version: fixture.version, directory: destination },
        runApi
      )
    ).resolves.toMatchObject({ commitSha, publicAssetCount: 11, manifestAssetCount: 10 });
    expect(calls.map((args) => args[0])).toEqual(['api', 'api', 'api', 'run']);
    const downloadCall = calls.find((args) => args[0] === 'run');
    expect(downloadCall?.[downloadCall.indexOf('--dir') + 1]).not.toBe(destination);
    expect(await readdir(destination)).toEqual(
      expect.arrayContaining(['SHA256SUMS.txt', releaseArtifactProvenanceName])
    );
  });

  it('refuses a non-empty artifact destination before contacting GitHub', async () => {
    const destination = await mkdtemp(join(tmpdir(), 'youyu-stale-artifact-'));
    temporaryDirectories.push(destination);
    await writeFile(join(destination, 'stale.exe'), 'stale', 'utf8');
    const calls: string[][] = [];

    await expect(
      downloadVerifiedRunArtifact(
        { runId: '4242', tag: 'v1.7.10', version: '1.7.10', directory: destination },
        async (args: string[]) => {
          calls.push(args);
          return '';
        }
      )
    ).rejects.toThrow('destination must be empty');
    expect(calls).toEqual([]);
  });

  it('refuses a local manifest tamper before making any GitHub write', async () => {
    const fixture = await createPublicReleaseFixture();
    await writeFile(join(fixture.releaseDir, fixture.names[0]), 'tampered before publish', 'utf8');
    const calls: string[][] = [];

    await expect(
      publishGitHubRelease(
        { tag: `v${fixture.version}`, dir: fixture.releaseDir, publish: true },
        {
          runGh: async (args: string[]) => {
            calls.push(args);
            return '';
          }
        }
      )
    ).rejects.toThrow('SHA256 mismatch');
    expect(calls).toEqual([]);
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
