import { open as openFile } from 'node:fs/promises';
import { win32 } from 'node:path';
import { normalizeWindowsUserSid, resolveCurrentWindowsUserIdentity } from './platform/windowsUserIdentity';
import { resolveWindowsUpdateHandoffDirectory } from './updateInstallHandoff';

export const updateRelaunchAcknowledgementPathArgument = '--youyu-update-relaunch-path';
export const updateRelaunchAcknowledgementNonceArgument = '--youyu-update-relaunch-nonce';

export type UpdateRelaunchAcknowledgementRequest = {
  path: string;
  nonce: string;
};

type WriteUpdateRelaunchAcknowledgementOptions = {
  appVersion: string;
  executablePath?: string;
  processId?: number;
  environment?: NodeJS.ProcessEnv;
  now?: () => number;
  resolveUserIdentity?: typeof resolveCurrentWindowsUserIdentity;
  writeFile?: (path: string, contents: string, options: { encoding: 'utf8'; flag: 'r+' }) => Promise<void>;
};

const noncePattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function resolveUpdateRelaunchAcknowledgementRequest(
  args: readonly string[],
  environment: NodeJS.ProcessEnv = process.env
): UpdateRelaunchAcknowledgementRequest | undefined {
  let path: string | undefined;
  let nonce: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (
      argument !== updateRelaunchAcknowledgementPathArgument &&
      argument !== updateRelaunchAcknowledgementNonceArgument
    ) {
      continue;
    }
    const value = args[index + 1];
    if (!value) return undefined;
    if (argument === updateRelaunchAcknowledgementPathArgument) {
      if (path !== undefined) return undefined;
      path = value;
    } else {
      if (nonce !== undefined) return undefined;
      nonce = value;
    }
    index += 1;
  }

  if (path === undefined && nonce === undefined) return undefined;
  if (path === undefined || nonce === undefined) return undefined;
  return validateRequest(path, nonce, environment);
}

export function stripUpdateRelaunchAcknowledgementArguments(args: readonly string[]): string[] {
  const retained: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (
      argument === updateRelaunchAcknowledgementPathArgument ||
      argument === updateRelaunchAcknowledgementNonceArgument
    ) {
      index += 1;
      continue;
    }
    retained.push(argument);
  }
  return retained;
}

export async function writeUpdateRelaunchAcknowledgement(
  request: UpdateRelaunchAcknowledgementRequest,
  options: WriteUpdateRelaunchAcknowledgementOptions
): Promise<void> {
  const validated = validateRequest(request.path, request.nonce, options.environment ?? process.env);
  if (!validated) throw new Error('invalid update relaunch acknowledgement request');

  const appVersion = options.appVersion.trim();
  if (!/^\d+\.\d+\.\d+$/.test(appVersion)) throw new Error('invalid update relaunch app version');
  const executablePath = win32.normalize(options.executablePath ?? process.execPath);
  if (!win32.isAbsolute(executablePath) || executablePath.includes('\0') || win32.extname(executablePath) !== '.exe') {
    throw new Error('invalid update relaunch executable path');
  }
  const processId = options.processId ?? process.pid;
  if (!Number.isSafeInteger(processId) || processId <= 0) throw new Error('invalid update relaunch process id');
  const readyAtEpochMs = options.now?.() ?? Date.now();
  if (!Number.isSafeInteger(readyAtEpochMs) || readyAtEpochMs <= 0) {
    throw new Error('invalid update relaunch acknowledgement time');
  }
  const identity = await (options.resolveUserIdentity ?? resolveCurrentWindowsUserIdentity)();
  const targetUserSid = normalizeWindowsUserSid(identity.userSid);
  if (!Number.isSafeInteger(identity.sessionId) || identity.sessionId <= 0) {
    throw new Error('invalid update relaunch Windows session');
  }
  const contents =
    JSON.stringify({
      version: 1,
      nonce: validated.nonce,
      appVersion,
      executablePath,
      processId,
      targetUserSid,
      targetSessionId: identity.sessionId,
      readyAtEpochMs
    }) + '\n';
  const write =
    options.writeFile ??
    (async (path: string, value: string) => {
      const handle = await openFile(path, 'r+');
      try {
        await handle.truncate(0);
        await handle.writeFile(value, { encoding: 'utf8' });
        await handle.sync();
      } finally {
        await handle.close();
      }
    });
  await write(validated.path, contents, { encoding: 'utf8', flag: 'r+' });
}

function validateRequest(
  pathValue: string,
  nonceValue: string,
  environment: NodeJS.ProcessEnv
): UpdateRelaunchAcknowledgementRequest | undefined {
  const nonce = nonceValue.trim().toLowerCase();
  if (!noncePattern.test(nonce)) return undefined;
  const path = win32.normalize(pathValue.trim());
  if (!path || path.includes('\0') || !win32.isAbsolute(path)) return undefined;

  let expectedDirectory: string;
  try {
    expectedDirectory = resolveWindowsUpdateHandoffDirectory(environment);
  } catch {
    return undefined;
  }
  if (win32.dirname(path).toLowerCase() !== win32.normalize(expectedDirectory).toLowerCase()) return undefined;
  if (win32.basename(path).toLowerCase() !== `youyu-update-relaunch-${nonce}.ready.json`) return undefined;
  return { path, nonce };
}
