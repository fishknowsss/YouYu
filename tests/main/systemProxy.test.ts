import { describe, expect, it, vi } from 'vitest';
import { createSystemProxyAdapter } from '../../src/main/platform/systemProxy';

describe('createSystemProxyAdapter', () => {
  it('does not run Windows proxy commands on macOS', async () => {
    const runCommand = vi.fn();
    const proxy = createSystemProxyAdapter({ platform: 'darwin', runCommand });

    await proxy.enable();
    await proxy.restore();
    await proxy.repair();

    expect(runCommand).not.toHaveBeenCalled();
  });

  it('enables and restores current-user Windows proxy settings', async () => {
    const calls: string[] = [];
    const proxy = createSystemProxyAdapter({
      platform: 'win32',
      runCommand: async (command) => {
        calls.push(`${command.file} ${command.args.join(' ')}`);
        if (command.args.includes('ProxyEnable')) return 'ProxyEnable    REG_DWORD    0x0';
        if (command.args.includes('ProxyServer')) return 'ProxyServer    REG_SZ    old:8080';
        return '';
      }
    });

    await proxy.enable();
    await proxy.restore();

    expect(calls.some((call) => call.includes('ProxyEnable /t REG_DWORD /d 1'))).toBe(true);
    expect(calls.some((call) => call.includes('ProxyServer /t REG_SZ /d 127.0.0.1:7890'))).toBe(
      true
    );
    expect(calls.some((call) => call.includes('ProxyEnable /t REG_DWORD /d 0'))).toBe(true);
    expect(calls.some((call) => call.includes('ProxyServer /t REG_SZ /d old:8080'))).toBe(true);
  });

  it('keeps the original proxy state when enable is called twice', async () => {
    const calls: string[] = [];
    const proxy = createSystemProxyAdapter({
      platform: 'win32',
      runCommand: async (command) => {
        calls.push(`${command.file} ${command.args.join(' ')}`);
        if (command.args.includes('ProxyEnable')) return 'ProxyEnable    REG_DWORD    0x0';
        if (command.args.includes('ProxyServer')) return 'ProxyServer    REG_SZ    old:8080';
        return '';
      }
    });

    await proxy.enable();
    await proxy.enable();
    await proxy.restore();

    const proxyEnableQueries = calls.filter((call) =>
      call.includes('reg.exe query HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings /v ProxyEnable')
    );
    expect(proxyEnableQueries).toHaveLength(1);
    expect(calls.some((call) => call.includes('ProxyServer /t REG_SZ /d old:8080'))).toBe(true);
  });
});
