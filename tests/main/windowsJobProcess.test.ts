import { spawnSync } from 'node:child_process';
import { join, win32 } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  buildWindowsJobProcessScript,
  selectMihomoProcessSpawner,
  spawnWindowsJobProcess,
  windowsJobNativeTypePowerShell
} from '../../src/main/platform/windowsJobProcess';

describe('Windows Job Object process host', () => {
  it('starts the host at the canonical PS5 path with an isolated module environment', () => {
    const spawnHost = vi.fn(() => ({}) as never);
    const originalModuleEntries = Object.entries(process.env).filter(([key]) =>
      ['psmodulepath', 'psmoduleanalysiscachepath'].includes(key.toLowerCase())
    );
    for (const [key] of originalModuleEntries) delete process.env[key];
    process.env.pSmOdUlEpAtH = 'PowerShell-7-modules-must-not-survive';
    process.env.pSmOdUlEaNaLySiScAcHePaTh = 'shared-cache-must-not-survive';

    try {
      spawnWindowsJobProcess('C:\\Program Files\\YouYu\\mihomo.exe', [], { spawnHost });
      const [hostPath, , hostOptions] = spawnHost.mock.calls[0] as unknown as [
        string,
        string[],
        { env: NodeJS.ProcessEnv }
      ];
      expect(hostPath).toBe(
        win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      );
      expect(Object.keys(hostOptions.env).some((key) => key.toLowerCase() === 'psmodulepath')).toBe(false);
      expect(Object.keys(hostOptions.env).filter((key) => key.toLowerCase() === 'psmoduleanalysiscachepath')).toEqual([
        'PSModuleAnalysisCachePath'
      ]);
      expect(hostOptions.env.PSModuleAnalysisCachePath).toBe('NUL');
    } finally {
      for (const key of Object.keys(process.env)) {
        if (['psmodulepath', 'psmoduleanalysiscachepath'].includes(key.toLowerCase())) delete process.env[key];
      }
      for (const [key, value] of originalModuleEntries) process.env[key] = value;
    }
  });

  it('compiles the native Job Object and bounded-frame bridge on supported Windows PowerShell', () => {
    const source = [
      ...windowsJobNativeTypePowerShell(),
      '[Console]::Write([YouYu.WindowsJobNative]::JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE)'
    ].join('\r\n');

    const compiled = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', 'Invoke-Expression ([Console]::In.ReadToEnd())'],
      { encoding: 'utf8', input: source, windowsHide: true }
    );
    expect(compiled.status, compiled.stderr).toBe(0);
    expect(compiled.stdout).toBe('8192');
  });

  it.runIf(process.platform === 'win32')(
    'starts a harmless child inside the real Job Object host and forwards its output',
    async () => {
      const powershellPath = join(
        process.env.SystemRoot ?? 'C:\\Windows',
        'System32',
        'WindowsPowerShell',
        'v1.0',
        'powershell.exe'
      );
      const host = spawnWindowsJobProcess(powershellPath, [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "[Console]::WriteLine('job-child-ok')"
      ]);
      let stdout = '';
      let stderr = '';
      host.stdout?.on('data', (chunk) => (stdout += String(chunk)));
      host.stderr?.on('data', (chunk) => (stderr += String(chunk)));

      const code = await new Promise<number | null>((resolve, reject) => {
        host.once('error', reject);
        host.once('exit', resolve);
      });

      expect(code, stderr).toBe(0);
      expect(stdout).toContain('job-child-ok');
    },
    15_000
  );

  it.runIf(process.platform === 'win32')(
    'kills the contained child when the long-lived Job Object host exits abnormally',
    async () => {
      const powershellPath = join(
        process.env.SystemRoot ?? 'C:\\Windows',
        'System32',
        'WindowsPowerShell',
        'v1.0',
        'powershell.exe'
      );
      const host = spawnWindowsJobProcess(powershellPath, [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "[Console]::WriteLine('JOB_CHILD_PID=' + $PID); Start-Sleep -Seconds 30"
      ]);
      let childPid: number | undefined;
      const childPidReady = new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('contained child did not report its pid')), 10_000);
        host.once('error', reject);
        host.stdout?.on('data', (chunk) => {
          const match = /JOB_CHILD_PID=(\d+)/.exec(String(chunk));
          if (!match) return;
          clearTimeout(timer);
          childPid = Number(match[1]);
          resolve(childPid);
        });
      });

      try {
        const pid = await childPidReady;
        const hostExited = new Promise<void>((resolve) => host.once('exit', () => resolve()));
        expect(host.kill()).toBe(true);
        await hostExited;

        let childExists = true;
        for (let attempt = 0; attempt < 20; attempt += 1) {
          try {
            process.kill(pid, 0);
          } catch {
            childExists = false;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        expect(childExists).toBe(false);
      } finally {
        if (childPid) {
          try {
            process.kill(childPid);
          } catch {
            // The Job Object should already have terminated this test-owned child.
          }
        }
        if (!host.killed) host.kill();
      }
    },
    20_000
  );

  it('owns mihomo for the entire child lifetime and fails closed at every Job Object setup boundary', () => {
    const script = buildWindowsJobProcessScript({
      binaryPath: `C:\\Program Files\\YouYu\\mihomo'quoted.exe`,
      args: ['-d', 'C:\\Users\\测试 用户\\mihomo', '-f', 'config.yaml'],
      parentPid: 1234,
      pollIntervalMs: 250
    });

    expect(script).not.toContain("mihomo'quoted.exe");
    expect(script).not.toContain('测试 用户');
    expect(script).toContain('JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE');
    expect(script).toContain('CreateJobObject');
    expect(script).toContain('SetInformationJobObject');
    const nativeMatch = /\$nativeSource = @'\r?\n([\s\S]*?)\r?\n'@/.exec(script);
    expect(nativeMatch).not.toBeNull();
    const nativeSource = nativeMatch?.[1] ?? '';
    expect(nativeSource).toContain('CREATE_SUSPENDED');
    expect(nativeSource).toContain('AssignProcessToJobObject');
    expect(nativeSource).toContain('ResumeThread');
    expect(nativeSource).toContain('TerminateProcess');
    expect(nativeSource).toContain('DuplicateHandle');
    expect(script).toMatch(/if \(\$jobHandle -eq \[IntPtr\]::Zero\) \{ throw/);
    expect(script).toMatch(/if \(-not \$configured\) \{ throw/);
    expect(nativeSource).toMatch(
      /if \(!AssignProcessToJobObject[\s\S]*?TerminateProcess[\s\S]*?throw new Win32Exception/
    );
    expect(script).toContain('Get-Process -Id 1234');
    expect(script).toContain('$process.WaitForExit()');
    expect(script.indexOf('$process.WaitForExit()')).toBeLessThan(script.lastIndexOf('CloseHandle'));
    expect(script).toContain('StartProcessSuspendedAndAssignToJobObject');
    expect(script).toContain('$true)');

    const parsed = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', '[ScriptBlock]::Create([Console]::In.ReadToEnd()) | Out-Null'],
      { encoding: 'utf8', input: script, windowsHide: true }
    );
    expect(parsed.status, `${parsed.error?.message ?? ''}\n${parsed.stderr}`).toBe(0);
  });

  it('never falls back to an uncontained Windows child when the Job Object host fails', () => {
    const directSpawn = vi.fn(() => ({ direct: true }));
    const jobFailure = new Error('job setup rejected');
    const jobSpawn = vi.fn(() => {
      throw jobFailure;
    });
    const spawn = selectMihomoProcessSpawner({
      platform: 'win32',
      spawnDirect: directSpawn,
      spawnWindowsJob: jobSpawn
    });

    expect(() => spawn('mihomo.exe', ['-f', 'config.yaml'])).toThrow(jobFailure);
    expect(jobSpawn).toHaveBeenCalledExactlyOnceWith('mihomo.exe', ['-f', 'config.yaml']);
    expect(directSpawn).not.toHaveBeenCalled();
  });

  it('keeps the existing direct process behavior off Windows', () => {
    const directSpawn = vi.fn(() => ({ direct: true }));
    const jobSpawn = vi.fn(() => ({ job: true }));
    const spawn = selectMihomoProcessSpawner({
      platform: 'linux',
      spawnDirect: directSpawn,
      spawnWindowsJob: jobSpawn
    });

    expect(spawn('mihomo', ['-t'])).toEqual({ direct: true });
    expect(directSpawn).toHaveBeenCalledExactlyOnceWith('mihomo', ['-t']);
    expect(jobSpawn).not.toHaveBeenCalled();
  });
});
