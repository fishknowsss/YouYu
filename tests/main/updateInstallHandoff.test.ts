import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createUpdateInstallerHandoff,
  deferUpdateInstallerLaunch,
  updateInstallerHandoffDelayMs,
  updateInstallerHandoffEnvironment,
  updateInstallerHandoffLifetimeMs
} from '../../src/main/updateInstallHandoff';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('deferUpdateInstallerLaunch', () => {
  it('keeps the installing message visible before starting the installer', async () => {
    vi.useFakeTimers();
    const launch = vi.fn();

    deferUpdateInstallerLaunch({ launch, onError: vi.fn(), prepareHandoff: async () => undefined });

    await vi.advanceTimersByTimeAsync(updateInstallerHandoffDelayMs - 1);
    expect(launch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(launch).toHaveBeenCalledOnce();
  });

  it('supports an injected scheduler for deterministic handoff tests', async () => {
    const scheduled: Array<() => Promise<void>> = [];
    const launch = vi.fn();

    deferUpdateInstallerLaunch({
      launch,
      onError: vi.fn(),
      defer: (task) => scheduled.push(task),
      prepareHandoff: async () => undefined
    });

    expect(launch).not.toHaveBeenCalled();
    expect(scheduled).toHaveLength(1);
    await scheduled[0]();
    expect(launch).toHaveBeenCalledOnce();
  });

  it('abandons the authenticated handoff when starting the installer throws', async () => {
    const onError = vi.fn();
    const abandon = vi.fn(async () => undefined);
    const scheduled: Array<() => Promise<void>> = [];

    deferUpdateInstallerLaunch({
      launch: () => {
        throw new Error('spawn failed');
      },
      onError,
      defer: (task) => scheduled.push(task),
      prepareHandoff: async () => ({ path: String.raw`C:\Temp\youyu-update-handoff-test.json`, abandon })
    });

    await scheduled[0]();
    expect(abandon).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'spawn failed' }));
  });

  it('does not launch when the user-bound handoff cannot be prepared', async () => {
    const launch = vi.fn();
    const onError = vi.fn();
    const scheduled: Array<() => Promise<void>> = [];

    deferUpdateInstallerLaunch({
      launch,
      onError,
      defer: (task) => scheduled.push(task),
      prepareHandoff: async () => {
        throw new Error('identity unavailable');
      }
    });

    await scheduled[0]();
    expect(launch).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'identity unavailable' }));
  });

  it('contains an error callback failure inside the deferred installer task', async () => {
    const scheduled: Array<() => Promise<void>> = [];
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    deferUpdateInstallerLaunch({
      launch: vi.fn(),
      onError: () => {
        throw new Error('error callback failed');
      },
      defer: (task) => scheduled.push(task),
      prepareHandoff: async () => {
        throw new Error('identity unavailable');
      }
    });

    await expect(scheduled[0]()).resolves.toBeUndefined();
    expect(consoleError).toHaveBeenCalledWith('update installer error callback failed', expect.any(Error));
  });

  it('writes a short-lived SID/session-bound record and exports only explicit handoff values', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'youyu-update-handoff-test-'));
    const environment: NodeJS.ProcessEnv = {
      EXISTING: 'preserved',
      [updateInstallerHandoffEnvironment.path]: String.raw`C:\Temp\stale-handoff.json`,
      [updateInstallerHandoffEnvironment.nonce]: 'stale-nonce',
      [updateInstallerHandoffEnvironment.userSid]: 'S-1-5-21-100-200-300-9999',
      [updateInstallerHandoffEnvironment.sessionId]: '99'
    };
    try {
      const lease = await createUpdateInstallerHandoff({
        executablePath: String.raw`C:\Program Files\YouYu\YouYu.exe`,
        processId: 4242,
        temporaryDirectory: directory,
        environment,
        nonce: '8fb748f0-540a-4f7a-9bd2-144020b83e9b',
        now: () => 1_800_000_000_000,
        resolveUserIdentity: async () => ({ userSid: 'S-1-5-21-100-200-300-1001', sessionId: 7 })
      });

      const raw = await readFile(lease.path, 'utf8');
      expect(JSON.parse(raw)).toEqual({
        version: 1,
        nonce: '8fb748f0-540a-4f7a-9bd2-144020b83e9b',
        targetUserSid: 'S-1-5-21-100-200-300-1001',
        targetSessionId: 7,
        targetProcessId: 4242,
        executablePath: String.raw`C:\Program Files\YouYu\YouYu.exe`,
        createdAtEpochMs: 1_800_000_000_000,
        expiresAtEpochMs: 1_800_000_300_000
      });
      expect(environment).toMatchObject({
        EXISTING: 'preserved',
        [updateInstallerHandoffEnvironment.path]: lease.path,
        [updateInstallerHandoffEnvironment.nonce]: '8fb748f0-540a-4f7a-9bd2-144020b83e9b',
        [updateInstallerHandoffEnvironment.userSid]: 'S-1-5-21-100-200-300-1001',
        [updateInstallerHandoffEnvironment.sessionId]: '7'
      });

      await lease.abandon();
      await expect(readFile(lease.path, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      expect(environment[updateInstallerHandoffEnvironment.path]).toBeUndefined();
      expect(environment[updateInstallerHandoffEnvironment.nonce]).toBeUndefined();
      expect(environment[updateInstallerHandoffEnvironment.userSid]).toBeUndefined();
      expect(environment[updateInstallerHandoffEnvironment.sessionId]).toBeUndefined();
      expect(environment.EXISTING).toBe('preserved');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('never resurrects an older lease when overlapping handoffs expire out of order', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'youyu-overlapping-handoff-test-'));
    const environment: NodeJS.ProcessEnv = { EXISTING: 'preserved' };
    const createLease = (nonce: string) =>
      createUpdateInstallerHandoff({
        executablePath: String.raw`C:\Program Files\YouYu\YouYu.exe`,
        processId: 4242,
        temporaryDirectory: directory,
        environment,
        nonce,
        resolveUserIdentity: async () => ({ userSid: 'S-1-5-21-100-200-300-1001', sessionId: 7 })
      });

    try {
      const first = await createLease('8fb748f0-540a-4f7a-9bd2-144020b83e9b');
      const firstPath = first.path;
      const second = await createLease('cb5a0440-d3f7-4424-9595-b0f65b1c4bb8');
      const secondPath = second.path;

      expect(environment[updateInstallerHandoffEnvironment.path]).toBe(secondPath);
      await first.abandon();
      expect(environment[updateInstallerHandoffEnvironment.path]).toBe(secondPath);
      await second.abandon();

      for (const name of Object.values(updateInstallerHandoffEnvironment)) {
        expect(environment[name]).toBeUndefined();
      }
      expect(environment[updateInstallerHandoffEnvironment.path]).not.toBe(firstPath);
      expect(environment.EXISTING).toBe('preserved');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('expires and cleans an orphaned installer lease while the originating app remains alive', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'youyu-expiring-handoff-test-'));
    const environment: NodeJS.ProcessEnv = {};
    let expiryTask: (() => Promise<void>) | undefined;
    let expiryDelayMs = 0;
    try {
      const lease = await createUpdateInstallerHandoff({
        executablePath: String.raw`C:\Program Files\YouYu\YouYu.exe`,
        processId: 4242,
        temporaryDirectory: directory,
        environment,
        nonce: '8fb748f0-540a-4f7a-9bd2-144020b83e9b',
        resolveUserIdentity: async () => ({ userSid: 'S-1-5-21-100-200-300-1001', sessionId: 7 }),
        scheduleExpiryCleanup: (task, delayMs) => {
          expiryTask = task;
          expiryDelayMs = delayMs;
          return () => undefined;
        }
      });

      await expect(readFile(lease.path, 'utf8')).resolves.toContain('targetProcessId');
      expect(expiryDelayMs).toBe(updateInstallerHandoffLifetimeMs);
      await expiryTask?.();
      await expect(readFile(lease.path, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      expect(environment[updateInstallerHandoffEnvironment.path]).toBeUndefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([
    ['a service SID', { userSid: 'S-1-5-18', sessionId: 7 }],
    ['session zero', { userSid: 'S-1-5-21-100-200-300-1001', sessionId: 0 }]
  ])('fails closed before writing a handoff for %s', async (_reason, identity) => {
    const directory = await mkdtemp(join(tmpdir(), 'youyu-invalid-handoff-test-'));
    try {
      await expect(
        createUpdateInstallerHandoff({
          executablePath: String.raw`C:\Program Files\YouYu\YouYu.exe`,
          processId: 4242,
          temporaryDirectory: directory,
          nonce: '8fb748f0-540a-4f7a-9bd2-144020b83e9b',
          resolveUserIdentity: async () => identity
        })
      ).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
