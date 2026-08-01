import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { win32 } from 'node:path';
import {
  buildSidBoundStartupTaskName,
  resolveCurrentWindowsUserIdentity,
  type WindowsUserIdentity
} from './windowsUserIdentity';

const hiddenArgument = '--hidden';
const legacyTaskName = 'YouYu';

export type StartupTaskState = 'missing' | 'current' | 'stale';

export type StartupTaskRunResult =
  | { status: 'success'; stdout: string | Uint8Array }
  | { status: 'missing'; stdout: string | Uint8Array }
  | { status: 'failed'; stdout: string | Uint8Array };

export type StartupTaskRunner = (args: readonly string[]) => Promise<StartupTaskRunResult>;

export function createWindowsStartupTask(options: {
  executablePath: string;
  runner?: StartupTaskRunner;
  resolveUserIdentity?: () => Promise<WindowsUserIdentity>;
}) {
  const runner = options.runner ?? runSchtasks;
  const resolveUserIdentity = options.resolveUserIdentity ?? resolveCurrentWindowsUserIdentity;
  let contextPromise: Promise<{ taskName: string; userSid: string }> | undefined;
  let state: StartupTaskState | 'unknown' = 'unknown';
  let legacyState: 'unknown' | 'missing' | 'managed' | 'foreign' = 'unknown';
  let disableFailed = false;

  function getContext(): Promise<{ taskName: string; userSid: string }> {
    contextPromise ??= resolveUserIdentity().then((identity) => ({
      taskName: buildSidBoundStartupTaskName(identity.userSid),
      userSid: identity.userSid
    }));
    return contextPromise;
  }

  async function inspect(): Promise<StartupTaskState> {
    const context = await getContext();
    const { taskName } = context;
    const result = await runner(['/Query', '/TN', taskName, '/XML']);
    if (result.status === 'missing') {
      state = 'missing';
      return state;
    }
    if (result.status === 'failed') {
      state = 'unknown';
      throw new Error('无法读取 Windows 计划任务');
    }

    const xml = decodeSchtasksOutput(result.stdout);
    if (!isTaskBoundToUser(xml, context.userSid)) {
      state = 'unknown';
      throw new Error('Windows 计划任务不属于当前用户，已停止修改');
    }

    state = isCurrentTask(xml, options.executablePath, context.userSid) ? 'current' : 'stale';
    return state;
  }

  async function create(): Promise<void> {
    const { taskName } = await getContext();
    const result = await runner([
      '/Create',
      '/TN',
      taskName,
      '/SC',
      'ONLOGON',
      '/TR',
      `"${options.executablePath}" ${hiddenArgument}`,
      '/RL',
      'LIMITED',
      '/F'
    ]);
    if (result.status !== 'success') throw new Error('无法写入 Windows 计划任务');
    state = 'current';
  }

  async function inspectLegacy(): Promise<typeof legacyState> {
    if (legacyState !== 'unknown') return legacyState;
    const context = await getContext();
    const result = await runner(['/Query', '/TN', legacyTaskName, '/XML']);
    if (result.status === 'missing') {
      legacyState = 'missing';
      return legacyState;
    }
    if (result.status === 'failed') throw new Error('无法读取旧版 Windows 计划任务');

    legacyState = isStrictlyManagedLegacyTask(
      decodeSchtasksOutput(result.stdout),
      options.executablePath,
      context.userSid
    )
      ? 'managed'
      : 'foreign';
    return legacyState;
  }

  async function deleteLegacy(): Promise<void> {
    const result = await runner(['/Delete', '/TN', legacyTaskName, '/F']);
    if (result.status === 'failed') throw new Error('无法删除旧版 Windows 计划任务');
    legacyState = 'missing';
  }

  return {
    isEnabled(): boolean {
      return disableFailed || state === 'current' || state === 'stale' || legacyState === 'managed';
    },

    async reconcile(legacyEnabled: boolean): Promise<StartupTaskState> {
      const detected = await inspect();
      if (detected === 'stale') {
        await create();
      }

      const legacy = await inspectLegacy();
      if (detected === 'missing' && (legacy === 'managed' || legacyEnabled)) {
        await create();
      }
      if (legacy === 'managed') await deleteLegacy();
      disableFailed = false;
      return detected;
    },

    async setEnabled(enabled: boolean): Promise<void> {
      if (enabled) {
        await create();
        disableFailed = false;
        return;
      }

      try {
        if (state === 'unknown') await inspect();
        if ((await inspectLegacy()) === 'managed') await deleteLegacy();
        if (state !== 'missing') {
          const { taskName } = await getContext();
          const result = await runner(['/Delete', '/TN', taskName, '/F']);
          if (result.status === 'failed') throw new Error('无法删除 Windows 计划任务');
          state = 'missing';
        }
        disableFailed = false;
      } catch (error) {
        disableFailed = true;
        throw error;
      }
    }
  };
}

