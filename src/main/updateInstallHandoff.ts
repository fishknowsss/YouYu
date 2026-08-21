import { randomUUID } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import { join, win32 } from 'node:path';
import {
  normalizeWindowsUserSid,
  resolveCurrentWindowsUserIdentity,
  type WindowsUserIdentity
} from './platform/windowsUserIdentity';

export const updateInstallerHandoffDelayMs = 2000;
export const updateInstallerHandoffLifetimeMs = 14 * 60 * 1000;

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
  nonce: string;
  targetUserSid: string;
  targetSessionId: number;
  targetProcessId: number;
  targetExecutablePath: string;
  abandon: () => Promise<void>;
};

export function resolveUpdateInstallerHandoffAcknowledgementPath(
  options: Pick<UpdateInstallerHandoffLease, 'path' | 'nonce'>
): string {
  const handoffPath = win32.normalize(options.path.trim());
  if (!win32.isAbsolute(handoffPath) || handoffPath.includes('\0')) {
    throw new Error('invalid update handoff path');
  }
  const nonce = options.nonce.trim().toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(nonce)) {
    throw new Error('invalid update handoff nonce');
  }
  if (win32.basename(handoffPath).toLowerCase() !== 'youyu-update-handoff-' + nonce + '.json') {
    throw new Error('update handoff path does not match its nonce');
  }
  return win32.join(win32.dirname(handoffPath), 'youyu-update-handoff-' + nonce + '.ready.json');
}

export function resolveUpdateInstallerCancellationPath(
  options: Pick<UpdateInstallerHandoffLease, 'path' | 'nonce'>
): string {
  const handoffPath = win32.normalize(options.path.trim());
  if (!win32.isAbsolute(handoffPath) || handoffPath.includes('\0')) {
    throw new Error('invalid update handoff path');
  }
  const nonce = options.nonce.trim().toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(nonce)) {
    throw new Error('invalid update handoff nonce');
  }
  if (win32.basename(handoffPath).toLowerCase() !== 'youyu-update-handoff-' + nonce + '.json') {
    throw new Error('update handoff path does not match its nonce');
  }
  return win32.join(win32.dirname(handoffPath), 'youyu-update-cancel-' + nonce + '.json');
}

export function resolveWindowsUpdateHandoffDirectory(environment: NodeJS.ProcessEnv = process.env): string {
  const localAppData = environment.LOCALAPPDATA?.trim();
  if (!localAppData || localAppData.includes('\0') || !win32.isAbsolute(localAppData)) {
    throw new Error('Windows LocalAppData path is unavailable for the update handoff');
  }
  return win32.join(win32.normalize(localAppData), 'Temp');
}

export function createUpdateInstallerHandoffArguments(lease: UpdateInstallerHandoffLease): string[] {
  const path = win32.normalize(lease.path.trim());
  if (!win32.isAbsolute(path) || path.includes('\0')) {
    throw new Error('invalid update handoff path');
  }
  const nonce = lease.nonce.trim().toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(nonce)) {
    throw new Error('invalid update handoff nonce');
  }
  const targetUserSid = normalizeWindowsUserSid(lease.targetUserSid);
  if (!Number.isSafeInteger(lease.targetSessionId) || lease.targetSessionId <= 0) {
    throw new Error('invalid update handoff Windows session');
  }

  return [
    '--youyu-handoff-path',
    path,
    '--youyu-handoff-nonce',
    nonce,
    '--youyu-target-user-sid',
    targetUserSid,
    '--youyu-target-session-id',
    String(lease.targetSessionId)
  ];
}

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
  const environment = options.environment ?? process.env;
  const path = join(
    options.temporaryDirectory ?? resolveWindowsUpdateHandoffDirectory(environment),
    `youyu-update-handoff-${nonce}.json`
  );
  const acknowledgementPath = resolveUpdateInstallerHandoffAcknowledgementPath({ path, nonce });
  const cancellationPath = resolveUpdateInstallerCancellationPath({ path, nonce });
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
  let cancelExpiryCleanup: () => void = () => undefined;
  const abandon = async (): Promise<void> => {
    if (abandoned) return;
    abandoned = true;
    cancelExpiryCleanup();
    try {
      await Promise.all([
        rm(path, { force: true }),
        rm(acknowledgementPath, { force: true }),
        rm(cancellationPath, { force: true })
      ]);
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
  cancelExpiryCleanup = scheduleExpiryCleanup(async () => {
    try {
      await abandon();
    } finally {
      await rm(cancellationPath, { force: true });
    }
  }, updateInstallerHandoffLifetimeMs);

  return {
    path,
    nonce,
    targetUserSid,
    targetSessionId: identity.sessionId,
    targetProcessId: processId,
    targetExecutablePath: executablePath,
    abandon
  };
}

export function deferUpdateInstallerLaunch(options: {
  launch: (lease: UpdateInstallerHandoffLease) => Promise<void> | void;
  onError: (error: unknown) => void;
  defer?: (task: () => Promise<void>) => void;
  prepareHandoff?: () => Promise<UpdateInstallerHandoffLease | undefined>;
  isCurrent?: () => boolean;
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
      if (!lease) throw new Error('authenticated update handoff is unavailable');
      if (options.isCurrent && !options.isCurrent()) {
        await lease.abandon();
        return;
      }
      await options.launch(lease);
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
