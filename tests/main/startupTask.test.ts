import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import {
  createWindowsStartupTask,
  type StartupTaskRunResult,
  type StartupTaskRunner
} from '../../src/main/platform/startupTask';

const executablePath = String.raw`C:\Program Files\You & Yu\YouYu.exe`;

function taskXml(
  command: string,
  args: string,
  runLevel = 'LeastPrivilege',
  options: {
    taskEnabled?: boolean;
    triggerName?: 'LogonTrigger' | 'TimeTrigger';
    triggerEnabled?: boolean;
    additionalAction?: boolean;
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
      <RunLevel>${runLevel}</RunLevel>
    </Principal>
  </Principals>
  <Actions Context="Author">
    <Exec>
      <Command>${command}</Command>
      <Arguments>${args}</Arguments>
    </Exec>
    ${options.additionalAction ? '<Exec><Command>C:\\Other.exe</Command><Arguments></Arguments></Exec>' : ''}
  </Actions>
  <Settings>
    <Enabled>${options.taskEnabled === false ? 'false' : 'true'}</Enabled>
  </Settings>
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
      successful(taskXml(String.raw`C:\PROGRAM FILES\You &amp; Yu\YOUYU.EXE`, ' --hidden '))
    );
    const task = createWindowsStartupTask({ executablePath, runner });

    await expect(task.reconcile(false)).resolves.toBe('current');

    expect(task.isEnabled()).toBe(true);
    expect(runner).toHaveBeenCalledOnce();
    expect(runner).toHaveBeenCalledWith(['/Query', '/TN', 'YouYu', '/XML']);
  });

  it('decodes UTF-16LE XML returned by schtasks', async () => {
    const xml = taskXml(executablePath, '--hidden');
    const runner = runnerSequence(successful(Buffer.from(`\uFEFF${xml}`, 'utf16le')));
    const task = createWindowsStartupTask({ executablePath, runner });

    await expect(task.reconcile(false)).resolves.toBe('current');
    expect(task.isEnabled()).toBe(true);
  });

  it.each([
    ['a different executable', String.raw`C:\Old\YouYu.exe`, '--hidden', 'LeastPrivilege'],
    ['different arguments', executablePath, '--startup', 'LeastPrivilege'],
    ['an elevated run level', executablePath, '--hidden', 'HighestAvailable']
  ])('rebuilds a stale task with %s', async (_reason, command, args, runLevel) => {
    const runner = runnerSequence(successful(taskXml(command, args, runLevel)), successful());
    const task = createWindowsStartupTask({ executablePath, runner });

    await expect(task.reconcile(false)).resolves.toBe('stale');

    expect(task.isEnabled()).toBe(true);
    expect(runner).toHaveBeenNthCalledWith(1, ['/Query', '/TN', 'YouYu', '/XML']);
    expect(runner).toHaveBeenNthCalledWith(2, [
      '/Create',
      '/TN',
      'YouYu',
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
      successful()
    );
    const task = createWindowsStartupTask({ executablePath, runner });

    await expect(task.reconcile(false)).resolves.toBe('stale');
    expect(task.isEnabled()).toBe(true);
    expect(runner).toHaveBeenCalledTimes(2);
    expect(runner).toHaveBeenNthCalledWith(2, expect.arrayContaining(['/Create', '/TN', 'YouYu', '/SC', 'ONLOGON']));
  });

  it('migrates a legacy login item only when the task is missing', async () => {
    const runner = runnerSequence(missing(), successful());
    const task = createWindowsStartupTask({ executablePath, runner });

    await expect(task.reconcile(true)).resolves.toBe('missing');

    expect(task.isEnabled()).toBe(true);
    expect(runner).toHaveBeenCalledTimes(2);
    expect(runner).toHaveBeenNthCalledWith(2, expect.arrayContaining(['/Create', '/TN', 'YouYu']));
  });

  it('leaves a missing task disabled when there is no legacy login item', async () => {
    const runner = runnerSequence(missing());
    const task = createWindowsStartupTask({ executablePath, runner });

    await expect(task.reconcile(false)).resolves.toBe('missing');

    expect(task.isEnabled()).toBe(false);
    expect(runner).toHaveBeenCalledOnce();
  });

  it('treats disabling an already missing task as an idempotent operation', async () => {
    const runner = runnerSequence(missing());
    const task = createWindowsStartupTask({ executablePath, runner });
    await task.reconcile(false);

    await expect(task.setEnabled(false)).resolves.toBeUndefined();
    expect(runner).toHaveBeenCalledOnce();
  });

  it('does not treat a failed query as a missing task', async () => {
    const runner = runnerSequence(failed());
    const task = createWindowsStartupTask({ executablePath, runner });

    await expect(task.reconcile(false)).rejects.toThrow('无法读取 Windows 计划任务');
    expect(task.isEnabled()).toBe(false);
    expect(runner).toHaveBeenCalledOnce();
  });

  it('does not report a failed first query as a successful disable', async () => {
    const runner = runnerSequence(failed());
    const task = createWindowsStartupTask({ executablePath, runner });

    await expect(task.setEnabled(false)).rejects.toThrow('无法读取 Windows 计划任务');
    expect(runner).toHaveBeenCalledOnce();
  });

  it('queries before the first disable and deletes an existing task', async () => {
    const runner = runnerSequence(successful(taskXml(executablePath, '--hidden')), successful());
    const task = createWindowsStartupTask({ executablePath, runner });

    await task.setEnabled(false);

    expect(task.isEnabled()).toBe(false);
    expect(runner).toHaveBeenNthCalledWith(1, ['/Query', '/TN', 'YouYu', '/XML']);
    expect(runner).toHaveBeenNthCalledWith(2, ['/Delete', '/TN', 'YouYu', '/F']);
  });

  it('deletes the task with an argument array and updates the cached state', async () => {
    const runner = runnerSequence(successful(taskXml(executablePath, '--hidden')), successful());
    const task = createWindowsStartupTask({ executablePath, runner });
    await task.reconcile(false);

    await task.setEnabled(false);

    expect(task.isEnabled()).toBe(false);
    expect(runner).toHaveBeenNthCalledWith(2, ['/Delete', '/TN', 'YouYu', '/F']);
  });
});