function isCurrentTask(xml: string, executablePath: string, expectedUserSid: string): boolean {
  const actions = readXmlRawElement(xml, 'Actions');
  const execAction = actions === undefined ? undefined : readXmlRawElement(actions, 'Exec');
  const principals = readXmlRawElement(xml, 'Principals');
  const principal = principals === undefined ? undefined : readXmlRawElement(principals, 'Principal');
  const settings = readXmlRawElement(xml, 'Settings');
  const triggers = readXmlRawElement(xml, 'Triggers');
  const logonTrigger = triggers === undefined ? undefined : readXmlRawElement(triggers, 'LogonTrigger');
  const command = execAction === undefined ? undefined : readXmlElement(execAction, 'Command');
  const argumentsValue = execAction === undefined ? undefined : readXmlElement(execAction, 'Arguments');
  const userId = principal === undefined ? undefined : readXmlElement(principal, 'UserId');
  const groupId = principal === undefined ? undefined : readXmlElement(principal, 'GroupId');
  const logonType = principal === undefined ? undefined : readXmlElement(principal, 'LogonType');
  const requiredPrivileges = principal === undefined ? undefined : readXmlRawElement(principal, 'RequiredPrivileges');
  const runLevel = principal === undefined ? undefined : readXmlElement(principal, 'RunLevel');
  const taskEnabled = settings === undefined ? undefined : readXmlElement(settings, 'Enabled');
  const triggerEnabled = logonTrigger === undefined ? undefined : readXmlElement(logonTrigger, 'Enabled');
  if (
    actions === undefined ||
    command === undefined ||
    argumentsValue === undefined ||
    userId === undefined ||
    logonType === undefined ||
    principals === undefined ||
    principal === undefined ||
    triggers === undefined ||
    logonTrigger === undefined
  ) {
    return false;
  }

  return (
    normalizeWindowsCommand(command) === normalizeWindowsCommand(executablePath) &&
    argumentsValue.trim() === hiddenArgument &&
    isInteractiveUserPrincipal(userId, logonType, expectedUserSid) &&
    groupId === undefined &&
    requiredPrivileges === undefined &&
    (runLevel === undefined || runLevel.trim().toLowerCase() === 'leastprivilege') &&
    (taskEnabled === undefined || taskEnabled.trim().toLowerCase() === 'true') &&
    (triggerEnabled === undefined || triggerEnabled.trim().toLowerCase() === 'true') &&
    hasOnlyExpectedExecAction(actions) &&
    hasOnlyExpectedTrigger(triggers)
  );
}

function isTaskBoundToUser(xml: string, expectedUserSid: string): boolean {
  const principals = readXmlRawElement(xml, 'Principals');
  if (principals === undefined || countXmlElements(principals, 'Principal') !== 1) return false;
  const principal = readXmlRawElement(principals, 'Principal');
  if (
    principal === undefined ||
    countXmlElements(principal, 'UserId') !== 1 ||
    countXmlElements(principal, 'GroupId') !== 0
  ) {
    return false;
  }
  const userId = readXmlElement(principal, 'UserId');
  return userId?.trim().toUpperCase() === expectedUserSid.trim().toUpperCase();
}

function isStrictlyManagedLegacyTask(xml: string, executablePath: string, expectedUserSid: string): boolean {
  if (!isTaskBoundToUser(xml, expectedUserSid)) return false;
  const actions = readXmlRawElement(xml, 'Actions');
  const execAction = actions === undefined ? undefined : readXmlRawElement(actions, 'Exec');
  const principals = readXmlRawElement(xml, 'Principals');
  const principal = principals === undefined ? undefined : readXmlRawElement(principals, 'Principal');
  const settings = readXmlRawElement(xml, 'Settings');
  const triggers = readXmlRawElement(xml, 'Triggers');
  const logonTrigger = triggers === undefined ? undefined : readXmlRawElement(triggers, 'LogonTrigger');
  const command = execAction === undefined ? undefined : readXmlElement(execAction, 'Command');
  const argumentsValue = execAction === undefined ? undefined : readXmlElement(execAction, 'Arguments');
  const logonType = principal === undefined ? undefined : readXmlElement(principal, 'LogonType');
  const requiredPrivileges = principal === undefined ? undefined : readXmlRawElement(principal, 'RequiredPrivileges');
  const runLevel = principal === undefined ? undefined : readXmlElement(principal, 'RunLevel');
  const taskEnabled = settings === undefined ? undefined : readXmlElement(settings, 'Enabled');
  const triggerEnabled = logonTrigger === undefined ? undefined : readXmlElement(logonTrigger, 'Enabled');
  if (
    actions === undefined ||
    command === undefined ||
    argumentsValue === undefined ||
    logonType === undefined ||
    triggers === undefined ||
    logonTrigger === undefined
  ) {
    return false;
  }

  return (
    normalizeWindowsCommand(command) === normalizeWindowsCommand(executablePath) &&
    argumentsValue.trim() === hiddenArgument &&
    logonType.trim().toLowerCase() === 'interactivetoken' &&
    requiredPrivileges === undefined &&
    (runLevel === undefined || runLevel.trim().toLowerCase() === 'leastprivilege') &&
    (taskEnabled === undefined || taskEnabled.trim().toLowerCase() === 'true') &&
    (triggerEnabled === undefined || triggerEnabled.trim().toLowerCase() === 'true') &&
    hasOnlyExpectedExecAction(actions) &&
    hasOnlyExpectedTrigger(triggers)
  );
}

