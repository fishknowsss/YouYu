import { describe, expect, it } from 'vitest';
import { buildElevatedProcessScript } from '../../src/main/platform/elevatedProcess';

describe('elevated mihomo process script', () => {
  it('uses encoded inputs and stops when either the app exits or cancellation is requested', () => {
    const script = buildElevatedProcessScript({
      binaryPath: `C:\\Program Files\\YouYu\\mihomo'quoted.exe`,
      args: ['-d', 'C:\\Users\\测试 用户\\mihomo', '-f', 'config.yaml'],
      pipeName: 'youyu-elevated-test',
      operationId: 'operation-test',
      parentPid: 1234,
      pollIntervalMs: 250,
      receivesMihomoConfig: true
    });

    expect(script).not.toContain("mihomo'quoted.exe");
    expect(script).not.toContain('测试 用户');
    expect(script).toContain('ConvertFrom-Json');
    expect(script).toContain('NamedPipeClientStream');
    expect(script).toContain('if ($request.canceled)');
    expect(script).toContain("$readTask.Result -eq 'STOP'");
    expect(script).toContain('Get-Process -Id 1234');
    expect(script).toContain('Stop-Process -Id $process.Id -Force');
    expect(script).toContain("GetFolderPath('CommonApplicationData')");
    expect(script).toContain('SetAccessControl($secureWorkDir, $acl)');
    expect(script).not.toContain('RedirectStandardOutput');
    expect(script.indexOf('if ($request.canceled)')).toBeLessThan(script.indexOf('Start-Process -FilePath $binary'));

    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const parsed = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `[ScriptBlock]::Create([Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encoded}'))) | Out-Null`
      ],
      { encoding: 'utf8', windowsHide: true }
    );
    expect(parsed.status, parsed.stderr).toBe(0);
  });
});
import { spawnSync } from 'node:child_process';
