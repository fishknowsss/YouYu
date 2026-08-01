import { describe, expect, it, vi } from 'vitest';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSystemProxyAdapter } from '../../src/main/platform/systemProxy';
import { classifyRuntimeFailure } from '../../src/main/runtimeRecoveryPolicy';

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

  it('exposes a DNS-only low-risk step for diagnostic-targeted repair', async () => {
    const calls: string[] = [];
    const proxy = createSystemProxyAdapter({
      platform: 'win32',
      runCommand: async (command) => {
        calls.push(`${command.file} ${command.args.join(' ')}`);
        return '';
      }
    });

    await proxy.flushDnsForRepair();

    expect(calls).toEqual(['ipconfig.exe /flushdns']);
  });

  it('enables and restores current-user Windows proxy settings', async () => {
    const calls: string[] = [];
    let proxyEnabled = false;
    let proxyServer = 'old:8080';
    let currentOverride = 'old.local;<local>';
    const proxy = createSystemProxyAdapter({
      platform: 'win32',
      runCommand: async (command) => {
        calls.push(`${command.file} ${command.args.join(' ')}`);
        if (isAppxPackageQuery(command)) {
          return installedStorePackageFamilies;
        }
        if (command.args[0] === 'query' && command.args.includes('ProxyEnable')) {
          return `ProxyEnable    REG_DWORD    ${proxyEnabled ? '0x1' : '0x0'}`;
        }
        if (command.args[0] === 'query' && command.args.includes('ProxyServer')) {
          return `ProxyServer    REG_SZ    ${proxyServer}`;
        }
        if (command.args[0] === 'query' && command.args.includes('ProxyOverride')) {
          return `ProxyOverride    REG_SZ    ${currentOverride}`;
        }
        if (command.args[0] === 'add' && command.args.includes('ProxyEnable')) {
          proxyEnabled = command.args[command.args.indexOf('/d') + 1] === '1';
        }
        if (command.args[0] === 'add' && command.args.includes('ProxyServer')) {
          proxyServer = command.args[command.args.indexOf('/d') + 1] ?? '';
        }
        if (command.args[0] === 'add' && command.args.includes('ProxyOverride')) {
          currentOverride = command.args[command.args.indexOf('/d') + 1] ?? '';
        }
        if (command.args[0] === 'delete' && command.args.includes('ProxyServer')) {
          proxyServer = '';
        }
        if (command.args[0] === 'delete' && command.args.includes('ProxyOverride')) {
          currentOverride = '';
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
    let proxyEnabled = false;
    let proxyServer = 'old:8080';
    let currentOverride = '';
    const proxy = createSystemProxyAdapter({
      platform: 'win32',
      runCommand: async (command) => {
        calls.push(`${command.file} ${command.args.join(' ')}`);
        if (isAppxPackageQuery(command)) {
          return installedStorePackageFamilies;
        }
        if (command.args[0] === 'query' && command.args.includes('ProxyEnable')) {
          return `ProxyEnable    REG_DWORD    ${proxyEnabled ? '0x1' : '0x0'}`;
        }
        if (command.args[0] === 'query' && command.args.includes('ProxyServer')) {
          return `ProxyServer    REG_SZ    ${proxyServer}`;
        }
        if (command.args[0] === 'query' && command.args.includes('ProxyOverride')) {
          return currentOverride ? `ProxyOverride    REG_SZ    ${currentOverride}` : '';
        }
        if (command.args[0] === 'add' && command.args.includes('ProxyEnable')) {
          proxyEnabled = command.args[command.args.indexOf('/d') + 1] === '1';
        }
        if (command.args[0] === 'add' && command.args.includes('ProxyServer')) {
          proxyServer = command.args[command.args.indexOf('/d') + 1] ?? '';
        }
        if (command.args[0] === 'add' && command.args.includes('ProxyOverride')) {
          currentOverride = command.args[command.args.indexOf('/d') + 1] ?? '';
        }
        if (command.args[0] === 'delete' && command.args.includes('ProxyServer')) {
          proxyServer = '';
        }
        if (command.args[0] === 'delete' && command.args.includes('ProxyOverride')) {
          currentOverride = '';
        }
        return '';
      }
    });

    await proxy.enable();
    await proxy.enable();

    const proxyEnableQueriesBeforeRestore = calls.filter((call) =>
      call.includes(
        'reg.exe query HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings /v ProxyEnable'
      )
    );
    expect(proxyEnableQueriesBeforeRestore).toHaveLength(2);

    await proxy.restore();

    expect(calls.some((call) => call.includes('ProxyServer /t REG_SZ /d old:8080'))).toBe(true);
  });

  it('treats the documented reg.exe missing-value result as an absent optional proxy string', async () => {
    const proxyState = { enabled: false, server: '', override: '' };
    const mutableCommands = createMutableProxyCommands(proxyState);
    const runCommand = async (command: { file: string; args: string[] }) => {
      const missingOptionalValue =
        command.file === 'reg.exe' &&
        command.args[0] === 'query' &&
        ((command.args.includes('ProxyServer') && !proxyState.server) ||
          (command.args.includes('ProxyOverride') && !proxyState.override));
      if (missingOptionalValue) {
        throw Object.assign(new Error('reg.exe query failed'), {
          stderr: 'ERROR: The system was unable to find the specified registry key or value.'
        });
      }
      return mutableCommands(command);
    };
    const proxy = createSystemProxyAdapter({ platform: 'win32', runCommand });

    await proxy.enable();
    await expect(proxy.restore()).resolves.toBeUndefined();

    expect(proxyState).toEqual({ enabled: false, server: '', override: '' });
  });

  it('rejects enable when the applied proxy cannot be verified after notification', async () => {
    const calls: string[] = [];
    const proxyState = {
      enabled: false,
      server: 'old:8080',
      override: 'old.local;<local>'
    };
    const mutableCommands = createMutableProxyCommands(proxyState);
    const proxy = createSystemProxyAdapter({
      platform: 'win32',
      runCommand: async (command) => {
        calls.push(`${command.file} ${command.args.join(' ')}`);
        if (command.file === 'reg.exe' && command.args[0] === 'add') return '';
        return mutableCommands(command);
      }
    });

    await expect(proxy.enable()).rejects.toThrow(
      'Failed to verify current-user proxy after enable: ProxyEnable=false, ProxyServer="old:8080", ProxyOverride="old.local;<local>"'
    );

    const refreshIndex = calls.findIndex((call) => call.includes('InternetSetOption'));
    const enableReadbacks = calls
      .map((call, index) => ({ call, index }))
      .filter(({ call, index }) => index > refreshIndex && call.includes('reg.exe query'));
    expect(enableReadbacks.map(({ call }) => call)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('/v ProxyEnable'),
        expect.stringContaining('/v ProxyServer'),
        expect.stringContaining('/v ProxyOverride')
      ])
    );
    expect(proxyState).toEqual({ enabled: false, server: 'old:8080', override: 'old.local;<local>' });
    expect(calls.some((call) => call.includes('Get-AppxPackage'))).toBe(false);
  });

  it('does not fail proxy enable when Store loopback exemption commands fail', async () => {
    const calls: string[] = [];
    const proxyState = { enabled: false, server: '', override: '' };
    const mutableCommands = createMutableProxyCommands(proxyState);
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
        return mutableCommands(command);
      }
    });

    await expect(proxy.enable()).resolves.toBeUndefined();

    expect(calls.some((call) => call.includes('ProxyEnable /t REG_DWORD /d 1'))).toBe(true);
    expect(calls.some((call) => call.includes('CheckNetIsolation.exe LoopbackExempt -s'))).toBe(true);
  });

  it('skips Store loopback exemptions when no matching Appx package is installed', async () => {
    const calls: string[] = [];
    const proxyState = { enabled: false, server: '', override: '' };
    const mutableCommands = createMutableProxyCommands(proxyState);
    const proxy = createSystemProxyAdapter({
      platform: 'win32',
      runCommand: async (command) => {
        calls.push(`${command.file} ${command.args.join(' ')}`);
        if (isAppxPackageQuery(command)) {
          return '';
        }
        return mutableCommands(command);
      }
    });

    await proxy.enable();

    expect(calls.some((call) => call.includes('CheckNetIsolation.exe LoopbackExempt -a'))).toBe(false);
  });

  it('disables and verifies the current-user proxy before clearing repair ownership', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'youyu-system-proxy-'));
    const ownershipPath = join(dir, 'system-proxy-ownership.json');
    const proxyState = {
      enabled: false,
      server: 'external:8080',
      override: 'external.local;<local>'
    };
    const mutableCommands = createMutableProxyCommands(proxyState);
    const repairCalls: string[] = [];
    let captureRepairCalls = false;
    const runCommand = async (command: { file: string; args: string[] }) => {
      if (captureRepairCalls) repairCalls.push(`${command.file} ${command.args.join(' ')}`);
      return mutableCommands(command);
    };

    try {
      const proxy = createSystemProxyAdapter({ platform: 'win32', runCommand, stateDirectory: dir });
      await proxy.enable();
      await expect(access(ownershipPath)).resolves.toBeUndefined();
      captureRepairCalls = true;

      await proxy.disableForRepair();

      expect(repairCalls).toHaveLength(3);
      expect(repairCalls[0]).toContain('ProxyEnable /t REG_DWORD /d 0');
      expect(repairCalls[1]).toContain('InternetSetOption');
      expect(repairCalls[2]).toContain('reg.exe query');
      expect(repairCalls[2]).toContain('ProxyEnable');
      expect(proxyState).toEqual({
        enabled: false,
        server: '127.0.0.1:7890',
        override: expect.stringContaining('*.cn')
      });
      await expect(access(ownershipPath)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps repair ownership when the current-user proxy cannot be verified as disabled', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'youyu-system-proxy-'));
    const ownershipPath = join(dir, 'system-proxy-ownership.json');
    const proxyState = { enabled: false, server: 'old:8080', override: 'old.local;<local>' };
    const mutableCommands = createMutableProxyCommands(proxyState);
    let blockDisable = false;
    const runCommand = async (command: { file: string; args: string[] }) => {
      if (
        blockDisable &&
        command.file === 'reg.exe' &&
        command.args[0] === 'add' &&
        command.args.includes('ProxyEnable') &&
        command.args[command.args.indexOf('/d') + 1] === '0'
      ) {
        return '';
      }
      return mutableCommands(command);
    };

    try {
      const proxy = createSystemProxyAdapter({ platform: 'win32', runCommand, stateDirectory: dir });
      await proxy.enable();
      blockDisable = true;

      await expect(proxy.disableForRepair()).rejects.toThrow(
        'Failed to disable current-user proxy for repair: ProxyEnable is still enabled'
      );

      expect(proxyState.enabled).toBe(true);
      await expect(access(ownershipPath)).resolves.toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('repairs remaining Windows network state after the current-user proxy is disabled', async () => {
    const calls: string[] = [];
    const proxyState = {
      enabled: false,
      server: '127.0.0.1:7890',
      override: 'app.local;<local>'
    };
    const mutableCommands = createMutableProxyCommands(proxyState);
    const proxy = createSystemProxyAdapter({
      platform: 'win32',
      runCommand: async (command) => {
        calls.push(`${command.file} ${command.args.join(' ')}`);
        if (isAppxPackageQuery(command)) return installedStorePackageFamilies;
        return mutableCommands(command);
      }
    });

    await proxy.repairSystemNetwork();

    expect(proxyState).toEqual({ enabled: false, server: '', override: '' });
    expect(calls.some((call) => call.includes('ProxyEnable /t REG_DWORD'))).toBe(false);
    const refreshIndex = calls.findIndex((call) => call.includes('InternetSetOption'));
    const proxyReadbackIndex = calls.findIndex(
      (call, index) => index > refreshIndex && call.includes('reg.exe query') && !call.includes('/v ProxyEnable')
    );
    expect(refreshIndex).toBeGreaterThan(-1);
    expect(proxyReadbackIndex).toBeGreaterThan(refreshIndex);
    expect(calls.some((call) => call.includes('ipconfig.exe /flushdns'))).toBe(true);
    expect(calls.some((call) => call.includes('netsh.exe winhttp reset proxy'))).toBe(true);
    expect(
      calls.some((call) =>
        call.includes('CheckNetIsolation.exe LoopbackExempt -a -n="Microsoft.WindowsStore_8wekyb3d8bbwe"')
      )
    ).toBe(true);
  });

  it('does not hide Appx package query failures during elevated network repair', async () => {
    const proxyState = { enabled: false, server: '127.0.0.1:7890', override: '<local>' };
    const mutableCommands = createMutableProxyCommands(proxyState);
    const runElevatedCommand = vi.fn(async () => undefined);
    const proxy = createSystemProxyAdapter({
      platform: 'win32',
      runCommand: async (command) => {
        if (isAppxPackageQuery(command)) throw new Error('Appx package query failed');
        return mutableCommands(command);
      },
      runElevatedCommand
    });

    await expect(proxy.repairSystemNetwork()).rejects.toThrow('Appx package query failed');

    expect(runElevatedCommand).not.toHaveBeenCalled();
  });

  it('checks every native command exit code in the elevated repair script', async () => {
    const commandScripts: string[] = [];
    const elevatedScripts: string[] = [];
    const proxyState = { enabled: false, server: '127.0.0.1:7890', override: '<local>' };
    const mutableCommands = createMutableProxyCommands(proxyState);
    const proxy = createSystemProxyAdapter({
      platform: 'win32',
      runCommand: async (command) => {
        if (command.file === 'powershell.exe') commandScripts.push(command.args.join(' '));
        if (isAppxPackageQuery(command)) return installedStorePackageFamilies;
        return mutableCommands(command);
      },
      runElevatedCommand: async (command) => {
        elevatedScripts.push(command.args.join(' '));
      }
    });

    await proxy.repairSystemNetwork();

    const appxScript = commandScripts.find((script) => script.includes('Get-AppxPackage')) ?? '';
    expect(appxScript).toContain("$ErrorActionPreference = 'Stop'");
    expect(appxScript).toContain('-ErrorAction Stop');
    expect(appxScript).not.toContain('SilentlyContinue');

    const elevatedScript = elevatedScripts[0] ?? '';
    expect(elevatedScript).toContain('& netsh.exe winhttp reset proxy');
    expect(elevatedScript).toContain('& CheckNetIsolation.exe LoopbackExempt -a');
    expect(elevatedScript.match(/if \(\$LASTEXITCODE -ne 0\)/g)).toHaveLength(3);
    expect(elevatedScript).toContain('netsh winhttp reset proxy failed with exit code');
    expect(elevatedScript).toContain('CheckNetIsolation LoopbackExempt failed for');
  });

  it('verifies elevated Store loopback exemptions after applying them', async () => {
    let elevatedScript = '';
    const proxyState = { enabled: false, server: '127.0.0.1:7890', override: '<local>' };
    const mutableCommands = createMutableProxyCommands(proxyState);
    const proxy = createSystemProxyAdapter({
      platform: 'win32',
      runCommand: async (command) => {
        if (isAppxPackageQuery(command)) return installedStorePackageFamilies;
        return mutableCommands(command);
      },
      runElevatedCommand: async (command) => {
        elevatedScript = command.args.join(' ');
      }
    });

    await proxy.repairSystemNetwork();

    expect(elevatedScript).toContain('& CheckNetIsolation.exe LoopbackExempt -s');
    expect(elevatedScript).toContain('$loopbackOutput');
    expect(elevatedScript).toContain('if ($LASTEXITCODE -ne 0)');
    expect(elevatedScript).toContain('$loopbackOutput.IndexOf($family, [StringComparison]::OrdinalIgnoreCase)');
    expect(elevatedScript).toContain('Store loopback verification missing package family $family');
  });

  it('keeps repeated network repair idempotent when proxy strings are already absent', async () => {
    const calls: string[] = [];
    const proxyState = { enabled: false, server: '', override: '' };
    const mutableCommands = createMutableProxyCommands(proxyState);
    const proxy = createSystemProxyAdapter({
      platform: 'win32',
      runCommand: async (command) => {
        calls.push(`${command.file} ${command.args.join(' ')}`);
        if (isAppxPackageQuery(command)) return '';
        if (command.file === 'reg.exe' && command.args[0] === 'delete') {
          throw new Error('registry value not found');
        }
        return mutableCommands(command);
      }
    });

    await expect(proxy.repairSystemNetwork()).resolves.toBeUndefined();

    expect(calls.some((call) => call.includes('reg.exe delete'))).toBe(false);
    expect(calls.some((call) => call.includes('ipconfig.exe /flushdns'))).toBe(true);
    expect(calls.some((call) => call.includes('netsh.exe winhttp reset proxy'))).toBe(true);
  });

  it('attempts every network repair branch and aggregates multiple failures', async () => {
    const calls: string[] = [];
    const proxy = createSystemProxyAdapter({
      platform: 'win32',
      runCommand: async (command) => {
        calls.push(`${command.file} ${command.args.join(' ')}`);
        if (command.file === 'reg.exe' && command.args[0] === 'query' && !command.args.includes('/v')) {
          return ['ProxyServer    REG_SZ    127.0.0.1:7890', 'ProxyOverride    REG_SZ    <local>'].join('\n');
        }
        if (command.file === 'reg.exe' && command.args[0] === 'delete') {
          if (command.args.includes('ProxyServer')) throw new Error('ProxyServer delete denied');
          if (command.args.includes('ProxyOverride')) throw new Error('ProxyOverride delete denied');
        }
        if (command.file === 'ipconfig.exe') throw new Error('DNS flush failed');
        if (isAppxPackageQuery(command)) throw new Error('Appx package query failed');
        return '';
      }
    });

    let repairError: unknown;
    try {
      await proxy.repairSystemNetwork();
    } catch (error) {
      repairError = error;
    }

    expect(repairError).toBeInstanceOf(AggregateError);
    const messages = collectErrorMessages(repairError).join('\n');
    expect(messages).toContain('ProxyServer delete denied');
    expect(messages).toContain('ProxyOverride delete denied');
    expect(messages).toContain('DNS flush failed');
    expect(messages).toContain('Appx package query failed');
    expect(calls.some((call) => call.includes('ProxyServer /f'))).toBe(true);
    expect(calls.some((call) => call.includes('ProxyOverride /f'))).toBe(true);
    expect(calls.some((call) => call.includes('ipconfig.exe /flushdns'))).toBe(true);
    expect(calls.some((call) => call.includes('netsh.exe winhttp reset proxy'))).toBe(true);
    expect(calls.some((call) => call.includes('Get-AppxPackage'))).toBe(true);
  });

  it('keeps compatible repair ordered as proxy disable followed by network repair', async () => {
    const calls: string[] = [];
    const proxyState = { enabled: true, server: '127.0.0.1:7890', override: '<local>' };
    const mutableCommands = createMutableProxyCommands(proxyState);
    const proxy = createSystemProxyAdapter({
      platform: 'win32',
      runCommand: async (command) => {
        calls.push(`${command.file} ${command.args.join(' ')}`);
        if (isAppxPackageQuery(command)) return '';
        return mutableCommands(command);
      }
    });

    await proxy.repair();

    const disableWriteIndex = calls.findIndex((call) => call.includes('ProxyEnable /t REG_DWORD /d 0'));
    const disableRefreshIndex = calls.findIndex(
      (call, index) => index > disableWriteIndex && call.includes('InternetSetOption')
    );
    const disableVerifyIndex = calls.findIndex(
      (call, index) => index > disableRefreshIndex && call.includes('reg.exe query') && call.includes('/v ProxyEnable')
    );
    const networkReadIndex = calls.findIndex(
      (call, index) => index > disableVerifyIndex && call.includes('reg.exe query') && !call.includes('/v')
    );
    const serverDeleteIndex = calls.findIndex(
      (call, index) => index > networkReadIndex && call.includes('ProxyServer /f')
    );
    expect(disableWriteIndex).toBeGreaterThan(-1);
    expect(disableRefreshIndex).toBeGreaterThan(disableWriteIndex);
    expect(disableVerifyIndex).toBeGreaterThan(disableRefreshIndex);
    expect(networkReadIndex).toBeGreaterThan(disableVerifyIndex);
    expect(serverDeleteIndex).toBeGreaterThan(networkReadIndex);
    expect(proxyState).toEqual({ enabled: false, server: '', override: '' });
  });

  it('repairs Windows proxy, WinHTTP proxy, and DNS cache', async () => {
    const calls: string[] = [];
    const proxyState = { enabled: true, server: '127.0.0.1:7890', override: '<local>' };
    const mutableCommands = createMutableProxyCommands(proxyState);
    const proxy = createSystemProxyAdapter({
      platform: 'win32',
      runCommand: async (command) => {
        calls.push(`${command.file} ${command.args.join(' ')}`);
        if (isAppxPackageQuery(command)) {
          return installedStorePackageFamilies;
        }
        return mutableCommands(command);
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

  it('relinquishes only a user-edited field and restores the remaining app-owned fields', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'youyu-system-proxy-'));
    const proxyState = {
      enabled: false,
      server: 'old:8080',
      override: 'old.local;<local>'
    };
    const runCommand = createMutableProxyCommands(proxyState);

    try {
      const firstProcess = createSystemProxyAdapter({ platform: 'win32', runCommand, stateDirectory: dir });
      await firstProcess.enable();
      proxyState.server = 'user:9090';

      const restartedProcess = createSystemProxyAdapter({ platform: 'win32', runCommand, stateDirectory: dir });
      await restartedProcess.restore();

      expect(proxyState).toEqual({
        enabled: true,
        server: 'user:9090',
        override: 'old.local;<local>'
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('does not overwrite a proxy that the user changed before a normal stop', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'youyu-system-proxy-'));
    const proxyState = {
      enabled: false,
      server: 'old:8080',
      override: 'old.local;<local>'
    };
    const runCommand = createMutableProxyCommands(proxyState);

    try {
      const proxy = createSystemProxyAdapter({ platform: 'win32', runCommand, stateDirectory: dir });
      await proxy.enable();
      proxyState.enabled = true;
      proxyState.server = 'user:9090';
      proxyState.override = 'user.local';

      await proxy.restore();

      expect(proxyState).toEqual({ enabled: true, server: 'user:9090', override: 'user.local' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('restores the app proxy while preserving a user-edited bypass list', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'youyu-system-proxy-'));
    const proxyState = {
      enabled: false,
      server: 'old:8080',
      override: 'old.local;<local>'
    };
    const runCommand = createMutableProxyCommands(proxyState);

    try {
      const firstProcess = createSystemProxyAdapter({ platform: 'win32', runCommand, stateDirectory: dir });
      await firstProcess.enable();
      proxyState.override = 'user.local;<local>';

      const restartedProcess = createSystemProxyAdapter({ platform: 'win32', runCommand, stateDirectory: dir });
      await restartedProcess.restore();

      expect(proxyState).toEqual({
        enabled: false,
        server: 'old:8080',
        override: 'user.local;<local>'
      });
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

  it('keeps proxy ownership state when the WinINet refresh command fails during restore', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'youyu-system-proxy-'));
    const ownershipPath = join(dir, 'system-proxy-ownership.json');
    const proxyState = {
      enabled: false,
      server: 'old:8080',
      override: 'old.local;<local>'
    };
    const mutableCommands = createMutableProxyCommands(proxyState);
    let failRefresh = false;
    const runCommand = async (command: { file: string; args: string[] }) => {
      if (failRefresh && command.file === 'powershell.exe' && command.args.join(' ').includes('InternetSetOption')) {
        throw new Error('WinINet refresh failed');
      }
      return mutableCommands(command);
    };

    try {
      const proxy = createSystemProxyAdapter({ platform: 'win32', runCommand, stateDirectory: dir });
      await proxy.enable();
      failRefresh = true;

      await expect(proxy.restore()).rejects.toThrow('WinINet refresh failed');
      await expect(access(ownershipPath)).resolves.toBeUndefined();
      expect(proxyState).toEqual({ enabled: false, server: 'old:8080', override: 'old.local;<local>' });

      failRefresh = false;
      await expect(proxy.restore()).resolves.toBeUndefined();
      await expect(access(ownershipPath)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps ownership and rejects restore when registry write-back cannot be verified', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'youyu-system-proxy-'));
    const ownershipPath = join(dir, 'system-proxy-ownership.json');
    const proxyState = {
      enabled: false,
      server: 'old:8080',
      override: 'old.local;<local>'
    };
    const mutableCommands = createMutableProxyCommands(proxyState);
    let ignoreRegistryWrites = false;
    const runCommand = async (command: { file: string; args: string[] }) => {
      if (ignoreRegistryWrites && command.file === 'reg.exe' && ['add', 'delete'].includes(command.args[0] ?? '')) {
        return '';
      }
      return mutableCommands(command);
    };

    try {
      const proxy = createSystemProxyAdapter({ platform: 'win32', runCommand, stateDirectory: dir });
      await proxy.enable();
      ignoreRegistryWrites = true;

      await expect(proxy.restore()).rejects.toThrow('Failed to verify current-user proxy after restore');
      await expect(access(ownershipPath)).resolves.toBeUndefined();
      expect(proxyState).toMatchObject({ enabled: true, server: '127.0.0.1:7890' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps ownership and blocks restore when a managed registry value cannot be read', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'youyu-system-proxy-'));
    const ownershipPath = join(dir, 'system-proxy-ownership.json');
    const proxyState = {
      enabled: false,
      server: 'old:8080',
      override: 'old.local;<local>'
    };
    const mutableCommands = createMutableProxyCommands(proxyState);
    let failServerRead = false;
    const runCommand = async (command: { file: string; args: string[] }) => {
      if (
        failServerRead &&
        command.file === 'reg.exe' &&
        command.args[0] === 'query' &&
        command.args.includes('ProxyServer')
      ) {
        throw new Error('registry access denied');
      }
      return mutableCommands(command);
    };

    try {
      const proxy = createSystemProxyAdapter({ platform: 'win32', runCommand, stateDirectory: dir });
      await proxy.enable();
      failServerRead = true;

      const restoreError = await proxy.restore().then(
        () => undefined,
        (error: unknown) => error
      );

      expect(restoreError).toBeInstanceOf(Error);
      expect((restoreError as Error).message).toContain('registry access denied');
      expect(classifyRuntimeFailure(restoreError)).toMatchObject({
        code: 'PROXY_RESTORE_REQUIRED',
        retryable: false
      });
      await expect(access(ownershipPath)).resolves.toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('does not swallow a registry deletion failure while restoring an absent previous value', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'youyu-system-proxy-'));
    const ownershipPath = join(dir, 'system-proxy-ownership.json');
    const proxyState = { enabled: false, server: '', override: '' };
    const mutableCommands = createMutableProxyCommands(proxyState);
    let failServerDelete = false;
    const runCommand = async (command: { file: string; args: string[] }) => {
      if (
        failServerDelete &&
        command.file === 'reg.exe' &&
        command.args[0] === 'delete' &&
        command.args.includes('ProxyServer')
      ) {
        throw new Error('ProxyServer delete denied');
      }
      return mutableCommands(command);
    };

    try {
      const proxy = createSystemProxyAdapter({ platform: 'win32', runCommand, stateDirectory: dir });
      await proxy.enable();
      failServerDelete = true;

      await expect(proxy.restore()).rejects.toThrow('ProxyServer delete denied');
      await expect(access(ownershipPath)).resolves.toBeUndefined();
      expect(proxyState).toMatchObject({ enabled: true, server: '127.0.0.1:7890' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps an unreadable ownership file and blocks startup recovery', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'youyu-system-proxy-'));
    const ownershipPath = join(dir, 'system-proxy-ownership.json');
    await writeFile(ownershipPath, '{"version":2,"previous":', 'utf8');
    const proxy = createSystemProxyAdapter({
      platform: 'win32',
      stateDirectory: dir,
      runCommand: createMutableProxyCommands({ enabled: false, server: '', override: '' })
    });

    try {
      await expect(proxy.restore()).rejects.toThrow('Invalid system proxy ownership state');
      await expect(access(ownershipPath)).resolves.toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('makes the WinINet refresh script fail when either native notification fails', async () => {
    const calls: string[] = [];
    const proxyState = { enabled: false, server: '', override: '' };
    const mutableCommands = createMutableProxyCommands(proxyState);
    const proxy = createSystemProxyAdapter({
      platform: 'win32',
      runCommand: async (command) => {
        calls.push(command.args.join(' '));
        return mutableCommands(command);
      }
    });

    await proxy.enable();

    const script = calls.find((call) => call.includes('InternetSetOption')) ?? '';
    expect(script).toContain('$settingsChanged =');
    expect(script).toContain('$settingsRefreshed =');
    expect(script).toContain('if (-not $settingsChanged -or -not $settingsRefreshed)');
    expect(script).toContain('GetLastWin32Error()');
    expect(script).toContain('throw "Failed to refresh WinINet proxy settings: $errorCode"');
  });
});

function isAppxPackageQuery(command: { file: string; args: string[] }): boolean {
  return command.file === 'powershell.exe' && command.args.join(' ').includes('Get-AppxPackage');
}

function createMutableProxyCommands(state: { enabled: boolean; server: string; override: string }) {
  return async (command: { file: string; args: string[] }): Promise<string> => {
    if (isAppxPackageQuery(command)) return '';
    if (command.file !== 'reg.exe') return '';

    if (command.args[0] === 'query' && !command.args.includes('/v')) {
      return [
        state.server ? `ProxyServer    REG_SZ    ${state.server}` : '',
        state.override ? `ProxyOverride    REG_SZ    ${state.override}` : ''
      ]
        .filter(Boolean)
        .join('\n');
    }

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

function collectErrorMessages(error: unknown): string[] {
  if (error instanceof AggregateError) {
    return [error.message, ...error.errors.flatMap(collectErrorMessages)];
  }
  return [error instanceof Error ? error.message : String(error)];
}