function isInteractiveUserPrincipal(userId: string, logonType: string, expectedUserSid: string): boolean {
  const normalizedUserId = userId.trim().toLowerCase();
  if (!normalizedUserId || logonType.trim().toLowerCase() !== 'interactivetoken') return false;

  return (
    normalizedUserId === expectedUserSid.trim().toLowerCase() &&
    !['s-1-5-18', 's-1-5-19', 's-1-5-20'].includes(normalizedUserId) &&
    !normalizedUserId.startsWith('s-1-5-80-') &&
    !(normalizedUserId.startsWith('s-') && normalizedUserId.endsWith('-500')) &&
    !normalizedUserId.endsWith('\\system') &&
    normalizedUserId !== 'system'
  );
}

function readXmlElement(xml: string, name: string): string | undefined {
  const raw = readXmlRawElement(xml, name);
  return raw === undefined ? undefined : decodeXmlText(raw);
}

function readXmlRawElement(xml: string, name: string): string | undefined {
  const match = new RegExp(`<(?:[\\w.-]+:)?${name}\\b[^>]*>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?${name}>`, 'i').exec(xml);
  if (match) return match[1].trim();
  const selfClosing = new RegExp(`<(?:[\\w.-]+:)?${name}\\b[^>]*/>`, 'i').test(xml);
  return selfClosing ? '' : undefined;
}

function countXmlElements(xml: string, name: string): number {
  return [...xml.matchAll(new RegExp(`<(?:[\\w.-]+:)?${name}\\b[^>]*>`, 'gi'))].length;
}

function hasOnlyExpectedTrigger(triggers: string): boolean {
  const names = [...triggers.matchAll(/<(?:[\w.-]+:)?([\w.-]*Trigger)\b[^>]*>/gi)].map((match) =>
    match[1].toLowerCase()
  );
  return names.length === 1 && names[0] === 'logontrigger';
}

function hasOnlyExpectedExecAction(actions: string): boolean {
  const names = [...actions.matchAll(/<(?:[\w.-]+:)?(Exec|ComHandler|SendEmail|ShowMessage)\b[^>]*>/gi)].map((match) =>
    match[1].toLowerCase()
  );
  return names.length === 1 && names[0] === 'exec';
}

function decodeXmlText(value: string): string {
  return value.replace(/&#x([\da-f]+);|&#(\d+);|&(lt|gt|quot|apos|amp);/gi, (entity, hex, decimal, named) => {
    if (hex) return String.fromCodePoint(Number.parseInt(hex, 16));
    if (decimal) return String.fromCodePoint(Number.parseInt(decimal, 10));
    return {
      lt: '<',
      gt: '>',
      quot: '"',
      apos: "'",
      amp: '&'
    }[String(named).toLowerCase()]!;
  });
}

function normalizeWindowsCommand(value: string): string {
  const trimmed = value.trim();
  const unquoted = trimmed.startsWith('"') && trimmed.endsWith('"') ? trimmed.slice(1, -1).trim() : trimmed;
  return win32.normalize(unquoted).toLowerCase();
}

function decodeSchtasksOutput(value: string | Uint8Array): string {
  if (typeof value === 'string') return value;

  const output = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  const hasUtf16LeBom = output.length >= 2 && output[0] === 0xff && output[1] === 0xfe;
  const sampleLength = Math.min(output.length, 256);
  let oddNullBytes = 0;
  for (let index = 1; index < sampleLength; index += 2) {
    if (output[index] === 0) oddNullBytes += 1;
  }

  if (hasUtf16LeBom || oddNullBytes >= Math.max(2, Math.floor(sampleLength / 8))) {
    return output.subarray(hasUtf16LeBom ? 2 : 0).toString('utf16le');
  }
  return output.toString('utf8').replace(/^\uFEFF/, '');
}

function runSchtasks(args: readonly string[]): Promise<StartupTaskRunResult> {
  return new Promise((resolve) => {
    execFile('schtasks.exe', [...args], { encoding: null, windowsHide: true, timeout: 5000 }, async (error, stdout) => {
      if (!error) {
        resolve({ status: 'success', stdout });
        return;
      }

      resolve({
        status: (await scheduledTaskFileIsMissing(args)) ? 'missing' : 'failed',
        stdout
      });
    });
  });
}

async function scheduledTaskFileIsMissing(args: readonly string[]): Promise<boolean> {
  const taskNameIndex = args.findIndex((arg) => arg.toUpperCase() === '/TN');
  const taskName = taskNameIndex >= 0 ? args[taskNameIndex + 1] : undefined;
  const segments = taskName?.split(/[\\/]+/).filter(Boolean) ?? [];
  if (segments.length === 0 || segments.some((segment) => segment === '.' || segment === '..')) return false;

  const taskPath = win32.join(process.env.SystemRoot ?? String.raw`C:\Windows`, 'System32', 'Tasks', ...segments);
  try {
    await stat(taskPath);
    return false;
  } catch (error) {
    return isNodeError(error) && error.code === 'ENOENT';
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
