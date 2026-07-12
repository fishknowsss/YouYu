import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
    expect(calls.some((call) => call.includes('ProxyServer /t REG_SZ /d 127.0.0.1:7890'))).toBe(true);
    expect(calls.some((call) => call.includes('ProxyOverride /t REG_SZ /d') && call.includes('*.cn'))).toBe(true);
    expect(
      calls.some((call) =>
        call.includes('CheckNetIsolation.exe LoopbackExempt -a -n="Microsoft.WindowsStore_8wekyb3d8bbwe"')
      )
    ).toBe(true);
    expect(
      calls.some((call) =>
        call.includes('CheckNetIsolation.exe LoopbackExempt -a -n="Microsoft.StorePurchaseApp_8wekyb3d8bbwe"')
      )
    ).toBe(true);
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
      call.includes(
        'reg.exe query HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings /v ProxyEnable'
      )
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
    expect(
      calls.some((call) =>
        call.includes(
          'reg.exe delete HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings /v ProxyServer /f'
        )
      )
    ).toBe(true);
    expect(
      calls.some((call) =>
        call.includes(
          'reg.exe delete HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings /v ProxyOverride /f'
        )
      )
    ).toBe(true);
    expect(calls.some((call) => call.includes('netsh.exe winhttp reset proxy'))).toBe(true);
    expect(calls.some((call) => call.includes('ipconfig.exe /flushdns'))).toBe(true);
    expect(
      calls.some((call) =>
        call.includes('CheckNetIsolation.exe LoopbackExempt -a -n="Microsoft.WindowsStore_8wekyb3d8bbwe"')
      )
    ).toBe(true);
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

  it('restores an app-owned proxy after a process restart', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'youyu-system-proxy-'));
    const proxyState = {
      enabled: false,
      server: 'old:8080',
      override: 'old.local;<local>'
    };
    const runCommand = createMutableProxyCommands(proxyState);

    try {
      const firstProcess = createSystemProxyAdapter({
        platform: 'win32',
        runCommand,
        stateDirectory: dir
      });
      await firstProcess.enable();
      expect(proxyState).toMatchObject({ enabled: true, server: '127.0.0.1:7890' });

      const restartedProcess = createSystemProxyAdapter({
        platform: 'win32',
        runCommand,
        stateDirectory: dir
      });
      await restartedProcess.restore();

      expect(proxyState).toEqual({
        enabled: false,
        server: 'old:8080',
        override: 'old.local;<local>'
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('does not leave a YouYu proxy behind when installation closes Mihomo', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'youyu-system-proxy-'));
    const proxyState = {
      enabled: false,
      server: 'external:8080',
      override: 'external.local;<local>'
    };
    const runCommand = createMutableProxyCommands(proxyState);
    const mihomo = { running: true };

    try {
      const runningApp = createSystemProxyAdapter({ platform: 'win32', runCommand, stateDirectory: dir });
      await runningApp.enable();
      mihomo.running = false;

      const installerFallback = createSystemProxyAdapter({ platform: 'win32', runCommand, stateDirectory: dir });
      await installerFallback.restore();

      expect(mihomo.running).toBe(false);
      expect(proxyState).toEqual({
        enabled: false,
        server: 'external:8080',
        override: 'external.local;<local>'
      });
      expect(proxyState).not.toMatchObject({ enabled: true, server: '127.0.0.1:7890' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('does not overwrite a proxy that the user changed after a crash', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'youyu-system-proxy-'));
    const proxyState = {
      enabled: false,
      server: 'old:8080',
      override: 'old.local;<local>'
    };
    const runCommand = createMutableProxyCommands(proxyState);

    try {
      const firstProcess = createSystemProxyAdapter({
        platform: 'win32',
        runCommand,
        stateDirectory: dir
      });
      await firstProcess.enable();
      proxyState.enabled = true;
      proxyState.server = 'user:9090';
      proxyState.override = 'user.local';

      const restartedProcess = createSystemProxyAdapter({
        platform: 'win32',
        runCommand,
        stateDirectory: dir
      });
      await restartedProcess.restore();

      expect(proxyState).toEqual({ enabled: true, server: 'user:9090', override: 'user.local' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('restores fields already written when a crash happens between registry writes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'youyu-system-proxy-'));
    const previous = { enabled: false, server: 'old:8080', override: 'old.local;<local>' };
    const proxyState = {
      ...previous,
      server: '127.0.0.1:7890'
    };
    const runCommand = createMutableProxyCommands(proxyState);

    try {
      await writeFile(
        join(dir, 'system-proxy-ownership.json'),
        JSON.stringify({
          version: 2,
          capturedAt: new Date().toISOString(),
          previous,
          applied: {
            enabled: true,
            server: '127.0.0.1:7890',
            override: 'app.local;<local>'
          },
          appliedFields: { server: true, override: true, enabled: true }
        })
      );

      const restartedProcess = createSystemProxyAdapter({
        platform: 'win32',
        runCommand,
        stateDirectory: dir
      });
      await restartedProcess.restore();

      expect(proxyState).toEqual(previous);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

function isAppxPackageQuery(command: { file: string; args: string[] }): boolean {
  return command.file === 'powershell.exe' && command.args.join(' ').includes('Get-AppxPackage');
}

function createMutableProxyCommands(state: { enabled: boolean; server: string; override: string }) {
  return async (command: { file: string; args: string[] }): Promise<string> => {
    if (isAppxPackageQuery(command)) return '';
    if (command.file !== 'reg.exe') return '';

    const valueName = command.args[command.args.indexOf('/v') + 1];
    if (command.args[0] === 'query') {
      if (valueName === 'ProxyEnable') return `ProxyEnable    REG_DWORD    ${state.enabled ? '0x1' : '0x0'}`;
      if (valueName === 'ProxyServer') return `ProxyServer    REG_SZ    ${state.server}`;
      if (valueName === 'ProxyOverride') return `ProxyOverride    REG_SZ    ${state.override}`;
    }

    if (command.args[0] === 'delete') {
      if (valueName === 'ProxyServer') state.server = '';
      if (valueName === 'ProxyOverride') state.override = '';
      return '';
    }

    const data = command.args[command.args.indexOf('/d') + 1] ?? '';
    if (valueName === 'ProxyEnable') state.enabled = data === '1';
    if (valueName === 'ProxyServer') state.server = data;
    if (valueName === 'ProxyOverride') state.override = data;
    return '';
  };
}
