import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const windowsIt = process.platform === 'win32' ? it : it.skip;

describe('restore-owned-proxy.ps1', () => {
  windowsIt('preserves a third-party server while restoring the remaining owned field', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'youyu-installer-proxy-'));
    const statePath = join(dir, 'system-proxy-ownership.json');
    const suffix = randomUUID().replaceAll('-', '');
    const registryKey = `HKCU\\Software\\YouYu\\Tests\\ProxyRestore\\${suffix}`;
    const registryPath = `HKCU:\\Software\\YouYu\\Tests\\ProxyRestore\\${suffix}`;
    assertSafeRegistryTestKey(registryKey);

    try {
      await runRegistry(['add', registryKey, '/f']);
      await runRegistry(['add', registryKey, '/v', 'ProxyEnable', '/t', 'REG_DWORD', '/d', '1', '/f']);
      await runRegistry(['add', registryKey, '/v', 'ProxyServer', '/t', 'REG_SZ', '/d', 'user:9090', '/f']);
      await runRegistry(['add', registryKey, '/v', 'ProxyOverride', '/t', 'REG_SZ', '/d', 'app.local', '/f']);
      await writeFile(
        statePath,
        JSON.stringify({
          version: 2,
          capturedAt: '2026-08-01T00:00:00.000Z',
          previous: { enabled: false, server: 'old:8080', override: 'old.local' },
          applied: { enabled: true, server: '127.0.0.1:7890', override: 'app.local' },
          appliedFields: { enabled: true, server: true, override: true }
        }),
        'utf8'
      );

      await runRestoreScript(registryPath, statePath);

      expect(await queryRegistryValue(registryKey, 'ProxyEnable')).toMatch(/REG_DWORD\s+0x1/i);
      expect(await queryRegistryValue(registryKey, 'ProxyServer')).toMatch(/REG_SZ\s+user:9090/i);
      expect(await queryRegistryValue(registryKey, 'ProxyOverride')).toMatch(/REG_SZ\s+old\.local/i);
      await expect(access(statePath)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await runRegistry(['delete', registryKey, '/f']).catch(() => undefined);
      await rm(dir, { recursive: true, force: true });
    }
  });

  windowsIt('deletes previously absent values and verifies a complete owned restore', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'youyu-installer-proxy-'));
    const statePath = join(dir, 'system-proxy-ownership.json');
    const suffix = randomUUID().replaceAll('-', '');
    const registryKey = `HKCU\\Software\\YouYu\\Tests\\ProxyRestore\\${suffix}`;
    const registryPath = `HKCU:\\Software\\YouYu\\Tests\\ProxyRestore\\${suffix}`;
    assertSafeRegistryTestKey(registryKey);

    try {
      await runRegistry(['add', registryKey, '/f']);
      await runRegistry(['add', registryKey, '/v', 'ProxyEnable', '/t', 'REG_DWORD', '/d', '1', '/f']);
      await runRegistry(['add', registryKey, '/v', 'ProxyServer', '/t', 'REG_SZ', '/d', '127.0.0.1:7890', '/f']);
      await runRegistry(['add', registryKey, '/v', 'ProxyOverride', '/t', 'REG_SZ', '/d', 'app.local', '/f']);
      await writeFile(
        statePath,
        JSON.stringify({
          version: 2,
          capturedAt: '2026-08-01T00:00:00.000Z',
          previous: { enabled: false, server: '', override: '' },
          applied: { enabled: true, server: '127.0.0.1:7890', override: 'app.local' },
          appliedFields: { enabled: true, server: true, override: true }
        }),
        'utf8'
      );

      await runRestoreScript(registryPath, statePath);

      expect(await queryRegistryValue(registryKey, 'ProxyEnable')).toMatch(/REG_DWORD\s+0x0/i);
      await expect(queryRegistryValue(registryKey, 'ProxyServer')).rejects.toBeDefined();
      await expect(queryRegistryValue(registryKey, 'ProxyOverride')).rejects.toBeDefined();
      await expect(access(statePath)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await runRegistry(['delete', registryKey, '/f']).catch(() => undefined);
      await rm(dir, { recursive: true, force: true });
    }
  });
});

async function runRegistry(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('reg.exe', args, { windowsHide: true });
  return String(stdout);
}

function queryRegistryValue(registryKey: string, valueName: string): Promise<string> {
  return runRegistry(['query', registryKey, '/v', valueName]);
}

async function runRestoreScript(registryPath: string, statePath: string): Promise<void> {
  await execFileAsync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'RemoteSigned',
      '-File',
      join(process.cwd(), 'build', 'restore-owned-proxy.ps1'),
      '-RegistryPath',
      registryPath,
      '-StatePath',
      statePath
    ],
    { windowsHide: true }
  );
}

function assertSafeRegistryTestKey(registryKey: string): void {
  if (!registryKey.startsWith('HKCU\\Software\\YouYu\\Tests\\ProxyRestore\\')) {
    throw new Error('refusing to use an unexpected registry test key');
  }
}
