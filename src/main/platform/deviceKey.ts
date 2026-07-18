import { execFile } from 'node:child_process';
import { randomUUID as createRandomUUID } from 'node:crypto';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const deviceRegistryKey = 'HKCU\\Software\\118 Studio\\YouYu';
const deviceRegistryValue = 'DeviceKey';

export type DeviceKeyCommand = {
  file: string;
  args: string[];
};

export type WindowsDeviceKeyProviderOptions = {
  platform?: NodeJS.Platform;
  runCommand?: (command: DeviceKeyCommand) => Promise<string>;
  randomUUID?: () => string;
};

export type DeviceKeyProvider = {
  getDeviceKey: () => Promise<string | undefined>;
};

async function defaultRunCommand(command: DeviceKeyCommand): Promise<string> {
  const { stdout } = await execFileAsync(command.file, command.args, { windowsHide: true, timeout: 3000 });
  return stdout;
}

export function createWindowsDeviceKeyProvider(options: WindowsDeviceKeyProviderOptions = {}): DeviceKeyProvider {
  const platform = options.platform ?? process.platform;
  const runCommand = options.runCommand ?? defaultRunCommand;
  const randomUUID = options.randomUUID ?? createRandomUUID;
  let resolvedDeviceKey: string | undefined;
  let pending: Promise<string | undefined> | undefined;

  async function loadOrCreateDeviceKey(): Promise<string | undefined> {
    if (platform !== 'win32') return undefined;

    const existing = parseDeviceKey(await queryDeviceKey().catch(() => ''));
    if (existing) return existing;

    try {
      await ensureRegistryKey();
    } catch {
      return undefined;
    }

    const recovered = parseDeviceKey(await queryDeviceKey().catch(() => ''));
    if (recovered) return recovered;

    const candidate = normalizeDeviceKey(randomUUID());
    if (!candidate) return undefined;

    try {
      await reg(['add', deviceRegistryKey, '/v', deviceRegistryValue, '/t', 'REG_SZ', '/d', candidate, '/f']);
      return parseDeviceKey(await queryDeviceKey());
    } catch {
      return undefined;
    }
  }

  async function ensureRegistryKey(): Promise<void> {
    try {
      await reg(['query', deviceRegistryKey]);
    } catch {
      await reg(['add', deviceRegistryKey, '/f']);
      await reg(['query', deviceRegistryKey]);
    }
  }

  function queryDeviceKey(): Promise<string> {
    return reg(['query', deviceRegistryKey, '/v', deviceRegistryValue]);
  }

  function reg(args: string[]): Promise<string> {
    return runCommand({ file: 'reg.exe', args });
  }

  return {
    async getDeviceKey() {
      if (resolvedDeviceKey) return resolvedDeviceKey;
      pending ??= loadOrCreateDeviceKey();
      const result = await pending;
      if (result) resolvedDeviceKey = result;
      else pending = undefined;
      return result;
    }
  };
}

function parseDeviceKey(output: string): string | undefined {
  const escapedName = deviceRegistryValue.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const value = output.match(new RegExp(`${escapedName}\\s+REG_SZ\\s+([^\\r\\n]+)`, 'i'))?.[1]?.trim();
  return normalizeDeviceKey(value);
}

function normalizeDeviceKey(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(normalized)
    ? normalized
    : undefined;
}
