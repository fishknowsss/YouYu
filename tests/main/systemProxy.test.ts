import { describe, expect, it, vi } from 'vitest';
import { createSystemProxyAdapter } from '../../src/main/platform/systemProxy';

const installedStorePackageFamilies = [
  'Microsoft.WindowsStore_8wekyb3d8bbwe',
  'Microsoft.StorePurchaseApp_8wekyb3d8bbwe'
].join('\n');

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
        if (isAppxPackageQuery(command)) {
          return installedStorePackageFamilies;
        }
        if (command.args[0] === 'query' && command.args.includes('ProxyEnable')) {
          return 'ProxyEnable    REG_DWORD    0x0';
        }
        if (command.args[0] === 'query' && command.args.includes('ProxyServer')) {
          return 'ProxyServer    REG_SZ    old:8080';
        }
        if (command.args[0] === 'query' && command.args.includes('ProxyOverride')) {
          return 'ProxyOverride    REG_SZ    old.local;<local>';
        }
        return '';
      }
    });

    await proxy.enable();
    await proxy.restore();

    expect(calls.some((call) => call.includes('ProxyEnable /t REG_DWORD /d 1'))).toBe(true);
    expect(calls.some((call) => call.includes('ProxyServer /t REG_SZ /d 127.0.0.1:7890'))).toBe(
      true
    );
    expect(calls.some((call) => call.includes('ProxyOverride /t REG_SZ /d') && call.includes('*.cn'))).toBe(true);
    expect(calls.some((call) => call.includes('CheckNetIsolation.exe LoopbackExempt -a -n="Microsoft.WindowsStore_8wekyb3d8bbwe"'))).toBe(true);
    expect(calls.some((call) => call.includes('CheckNetIsolation.exe LoopbackExempt -a -n="Microsoft.StorePurchaseApp_8wekyb3d8bbwe"'))).toBe(true);
    expect(calls.some((call) => call.includes('Microsoft.GamingApp_8wekyb3d8bbwe'))).toBe(false);
    expect(calls.some((call) => call.includes('ProxyEnable /t REG_DWORD /d 0'))).toBe(true);
    expect(calls.some((call) => call.includes('ProxyServer /t REG_SZ /d old:8080'))).toBe(true);
    expect(calls.some((call) => call.includes('ProxyOverride /t REG_SZ /d old.local;<local>'))).toBe(true);
  });

  it('keeps the original proxy state when enable is called twice', async () => {
    const calls: string[] = [];
    const proxy = createSystemProxyAdapter({
      platform: 'win32',
      runCommand: async (command) => {
        calls.push(`${command.file} ${command.args.join(' ')}`);
        if (isAppxPackageQuery(command)) {
          return installedStorePackageFamilies;
        }
        if (command.args[0] === 'query' && command.args.includes('ProxyEnable')) {
          return 'ProxyEnable    REG_DWORD    0x0';
        }
        if (command.args[0] === 'query' && command.args.includes('ProxyServer')) {
          return 'ProxyServer    REG_SZ    old:8080';
        }
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

  it('does not fail proxy enable when Store loopback exemption commands fail', async () => {
    const calls: string[] = [];
    const proxy = createSystemProxyAdapter({
      platform: 'win32',
      runCommand: async (command) => {
        calls.push(`${command.file} ${command.args.join(' ')}`);
        if (isAppxPackageQuery(command)) {
          return installedStorePackageFamilies;
        }
        if (command.file === 'CheckNetIsolation.exe') {
          throw new Error('AppContainer not found');
        }
        if (command.args[0] === 'query' && command.args.includes('ProxyEnable')) {
          return 'ProxyEnable    REG_DWORD    0x0';
        }
        return '';
      }
    });

    await expect(proxy.enable()).resolves.toBeUndefined();

    expect(calls.some((call) => call.includes('ProxyEnable /t REG_DWORD /d 1'))).toBe(true);
    expect(calls.some((call) => call.includes('CheckNetIsolation.exe LoopbackExempt -s'))).toBe(true);
  });

  it('skips Store loopback exemptions when no matching Appx package is installed', async () => {
    const calls: string[] = [];
    const proxy = createSystemProxyAdapter({
      platform: 'win32',
      runCommand: async (command) => {
        calls.push(`${command.file} ${command.args.join(' ')}`);
        if (isAppxPackageQuery(command)) {
          return '';
        }
        if (command.args[0] === 'query' && command.args.includes('ProxyEnable')) {
          return 'ProxyEnable    REG_DWORD    0x0';
        }
        return '';
      }
    });

    await proxy.enable();

    expect(calls.some((call) => call.includes('CheckNetIsolation.exe LoopbackExempt -a'))).toBe(false);
  });

  it('repairs Windows proxy, WinHTTP proxy, and DNS cache', async () => {
    const calls: string[] = [];
    const proxy = createSystemProxyAdapter({
      platform: 'win32',
      runCommand: async (command) => {
        calls.push(`${command.file} ${command.args.join(' ')}`);
        if (isAppxPackageQuery(command)) {
          return installedStorePackageFamilies;
        }
        return '';
      }
    });

    await proxy.repair();

    expect(calls.some((call) => call.includes('ProxyEnable /t REG_DWORD /d 0'))).toBe(true);
    expect(calls.some((call) => call.includes('reg.exe delete HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings /v ProxyServer /f'))).toBe(true);
    expect(calls.some((call) => call.includes('reg.exe delete HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings /v ProxyOverride /f'))).toBe(true);
    expect(calls.some((call) => call.includes('netsh.exe winhttp reset proxy'))).toBe(true);
    expect(calls.some((call) => call.includes('ipconfig.exe /flushdns'))).toBe(true);
    expect(calls.some((call) => call.includes('CheckNetIsolation.exe LoopbackExempt -a -n="Microsoft.WindowsStore_8wekyb3d8bbwe"'))).toBe(true);
  });

  it('reports Store loopback repair failures', async () => {
    const proxy = createSystemProxyAdapter({
      platform: 'win32',
      runCommand: async (command) => {
        if (isAppxPackageQuery(command)) {
          return installedStorePackageFamilies;
        }
        if (command.file === 'CheckNetIsolation.exe') {
          throw new Error('loopback denied');
        }
        return '';
      }
    });

    await expect(proxy.repair()).rejects.toThrow('loopback denied');
  });
});

function isAppxPackageQuery(command: { file: string; args: string[] }): boolean {
  return command.file === 'powershell.exe' && command.args.join(' ').includes('Get-AppxPackage');
}
