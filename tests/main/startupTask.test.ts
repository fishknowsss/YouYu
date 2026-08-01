import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import {
  createWindowsStartupTask,
  type StartupTaskRunResult,
  type StartupTaskRunner
} from '../../src/main/platform/startupTask';

const executablePath = String.raw`C:\Program Files\You & Yu\YouYu.exe`;
const interactiveUserSid = 'S-1-5-21-1000-1000-1000-1001';
const sidBoundTaskName = 'YouYu-Startup-S-1-5-21-1000-1000-1000-1001';

function taskXml(
  command: string,
  args: string,
  runLevel = 'LeastPrivilege',
  options: {
    taskEnabled?: boolean;
    omitSettings?: boolean;
    omitTaskEnabled?: boolean;
    omitRunLevel?: boolean;
    principalUserId?: string;
    groupId?: string;
    logonType?: string;
    requiredPrivileges?: boolean;
    triggerName?: 'LogonTrigger' | 'TimeTrigger';
    triggerEnabled?: boolean;
    additionalAction?: boolean;
    additionalPrincipal?: boolean;
    duplicateUserId?: boolean;
  } = {}
): string {
  const triggerName = options.triggerName ?? 'LogonTrigger';
  const triggerEnabled =
    options.triggerEnabled === undefined ? '' : `<Enabled>${options.triggerEnabled ? 'true' : 'false'}</Enabled>`;
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers>
    <${triggerName}>${triggerEnabled}</${triggerName}>
  </Triggers>
  <Principals>
    <Principal>
      ${options.groupId ? `<GroupId>${options.groupId}</GroupId>` : `<UserId>${options.principalUserId ?? interactiveUserSid}</UserId>`}
      ${options.duplicateUserId ? `<UserId>${interactiveUserSid}</UserId>` : ''}
      <LogonType>${options.logonType ?? 'InteractiveToken'}</LogonType>
      ${options.omitRunLevel ? '' : `<RunLevel>${runLevel}</RunLevel>`}
      ${options.requiredPrivileges ? '<RequiredPrivileges><Privilege>SeDebugPrivilege</Privilege></RequiredPrivileges>' : ''}
    </Principal>
    ${
      options.additionalPrincipal
        ? '<Principal><UserId>S-1-5-21-900-800-700-1002</UserId><LogonType>InteractiveToken</LogonType></Principal>'
        : ''
    }
  </Principals>
  <Actions Context="Author">
    <Exec>
      <Command>${command}</Command>
      <Arguments>${args}</Arguments>
    </Exec>
    ${options.additionalAction ? '<Exec><Command>C:\\Other.exe</Command><Arguments></Arguments></Exec>' : ''}
  </Actions>
  ${
    options.omitSettings
      ? ''
      : `<Settings>
    ${options.omitTaskEnabled ? '' : `<Enabled>${options.taskEnabled === false ? 'false' : 'true'}</Enabled>`}
  </Settings>`
  }
</Task>`;
}

function runnerSequence(...results: StartupTaskRunResult[]): StartupTaskRunner {
  return vi.fn(async () => {
    const result = results.shift();
    if (!result) throw new Error('unexpected schtasks invocation');
    return result;
  });
}

function successful(stdout: string | Uint8Array = ''): StartupTaskRunResult {
  return { status: 'success', stdout };
}

function missing(stdout: string | Uint8Array = ''): StartupTaskRunResult {
  return { status: 'missing', stdout };
}

function failed(stdout: string | Uint8Array = ''): StartupTaskRunResult {
  return { status: 'failed', stdout };
}

function createTestTask(runner: StartupTaskRunner) {
  return createWindowsStartupTask({
    executablePath,
    runner,
    resolveUserIdentity: async () => ({ userSid: interactiveUserSid, sessionId: 7 })
  });
}

describe('Windows startup task', () => {
  it('reconciles startup state before the tray reads the cached value', async () => {
    const source = await readFile('src/main/index.ts', 'utf8');
    const initialization = source.slice(source.indexOf('.whenReady()'));
    const reconcile = initialization.indexOf('await reconcileLaunchAtLogin();');
    const createTray = initialization.indexOf('createTray();');

    expect(reconcile).toBeGreaterThan(-1);
    expect(createTray).toBeGreaterThan(reconcile);
  });

  it('recognizes the current executable and exact hidden argument from task XML', async () => {
    const runner = runnerSequence(
      successful(taskXml(String.raw`C:\PROGRAM FILES\You &amp; Yu\YOUYU.EXE`, ' --hidden ')),
      missing()
    );
    const task = createTestTask(runner);

    await expect(task.reconcile(false)).resolves.toBe('current');

    expect(task.isEnabled()).toBe(true);
    expect(runner).toHaveBeenCalledTimes(2);
    expect(runner).toHaveBeenNthCalledWith(1, ['/Query', '/TN', sidBoundTaskName, '/XML']);
    expect(runner).toHaveBeenNthCalledWith(2, ['/Query', '/TN', 'YouYu', '/XML']);
  });

  it('uses a SID-bound task name for the current interactive user', async () => {
    const runner = runnerSequence(missing(), missing(), successful());
    const task = createTestTask(runner);

    await task.reconcile(true);

    expect(runner).toHaveBeenNthCalledWith(1, ['/Query', '/TN', sidBoundTaskName, '/XML']);
    expect(runner).toHaveBeenNthCalledWith(3, expect.arrayContaining(['/Create', '/TN', sidBoundTaskName]));
  });

  it('decodes UTF-16LE XML returned by schtasks', async () => {
    const xml = taskXml(executablePath, '--hidden');
    const runner = runnerSequence(successful(Buffer.from(`\uFEFF${xml}`, 'utf16le')), missing());
    const task = createTestTask(runner);

    await expect(task.reconcile(false)).resolves.toBe('current');
    expect(task.isEnabled()).toBe(true);
  });

  it('accepts Windows default values when task XML omits RunLevel and Enabled', async () => {
    const runner = runnerSequence(
      successful(
        taskXml(executablePath, '--hidden', 'LeastPrivilege', {
          omitRunLevel: true,
          omitTaskEnabled: true
        })
      ),
      missing()
    );
    const task = createTestTask(runner);

    await expect(task.reconcile(false)).resolves.toBe('current');

    expect(task.isEnabled()).toBe(true);
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it('accepts Windows defaults when the optional Settings container is omitted', async () => {
    const runner = runnerSequence(
      successful(taskXml(executablePath, '--hidden', 'LeastPrivilege', { omitSettings: true })),
      missing()
    );
    const task = createTestTask(runner);

    await expect(task.reconcile(false)).resolves.toBe('current');
    expect(task.isEnabled()).toBe(true);
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['a different executable', String.raw`C:\Old\YouYu.exe`, '--hidden', 'LeastPrivilege'],
    ['different arguments', executablePath, '--startup', 'LeastPrivilege'],
    ['an elevated run level', executablePath, '--hidden', 'HighestAvailable']
  ])('rebuilds a stale task with %s', async (_reason, command, args, runLevel) => {
    const runner = runnerSequence(successful(taskXml(command, args, runLevel)), successful(), missing());
    const task = createTestTask(runner);

    await expect(task.reconcile(false)).resolves.toBe('stale');

    expect(task.isEnabled()).toBe(true);
    expect(runner).toHaveBeenNthCalledWith(1, ['/Query', '/TN', sidBoundTaskName, '/XML']);
    expect(runner).toHaveBeenNthCalledWith(2, [
      '/Create',
      '/TN',
      sidBoundTaskName,
      '/SC',
      'ONLOGON',
      '/TR',
      `"${executablePath}" --hidden`,
      '/RL',
      'LIMITED',
      '/F'
    ]);
  });

  it.each([
    ['a disabled task', { taskEnabled: false }],
    ['a non-logon trigger', { triggerName: 'TimeTrigger' as const }],
    ['a disabled logon trigger', { triggerEnabled: false }],
    ['multiple executable actions', { additionalAction: true }]
  ])('rebuilds %s even when the executable action still matches', async (_reason, options) => {
    const runner = runnerSequence(
      successful(taskXml(executablePath, '--hidden', 'LeastPrivilege', options)),
      successful(),
      missing()
    );
    const task = createTestTask(runner);

    await expect(task.reconcile(false)).resolves.toBe('stale');
    expect(task.isEnabled()).toBe(true);
    expect(runner).toHaveBeenCalledTimes(3);
    expect(runner).toHaveBeenNthCalledWith(
      2,
      expect.arrayContaining(['/Create', '/TN', sidBoundTaskName, '/SC', 'ONLOGON'])
    );
  });

  it.each([
    ['the SYSTEM account', { principalUserId: 'S-1-5-18', logonType: 'ServiceAccount' }],
    ['the built-in Administrator account', { principalUserId: 'S-1-5-21-1-2-3-500' }],
    ['an administrators group', { groupId: 'S-1-5-32-544' }],
    ['multiple principals', { additionalPrincipal: true }],
    ['multiple user IDs', { duplicateUserId: true }]
  ])('fails closed when the SID-bound task uses %s', async (_reason, options) => {
    const runner = runnerSequence(successful(taskXml(executablePath, '--hidden', 'LeastPrivilege', options)));
    const task = createTestTask(runner);

    await expect(task.reconcile(false)).rejects.toThrow('计划任务不属于当前用户');
    expect(task.isEnabled()).toBe(false);
    expect(runner).toHaveBeenCalledOnce();
  });

  it.each([
    ['a non-interactive logon', { logonType: 'Password' }],
    ['required privileges', { requiredPrivileges: true }]
  ])('rebuilds a same-user task that uses %s', async (_reason, options) => {
    const runner = runnerSequence(
      successful(taskXml(executablePath, '--hidden', 'LeastPrivilege', options)),
      successful(),
      missing()
    );
    const task = createTestTask(runner);

    await expect(task.reconcile(false)).resolves.toBe('stale');
    expect(runner).toHaveBeenCalledTimes(3);
    expect(runner).toHaveBeenNthCalledWith(
      2,
      expect.arrayContaining(['/Create', '/TN', sidBoundTaskName, '/RL', 'LIMITED'])
    );
  });

  it('migrates a legacy Electron login item only when both scheduled tasks are missing', async () => {
    const runner = runnerSequence(missing(), missing(), successful());
    const task = createTestTask(runner);

    await expect(task.reconcile(true)).resolves.toBe('missing');

    expect(task.isEnabled()).toBe(true);
    expect(runner).toHaveBeenCalledTimes(3);
    expect(runner).toHaveBeenNthCalledWith(2, ['/Query', '/TN', 'YouYu', '/XML']);
    expect(runner).toHaveBeenNthCalledWith(3, expect.arrayContaining(['/Create', '/TN', sidBoundTaskName]));
  });

  it('migrates a same-user managed global task without overwriting another user task', async () => {
    const runner = runnerSequence(
      missing(),
      successful(taskXml(executablePath, '--hidden')),
      successful(),
      successful()
    );
    const task = createTestTask(runner);

    await expect(task.reconcile(false)).resolves.toBe('missing');

    expect(task.isEnabled()).toBe(true);
    expect(runner).toHaveBeenNthCalledWith(2, ['/Query', '/TN', 'YouYu', '/XML']);
    expect(runner).toHaveBeenNthCalledWith(3, expect.arrayContaining(['/Create', '/TN', sidBoundTaskName]));
    expect(runner).toHaveBeenNthCalledWith(4, ['/Delete', '/TN', 'YouYu', '/F']);
  });

  it('cleans a strictly managed legacy task even when the SID-bound task is already current', async () => {
    const runner = runnerSequence(
      successful(taskXml(executablePath, '--hidden')),
      successful(taskXml(executablePath, '--hidden')),
      successful()
    );
    const task = createTestTask(runner);

    await expect(task.reconcile(false)).resolves.toBe('current');

    expect(task.isEnabled()).toBe(true);
    expect(runner).toHaveBeenNthCalledWith(2, ['/Query', '/TN', 'YouYu', '/XML']);
    expect(runner).toHaveBeenNthCalledWith(3, ['/Delete', '/TN', 'YouYu', '/F']);
  });

  it('retries a failed legacy cleanup without losing its managed state', async () => {
    const runner = runnerSequence(
      successful(taskXml(executablePath, '--hidden')),
      successful(taskXml(executablePath, '--hidden')),
      failed(),
      successful(taskXml(executablePath, '--hidden')),
      successful()
    );
    const task = createTestTask(runner);

    await expect(task.reconcile(false)).rejects.toThrow('无法删除旧版 Windows 计划任务');
    expect(task.isEnabled()).toBe(true);

    await expect(task.reconcile(false)).resolves.toBe('current');
    expect(runner).toHaveBeenNthCalledWith(5, ['/Delete', '/TN', 'YouYu', '/F']);
  });

  it('repairs a stale SID-bound task before cleaning its strictly managed legacy twin', async () => {
    const runner = runnerSequence(
      successful(taskXml(executablePath, '--startup')),
      successful(),
      successful(taskXml(executablePath, '--hidden')),
      successful()
    );
    const task = createTestTask(runner);

    await expect(task.reconcile(false)).resolves.toBe('stale');

    expect(task.isEnabled()).toBe(true);
    expect(runner).toHaveBeenNthCalledWith(2, expect.arrayContaining(['/Create', '/TN', sidBoundTaskName]));
    expect(runner).toHaveBeenNthCalledWith(3, ['/Query', '/TN', 'YouYu', '/XML']);
    expect(runner).toHaveBeenNthCalledWith(4, ['/Delete', '/TN', 'YouYu', '/F']);
  });

  it('does not migrate or delete a same-user legacy task from another installation path', async () => {
    const runner = runnerSequence(missing(), successful(taskXml(String.raw`C:\Old\YouYu.exe`, '--hidden')));
    const task = createTestTask(runner);

    await expect(task.reconcile(false)).resolves.toBe('missing');
    await expect(task.setEnabled(false)).resolves.toBeUndefined();

    expect(task.isEnabled()).toBe(false);
    expect(runner).toHaveBeenCalledTimes(2);
    expect(runner).not.toHaveBeenCalledWith(expect.arrayContaining(['/Create']));
    expect(runner).not.toHaveBeenCalledWith(expect.arrayContaining(['/Delete']));
  });

  it('leaves another user global task untouched', async () => {
    const runner = runnerSequence(
      missing(),
      successful(
        taskXml(executablePath, '--hidden', 'LeastPrivilege', {
          principalUserId: 'S-1-5-21-900-800-700-1002'
        })
      )
    );
    const task = createTestTask(runner);

    await expect(task.reconcile(false)).resolves.toBe('missing');
    expect(task.isEnabled()).toBe(false);
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it('leaves a missing task disabled when there is no legacy login item', async () => {
    const runner = runnerSequence(missing(), missing());
    const task = createTestTask(runner);

    await expect(task.reconcile(false)).resolves.toBe('missing');

    expect(task.isEnabled()).toBe(false);
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it('treats disabling an already missing task as an idempotent operation', async () => {
    const runner = runnerSequence(missing(), missing());
    const task = createTestTask(runner);
    await task.reconcile(false);

    await expect(task.setEnabled(false)).resolves.toBeUndefined();
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it('disables a same-user managed global task without creating a replacement first', async () => {
    const runner = runnerSequence(missing(), successful(taskXml(executablePath, '--hidden')), successful());
    const task = createTestTask(runner);

    await task.setEnabled(false);

    expect(task.isEnabled()).toBe(false);
    expect(runner).toHaveBeenNthCalledWith(3, ['/Delete', '/TN', 'YouYu', '/F']);
    expect(runner).not.toHaveBeenCalledWith(expect.arrayContaining(['/Create']));
  });

  it('disables both strictly managed legacy and SID-bound tasks in cleanup-first order', async () => {
    const runner = runnerSequence(
      successful(taskXml(executablePath, '--hidden')),
      successful(taskXml(executablePath, '--hidden')),
      successful(),
      successful()
    );
    const task = createTestTask(runner);

    await task.setEnabled(false);

    expect(task.isEnabled()).toBe(false);
    expect(runner).toHaveBeenNthCalledWith(3, ['/Delete', '/TN', 'YouYu', '/F']);
    expect(runner).toHaveBeenNthCalledWith(4, ['/Delete', '/TN', sidBoundTaskName, '/F']);
  });

  it('keeps startup enabled when strict legacy cleanup fails during disable', async () => {
    const runner = runnerSequence(missing(), successful(taskXml(executablePath, '--hidden')), failed());
    const task = createTestTask(runner);

    await expect(task.setEnabled(false)).rejects.toThrow('无法删除旧版 Windows 计划任务');

    expect(task.isEnabled()).toBe(true);
    expect(runner).toHaveBeenCalledTimes(3);
  });

  it('keeps startup enabled when SID-bound deletion fails after legacy cleanup', async () => {
    const runner = runnerSequence(
      successful(taskXml(executablePath, '--hidden')),
      successful(taskXml(executablePath, '--hidden')),
      successful(),
      failed()
    );
    const task = createTestTask(runner);

    await expect(task.setEnabled(false)).rejects.toThrow('无法删除 Windows 计划任务');

    expect(task.isEnabled()).toBe(true);
    expect(runner).toHaveBeenNthCalledWith(3, ['/Delete', '/TN', 'YouYu', '/F']);
    expect(runner).toHaveBeenNthCalledWith(4, ['/Delete', '/TN', sidBoundTaskName, '/F']);
  });

  it('does not treat a failed query as a missing task', async () => {
    const runner = runnerSequence(failed());
    const task = createTestTask(runner);

    await expect(task.reconcile(false)).rejects.toThrow('无法读取 Windows 计划任务');
    expect(task.isEnabled()).toBe(false);
    expect(runner).toHaveBeenCalledOnce();
  });

  it('does not report a failed first query as a successful disable', async () => {
    const runner = runnerSequence(failed());
    const task = createTestTask(runner);

    await expect(task.setEnabled(false)).rejects.toThrow('无法读取 Windows 计划任务');
    expect(task.isEnabled()).toBe(true);
    expect(runner).toHaveBeenCalledOnce();
  });

  it('queries before the first disable and deletes an existing task', async () => {
    const runner = runnerSequence(successful(taskXml(executablePath, '--hidden')), missing(), successful());
    const task = createTestTask(runner);

    await task.setEnabled(false);

    expect(task.isEnabled()).toBe(false);
    expect(runner).toHaveBeenNthCalledWith(1, ['/Query', '/TN', sidBoundTaskName, '/XML']);
    expect(runner).toHaveBeenNthCalledWith(3, ['/Delete', '/TN', sidBoundTaskName, '/F']);
  });

  it('deletes the task with an argument array and updates the cached state', async () => {
    const runner = runnerSequence(successful(taskXml(executablePath, '--hidden')), missing(), successful());
    const task = createTestTask(runner);
    await task.reconcile(false);

    await task.setEnabled(false);

    expect(task.isEnabled()).toBe(false);
    expect(runner).toHaveBeenNthCalledWith(3, ['/Delete', '/TN', sidBoundTaskName, '/F']);
  });
});
