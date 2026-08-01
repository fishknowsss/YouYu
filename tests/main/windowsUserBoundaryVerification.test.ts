import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const windowsIt = process.platform === 'win32' ? it : it.skip;

describe('Windows multi-user boundary verification', () => {
  it('ships a read-only SID/session/task/process evidence collector', async () => {
    const source = await readFile('scripts/verify-windows-user-boundary.ps1', 'utf8');

    expect(source).toContain('[string] $ExecutablePath');
    expect(source).toContain('[string] $TargetUserSid');
    expect(source).toContain('[int] $TargetSessionId');
    expect(source).toContain('YouYu-Startup-$targetSid');
    expect(source).toContain('Get-CimInstance -ClassName Win32_Process');
    expect(source).toContain('GetOwnerSid');
    expect(source).toContain("'/Query', '/TN', $taskName, '/XML'");
    expect(source).toContain("status = if ($failures.Count -eq 0) { 'pass' } else { 'fail' }");
    expect(source).not.toMatch(/\b(?:Set|Remove|Stop|New)-(?:Item|Process|ScheduledTask|SmbMapping)\b/);
    expect(source).not.toContain('/Create');
    expect(source).not.toContain('/Delete');
  });

  windowsIt('parses under Windows PowerShell without executing the audit', async () => {
    await expect(
      execFileAsync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          "[void][ScriptBlock]::Create([IO.File]::ReadAllText('scripts/verify-windows-user-boundary.ps1'))"
        ],
        { cwd: process.cwd(), windowsHide: true }
      )
    ).resolves.toBeDefined();
  });
});
