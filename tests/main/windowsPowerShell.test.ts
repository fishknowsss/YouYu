import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  createWindowsPowerShellEnvironment,
  resolveWindowsPowerShellPath,
  windowsPowerShellModuleAnalysisCacheEnvironment
} from '../../src/main/platform/windowsPowerShell';

describe('Windows PowerShell 5.1 process environment', () => {
  it('removes every inherited PowerShell module-path variant and isolates the analysis cache', () => {
    const source: NodeJS.ProcessEnv = {
      SystemRoot: String.raw`C:\Windows`,
      KEEP: 'preserved',
      PSModulePath: 'PowerShell-7-modules',
      psmodulepath: 'case-variant-must-also-go',
      psmoduleanalysiscachepath: 'shared-cache'
    };

    const environment = createWindowsPowerShellEnvironment(source);

    expect(environment.KEEP).toBe('preserved');
    expect(environment[windowsPowerShellModuleAnalysisCacheEnvironment]).toBe('NUL');
    expect(Object.keys(environment).some((key) => key.toLowerCase() === 'psmodulepath')).toBe(false);
    expect(Object.keys(environment).filter((key) => key.toLowerCase() === 'psmoduleanalysiscachepath')).toEqual([
      windowsPowerShellModuleAnalysisCacheEnvironment
    ]);
    expect(source.PSModulePath).toBe('PowerShell-7-modules');
  });

  it('uses the canonical Windows PowerShell 5.1 executable', () => {
    expect(resolveWindowsPowerShellPath(String.raw`C:\Windows`)).toBe(
      String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`
    );
    expect(() => resolveWindowsPowerShellPath('relative')).toThrow('Windows system root path is invalid');
  });

  it.runIf(process.platform === 'win32')(
    'rebuilds the native module path and resolves the inbox Security module after a poisoned parent',
    () => {
      const script = [
        "$ErrorActionPreference = 'Stop'",
        '$command = Get-Command Get-AuthenticodeSignature -ErrorAction Stop',
        "$paths = @($env:PSModulePath -split ';' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })",
        '[pscustomobject]@{',
        '  version = $PSVersionTable.PSVersion.ToString()',
        '  modulePath = $command.Module.Path',
        '  psHome = $PSHOME',
        '  paths = $paths',
        '} | ConvertTo-Json -Compress'
      ].join('\n');
      const result = spawnSync(resolveWindowsPowerShellPath(), ['-NoProfile', '-NonInteractive', '-Command', script], {
        encoding: 'utf8',
        windowsHide: true,
        env: createWindowsPowerShellEnvironment({
          ...process.env,
          PSModulePath: String.raw`C:\Program Files\PowerShell\7\Modules`
        })
      });

      expect(result.status, result.stderr).toBe(0);
      const parsed = JSON.parse(result.stdout.trim()) as {
        version: string;
        modulePath: string;
        psHome: string;
        paths: string | string[];
      };
      expect(parsed.version).toMatch(/^5\.1\./);
      expect(parsed.modulePath.toLowerCase()).toContain(parsed.psHome.toLowerCase());
      expect(Array.isArray(parsed.paths) ? parsed.paths : [parsed.paths]).not.toContain(
        String.raw`C:\Program Files\PowerShell\7\Modules`
      );
    }
  );
});
