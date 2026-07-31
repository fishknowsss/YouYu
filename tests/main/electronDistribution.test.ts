import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('Electron Windows distribution', () => {
  it('pins the exact official win32 x64 archive used by the package version', async () => {
    const packageJson = JSON.parse(await readFile('package.json', 'utf8')) as {
      devDependencies?: { electron?: string };
    };
    const manifest = JSON.parse(await readFile('scripts/electron-win-x64.json', 'utf8')) as {
      schemaVersion?: number;
      project?: string;
      version?: string;
      platform?: string;
      arch?: string;
      assetName?: string;
      assetUrl?: string;
      shasumsUrl?: string;
      size?: number;
      sha256?: string;
    };

    expect(manifest).toEqual({
      schemaVersion: 1,
      project: 'electron/electron',
      version: '43.2.0',
      platform: 'win32',
      arch: 'x64',
      assetName: 'electron-v43.2.0-win32-x64.zip',
      assetUrl: 'https://github.com/electron/electron/releases/download/v43.2.0/electron-v43.2.0-win32-x64.zip',
      shasumsUrl: 'https://github.com/electron/electron/releases/download/v43.2.0/SHASUMS256.txt',
      size: 144_326_439,
      sha256: 'eba5f5088af40ecb364fe258809c79a5234c6ece5a75c64722772eba01b02786'
    });
    expect(packageJson.devDependencies?.electron).toBe(manifest.version);
  });

  it('requires the cache script to verify size and SHA256 before reuse', async () => {
    const script = await readFile('scripts/cache-electron-win.mjs', 'utf8');

    expect(script).toContain("import electronDistribution from './electron-win-x64.json'");
    expect(script).toContain('await isVerifiedElectronArchive(builderCachePath)');
    expect(script).toContain('stats.size !== electronDistribution.size');
    expect(script).toContain('sha256 !== electronDistribution.sha256');
  });
});
