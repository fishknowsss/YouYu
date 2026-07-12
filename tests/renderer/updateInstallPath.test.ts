import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('update install entry points', () => {
  it('uses the same install handler in easy and advanced interfaces', async () => {
    const source = await readFile('src/renderer/App.tsx', 'utf8');

    expect(source).toContain('function handleInstallUpdate()');
    expect(source.match(/onInstallUpdate=\{handleInstallUpdate\}/g)).toHaveLength(2);
    expect(source).toContain('messageSink: setSettingsMessage');
  });

  it('keeps an installer launch failure from closing the app', async () => {
    const source = await readFile('src/main/index.ts', 'utf8');

    expect(source).toContain('recoverFromUpdateInstallerLaunchFailure');
    expect(source).toContain('if (updateInstallerLaunchFailed)');
    expect(source).toContain('event.preventDefault();');
  });
});
