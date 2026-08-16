import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import {
  buildSidBoundStartupTaskName,
  resolveCurrentWindowsUserIdentity
} from '../../src/main/platform/windowsUserIdentity';
import {
  createWindowsPowerShellEnvironment,
  resolveWindowsPowerShellPath
} from '../../src/main/platform/windowsPowerShell';

describe('Windows user identity boundary', () => {
  it('locks the default exec boundary to canonical PS5 with an isolated module environment', async () => {
    const source = await readFile('src/main/platform/windowsUserIdentity.ts', 'utf8');
    const defaultRunner = source.slice(source.indexOf('async function defaultRunPowerShell'));
    const environment = createWindowsPowerShellEnvironment({
      KEEP: 'preserved',
      pSmOdUlEpAtH: 'PowerShell-7-modules-must-not-survive',
      pSmOdUlEaNaLySiScAcHePaTh: 'shared-cache-must-not-survive'
    });

    expect(defaultRunner).toMatch(
      /execFileAsync\(\s*resolveWindowsPowerShellPath\(\),[\s\S]*?timeout: 15000,[\s\S]*?env: createWindowsPowerShellEnvironment\(\)/
    );
    expect(resolveWindowsPowerShellPath(String.raw`C:\Windows`)).toBe(
      String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`
    );
    expect(environment.KEEP).toBe('preserved');
    expect(Object.keys(environment).some((key) => key.toLowerCase() === 'psmodulepath')).toBe(false);
    expect(Object.keys(environment).some((key) => key.toLowerCase() === 'psmoduleanalysiscachepath')).toBe(false);
  });

  it('resolves and normalizes the current standard-user SID and session through an injected boundary', async () => {
    const runPowerShell = vi.fn(async () => '{"userSid":"s-1-5-21-100-200-300-1001","sessionId":7,"isElevated":false}');

    await expect(
      resolveCurrentWindowsUserIdentity({ platform: 'win32', processId: 4242, runPowerShell })
    ).resolves.toEqual({ userSid: 'S-1-5-21-100-200-300-1001', sessionId: 7 });
    expect(runPowerShell).toHaveBeenCalledWith(expect.stringContaining('Get-Process -Id 4242'));
    expect(buildSidBoundStartupTaskName('S-1-5-21-100-200-300-1001')).toBe('YouYu-Startup-S-1-5-21-100-200-300-1001');
  });

  it.each([
    ['an elevated token', '{"userSid":"S-1-5-21-100-200-300-1001","sessionId":7,"isElevated":true}'],
    ['session zero', '{"userSid":"S-1-5-21-100-200-300-1001","sessionId":0,"isElevated":false}'],
    ['a service SID', '{"userSid":"S-1-5-18","sessionId":7,"isElevated":false}']
  ])('rejects %s as an update/install user boundary', async (_reason, response) => {
    await expect(
      resolveCurrentWindowsUserIdentity({
        platform: 'win32',
        processId: 4242,
        runPowerShell: async () => response
      })
    ).rejects.toThrow();
  });
});
