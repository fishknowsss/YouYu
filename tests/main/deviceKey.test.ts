import { describe, expect, it, vi } from 'vitest';
import { createWindowsDeviceKeyProvider } from '../../src/main/platform/deviceKey';

const existingDeviceKey = '11111111-1111-4111-8111-111111111111';
const generatedDeviceKey = '22222222-2222-4222-8222-222222222222';

describe('createWindowsDeviceKeyProvider', () => {
  it('reuses an existing current-user device key', async () => {
    const runCommand = vi.fn(async () => `DeviceKey    REG_SZ    ${existingDeviceKey}`);
    const randomUUID = vi.fn(() => generatedDeviceKey);
    const provider = createWindowsDeviceKeyProvider({ platform: 'win32', runCommand, randomUUID });

    await expect(provider.getDeviceKey()).resolves.toBe(existingDeviceKey);
    await expect(provider.getDeviceKey()).resolves.toBe(existingDeviceKey);

    expect(randomUUID).not.toHaveBeenCalled();
    expect(runCommand).toHaveBeenCalledTimes(1);
  });

  it('creates one random key and reuses the persisted registry value', async () => {
    let registryKeyExists = false;
    let storedDeviceKey: string | undefined;
    const runCommand = vi.fn(async (command: { file: string; args: string[] }) => {
      const valueIndex = command.args.indexOf('/v');
      const isValueCommand = valueIndex >= 0 && command.args[valueIndex + 1] === 'DeviceKey';
      if (command.args[0] === 'query' && !isValueCommand) {
        if (!registryKeyExists) throw new Error('registry key not found');
        return 'registry key exists';
      }
      if (command.args[0] === 'query' && isValueCommand) {
        if (!storedDeviceKey) throw new Error('registry value not found');
        return `DeviceKey    REG_SZ    ${storedDeviceKey}`;
      }
      if (command.args[0] === 'add' && !isValueCommand) {
        registryKeyExists = true;
        return '';
      }
      if (command.args[0] === 'add' && isValueCommand) {
        registryKeyExists = true;
        storedDeviceKey = command.args[command.args.indexOf('/d') + 1];
        return '';
      }
      throw new Error('unexpected registry command');
    });
    const randomUUID = vi.fn(() => generatedDeviceKey);
    const provider = createWindowsDeviceKeyProvider({ platform: 'win32', runCommand, randomUUID });

    await expect(provider.getDeviceKey()).resolves.toBe(generatedDeviceKey);
    await expect(provider.getDeviceKey()).resolves.toBe(generatedDeviceKey);

    expect(storedDeviceKey).toBe(generatedDeviceKey);
    expect(randomUUID).toHaveBeenCalledTimes(1);
  });

  it('returns no device key when current-user registry access is unavailable', async () => {
    const provider = createWindowsDeviceKeyProvider({
      platform: 'win32',
      runCommand: async () => Promise.reject(new Error('registry unavailable')),
      randomUUID: () => generatedDeviceKey
    });

    await expect(provider.getDeviceKey()).resolves.toBeUndefined();
  });

  it('does not access the Windows registry on other platforms', async () => {
    const runCommand = vi.fn();
    const provider = createWindowsDeviceKeyProvider({ platform: 'darwin', runCommand });

    await expect(provider.getDeviceKey()).resolves.toBeUndefined();
    expect(runCommand).not.toHaveBeenCalled();
  });
});
