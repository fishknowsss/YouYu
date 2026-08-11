import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  createWindowsPowerShellEnvironment,
  resolveWindowsPowerShellPath,
  windowsPowerShellModuleAnalysisCacheEnvironment
} from '../../src/main/platform/windowsPowerShell';
import {
  createWindowsPowerShellFixtureEnvironment,
  isReusableWindowsPowerShellAnalysisCachePath
} from '../helpers/windowsPowerShellEnvironment';

describe('Windows PowerShell 5.1 process environment', () => {
  it('removes every inherited PowerShell module-path and cache override', () => {
    const source: NodeJS.ProcessEnv = {
      SystemRoot: String.raw`C:\Windows`,
      KEEP: 'preserved',
      PSModulePath: 'PowerShell-7-modules',
      psmodulepath: 'case-variant-must-also-go',
      psmoduleanalysiscachepath: 'shared-cache'
    };

    const environment = createWindowsPowerShellEnvironment(source);

    expect(environment.KEEP).toBe('preserved');
    expect(Object.keys(environment).some((key) => key.toLowerCase() === 'psmodulepath')).toBe(false);
    expect(
      Object.keys(environment).some(
        (key) => key.toLowerCase() === windowsPowerShellModuleAnalysisCacheEnvironment.toLowerCase()
      )
    ).toBe(false);
    expect(source.PSModulePath).toBe('PowerShell-7-modules');
  });

  it('uses the canonical Windows PowerShell 5.1 executable', () => {
    expect(resolveWindowsPowerShellPath(String.raw`C:\Windows`)).toBe(
      String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`
    );
    expect(() => resolveWindowsPowerShellPath('relative')).toThrow('Windows system root path is invalid');
  });

  it('lets repeated fixtures reuse only an existing absolute analysis-cache file', () => {
    const cachePath = String.raw`C:\PSModuleAnalysisCachePath\ModuleAnalysisCache`;
    const existingFile = (path: string) => path === cachePath;

    expect(isReusableWindowsPowerShellAnalysisCachePath(cachePath, existingFile)).toBe(true);
    expect(isReusableWindowsPowerShellAnalysisCachePath('NUL', existingFile)).toBe(false);
    expect(isReusableWindowsPowerShellAnalysisCachePath('relative-cache', existingFile)).toBe(false);
    expect(isReusableWindowsPowerShellAnalysisCachePath(String.raw`C:\missing\ModuleAnalysisCache`, existingFile)).toBe(
      false
    );

    const cachedEnvironment = createWindowsPowerShellFixtureEnvironment(
      {
        KEEP: 'preserved',
        PSModulePath: String.raw`C:\Program Files\PowerShell\7\Modules`,
        PSModuleAnalysisCachePath: cachePath
      },
      existingFile
    );
    expect(cachedEnvironment.KEEP).toBe('preserved');
    expect(Object.keys(cachedEnvironment).some((key) => key.toLowerCase() === 'psmodulepath')).toBe(false);
    expect(
      Object.entries(cachedEnvironment).some(
        ([key, value]) => key.toLowerCase() === 'psmoduleanalysiscachepath' && value === cachePath
      )
    ).toBe(true);

    const duplicateCacheEnvironment = createWindowsPowerShellFixtureEnvironment(
      { PSModuleAnalysisCachePath: cachePath, psmoduleanalysiscachepath: cachePath },
      existingFile
    );
    expect(
      Object.keys(duplicateCacheEnvironment).some((key) => key.toLowerCase() === 'psmoduleanalysiscachepath')
    ).toBe(false);
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
