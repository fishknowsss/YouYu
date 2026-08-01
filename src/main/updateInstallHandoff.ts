import { randomUUID } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import {
  normalizeWindowsUserSid,
  resolveCurrentWindowsUserIdentity,
  type WindowsUserIdentity
} from './platform/windowsUserIdentity';

export const updateInstallerHandoffDelayMs = 2000;
export const updateInstallerHandoffLifetimeMs = 5 * 60 * 1000;

export const updateInstallerHandoffEnvironment = {
  path: 'YOUYU_UPDATE_HANDOFF_PATH',
  nonce: 'YOUYU_UPDATE_HANDOFF_NONCE',
  userSid: 'YOUYU_UPDATE_TARGET_USER_SID',
  sessionId: 'YOUYU_UPDATE_TARGET_SESSION_ID'
} as const;

export type UpdateInstallerHandoffRecord = {
  version: 1;
  nonce: string;
  targetUserSid: string;
  targetSessionId: number;
  targetProcessId: number;
  executablePath: string;
  createdAtEpochMs: number;
  expiresAtEpochMs: number;
};

export type UpdateInstallerHandoffLease = {
  path: string;
  abandon: () => Promise<void>;
};

export async function createUpdateInstallerHandoff(
  options: {
    executablePath?: string;
    processId?: number;
    temporaryDirectory?: string;
    environment?: NodeJS.ProcessEnv;
    nonce?: string;
    now?: () => number;
    resolveUserIdentity?: () => Promise<WindowsUserIdentity>;
    scheduleExpiryCleanup?: (task: () => Promise<void>, delayMs: number) => () => void;
  } = {}
): Promise<UpdateInstallerHandoffLease> {
  const processId = options.processId ?? process.pid;
  if (!Number.isSafeInteger(processId) || processId <= 0) throw new Error('invalid update handoff process id');

  const executablePath = win32.normalize(options.executablePath ?? process.execPath);
  if (!win32.isAbsolute(executablePath)) throw new Error('update handoff executable path must be absolute');

  const nonce = (options.nonce ?? randomUUID()).toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(nonce)) {
    throw new Error('invalid update handoff nonce');
  }

  const now = options.now?.() ?? Date.now();
  if (!Number.isSafeInteger(now) || now <= 0) throw new Error('invalid update handoff timestamp');
  const identity = await (options.resolveUserIdentity ?? resolveCurrentWindowsUserIdentity)();
  const targetUserSid = normalizeWindowsUserSid(identity.userSid);
  if (!Number.isSafeInteger(identity.sessionId) || identity.sessionId <= 0) {
    throw new Error('invalid update handoff Windows session');
  }
  const record: UpdateInstallerHandoffRecord = {
    version: 1,
    nonce,
    targetUserSid,
    targetSessionId: identity.sessionId,
    targetProcessId: processId,
    executablePath,
    createdAtEpochMs: now,
    expiresAtEpochMs: now + updateInstallerHandoffLifetimeMs
  };
  const path = join(options.temporaryDirectory ?? tmpdir(), `youyu-update-handoff-${nonce}.json`);
  const environment = options.environment ?? process.env;
  const assignedEnvironment: Record<string, string> = {
    [updateInstallerHandoffEnvironment.path]: path,
    [updateInstallerHandoffEnvironment.nonce]: nonce,
    [updateInstallerHandoffEnvironment.userSid]: targetUserSid,
    [updateInstallerHandoffEnvironment.sessionId]: String(identity.sessionId)
  };

  for (const name of Object.keys(assignedEnvironment)) delete environment[name];
  await writeFile(path, `${JSON.stringify(record)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  for (const [name, value] of Object.entries(assignedEnvironment)) environment[name] = value;

  let abandoned = false;
  let cancelExpiryCleanup: (() => void) | undefined;
  const abandon = async (): Promise<void> => {
    if (abandoned) return;
    abandoned = true;
    cancelExpiryCleanup?.();
    cancelExpiryCleanup = undefined;
    try {
      await rm(path, { force: true });
    } finally {
      for (const [name, assignedValue] of Object.entries(assignedEnvironment)) {
        if (environment[name] !== assignedValue) continue;
        delete environment[name];
      }
    }
  };
  const scheduleExpiryCleanup =
    options.scheduleExpiryCleanup ??
    ((task: () => Promise<void>, delayMs: number) => {
      const timer = setTimeout(() => void task().catch(() => undefined), delayMs);
      timer.unref();
      return () => clearTimeout(timer);
    });
  cancelExpiryCleanup = scheduleExpiryCleanup(abandon, updateInstallerHandoffLifetimeMs);

  return {
    path,
    abandon
  };
}

export function deferUpdateInstallerLaunch(options: {
  launch: () => void;
  onError: (error: unknown) => void;
  defer?: (task: () => Promise<void>) => void;
  prepareHandoff?: () => Promise<UpdateInstallerHandoffLease | undefined>;
}): void {
  const reportError = (error: unknown): void => {
    try {
      options.onError(error);
    } catch (callbackError) {
      try {
        console.error('update installer error callback failed', callbackError);
      } catch {
        // The deferred installer task must never create an unhandled rejection.
      }
    }
  };
  const defer =
    options.defer ??
    ((task: () => Promise<void>) => {
      setTimeout(() => void task().catch(reportError), updateInstallerHandoffDelayMs);
    });
  const prepareHandoff = options.prepareHandoff ?? createUpdateInstallerHandoff;

  defer(async () => {
    let lease: UpdateInstallerHandoffLease | undefined;
    try {
      lease = await prepareHandoff();
      options.launch();
    } catch (error) {
      try {
        await lease?.abandon();
      } catch (cleanupError) {
        reportError(new AggregateError([error, cleanupError], 'update installer handoff cleanup failed'));
        return;
      }
      reportError(error);
    }
  });
}
