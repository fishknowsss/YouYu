import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('legacy NSIS update elevation metadata', () => {
  it('keeps the deterministic elevate.exe route for old clients while new clients use the CLI bridge', async () => {
    const config = await readFile('electron-builder.yml', 'utf8');
    const validator = await readFile('scripts/validate-windows-release.ts', 'utf8');
    const appSource = await readFile('src/main/index.ts', 'utf8');

    expect(config).toMatch(/nsis:[\s\S]*?perMachine:\s*true[\s\S]*?packElevateHelper:\s*true/);
    expect(validator).toContain('metadataFile.isAdminRightsRequired !== true');
    expect(validator).toContain('legacy NSIS update route');
    expect(appSource).toContain('autoUpdater.autoInstallOnAppQuit = false');
    expect(appSource).toContain('await launchDownloadedUpdateInstaller({');
  });
});
