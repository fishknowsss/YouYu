import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  findForbiddenTrackedPaths,
  findPrivateKeyContentFindings,
  findRepositoryPrivateKeyPaths,
  listRepositoryCandidatePaths,
  keepExistingTrackedPaths
} from '../../scripts/validate-repository-hygiene.mjs';

describe('repository hygiene', () => {
  it('rejects local state, generated output, private subscriptions, and agent files', () => {
    const findings = findForbiddenTrackedPaths([
      'cloudflare/youyu-traffic/.wrangler/state/local.sqlite',
      'scripts/__pycache__/assets.cpython-312.pyc',
      'release/YouYu-1.0.0-x64.exe',
      'release-archive/YouYu-1.0.0-x64.exe',
      'team-builds/YouYu-1.0.0-x64-in.exe',
      '.team-builds-staging-a1b2c3/YouYu-1.0.0-x64-in.exe',
      '.team-builds-previous/YouYu-0.9.9-x64-no.exe',
      'local-subscription-builds/1.0.0/YouYu-1.0.0-x64-no.exe',
      'resources/default-subscription.in.txt',
      '.env.production',
      'cloudflare/youyu-traffic/.dev.vars',
      '.codex/local-state.json',
      'debug.log',
      '.idea/workspace.xml',
      '.vs/YouYu/v17/.suo',
      '.eslintcache',
      'tsconfig.tsbuildinfo',
      'playwright-report/index.html',
      'test-results/ui/trace.zip',
      'renderer.heapsnapshot',
      'YouYu.dmp',
      'signing/production-certificate.pfx',
      'signing/private.key',
      'signing/private.ppk',
      'signing/private.jks',
      'signing/private.keystore'
    ]);

    expect(findings.map((finding) => finding.path)).toEqual([
      'cloudflare/youyu-traffic/.wrangler/state/local.sqlite',
      'scripts/__pycache__/assets.cpython-312.pyc',
      'release/YouYu-1.0.0-x64.exe',
      'release-archive/YouYu-1.0.0-x64.exe',
      'team-builds/YouYu-1.0.0-x64-in.exe',
      '.team-builds-staging-a1b2c3/YouYu-1.0.0-x64-in.exe',
      '.team-builds-previous/YouYu-0.9.9-x64-no.exe',
      'local-subscription-builds/1.0.0/YouYu-1.0.0-x64-no.exe',
      'resources/default-subscription.in.txt',
      '.env.production',
      'cloudflare/youyu-traffic/.dev.vars',
      '.codex/local-state.json',
      'debug.log',
      '.idea/workspace.xml',
      '.vs/YouYu/v17/.suo',
      '.eslintcache',
      'tsconfig.tsbuildinfo',
      'playwright-report/index.html',
      'test-results/ui/trace.zip',
      'renderer.heapsnapshot',
      'YouYu.dmp',
      'signing/production-certificate.pfx',
      'signing/private.key',
      'signing/private.ppk',
      'signing/private.jks',
      'signing/private.keystore'
    ]);
  });

  it('allows source, docs, the public empty-subscription path, and the bundled Mihomo runtime', () => {
    expect(
      findForbiddenTrackedPaths([
        'src/main/index.ts',
        'docs/release-packaging.md',
        '.env.example',
        'cloudflare/youyu-traffic/.env.example',
        'resources/default-subscription.txt',
        'signing/public-certificate.pem',
        'resources/mihomo/win-x64/mihomo.exe'
      ])
    ).toEqual([]);
  });

  it('rejects private-key PEM markers without rejecting public certificates or env examples', () => {
    const begin = '-----BEGIN';
    const end = 'KEY-----';
    expect(
      findPrivateKeyContentFindings([
        { path: 'signing/public.pem', source: '-----BEGIN CERTIFICATE-----\npublic\n-----END CERTIFICATE-----' },
        { path: '.env.example', source: 'TOKEN=replace-me' },
        { path: 'signing/pkcs8.pem', source: `${begin} PRIVATE ${end}\nsecret` },
        { path: 'signing/rsa.pem', source: `${begin} RSA PRIVATE ${end}\nsecret` },
        { path: 'signing/openssh.txt', source: `${begin} OPENSSH PRIVATE ${end}\nsecret` }
      ])
    ).toEqual([
      { path: 'signing/pkcs8.pem', reason: 'private key in repository text' },
      { path: 'signing/rsa.pem', reason: 'private key in repository text' },
      { path: 'signing/openssh.txt', reason: 'private key in repository text' }
    ]);
  });

  it('does not block validation on tracked files already deleted from the working tree', () => {
    const existing = new Set(['src/main/index.ts']);

    expect(
      keepExistingTrackedPaths(['src/main/index.ts', 'cloudflare/youyu-traffic/.wrangler/state.sqlite'], (path) =>
        existing.has(path)
      )
    ).toEqual(['src/main/index.ts']);
  });

  it('checks tracked and untracked candidates while excluding ignored files before staging', () => {
    const repository = mkdtempSync(join(tmpdir(), 'youyu-repository-hygiene-'));
    const privateKeyMarker = ['-----BEGIN', 'PRIVATE KEY-----'].join(' ');
    try {
      execFileSync('git', ['init', '--quiet'], { cwd: repository, windowsHide: true });
      writeFileSync(join(repository, '.gitignore'), 'ignored/\n', 'utf8');
      writeFileSync(join(repository, 'tracked.ts'), 'export const tracked = true;\n', 'utf8');
      writeFileSync(join(repository, '.env.local'), 'TOKEN=do-not-commit\n', 'utf8');
      writeFileSync(join(repository, 'untracked-secret.txt'), `${privateKeyMarker}\nsecret\n`, 'utf8');
      mkdirSync(join(repository, 'ignored'));
      writeFileSync(join(repository, 'ignored', 'private.txt'), `${privateKeyMarker}\nignored\n`, 'utf8');
      execFileSync('git', ['-c', 'core.autocrlf=false', 'add', '.gitignore', 'tracked.ts'], {
        cwd: repository,
        windowsHide: true
      });

      expect(listRepositoryCandidatePaths(repository).sort()).toEqual(
        ['.env.local', '.gitignore', 'tracked.ts', 'untracked-secret.txt'].sort()
      );
      expect(findRepositoryPrivateKeyPaths(repository)).toEqual(['untracked-secret.txt']);
      expect(findForbiddenTrackedPaths(listRepositoryCandidatePaths(repository))).toContainEqual({
        path: '.env.local',
        reason: 'local environment secrets'
      });
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  });
});
