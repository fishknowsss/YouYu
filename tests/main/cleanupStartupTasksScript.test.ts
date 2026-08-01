import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];
const executablePath = String.raw`C:\Program Files\YouYu\YouYu.exe`;
const userSid = 'S-1-5-21-100-200-300-1001';

function taskXml(
  options: {
    command?: string;
    arguments?: string;
    principal?: string;
    groupPrincipal?: boolean;
    actions?: string;
    triggers?: string;
    prefix?: string;
  } = {}
) {
  const principal = options.groupPrincipal
    ? `<GroupId>${options.principal ?? userSid}</GroupId>`
    : `<UserId>${options.principal ?? userSid}</UserId>`;
  return `${options.prefix ?? ''}<Task xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Principals><Principal>${principal}</Principal></Principals>
  <Triggers>${options.triggers ?? '<LogonTrigger />'}</Triggers>
  <Actions>${options.actions ?? `<Exec><Command>${options.command ?? executablePath}</Command><Arguments>${options.arguments ?? '--hidden'}</Arguments></Exec>`}</Actions>
</Task>`;
}

async function verifyInventory(entries: unknown[]) {
  const directory = await mkdtemp(join(tmpdir(), 'youyu-startup-cleanup-test-'));
  temporaryDirectories.push(directory);
  const inventoryPath = join(directory, 'inventory.json');
  await writeFile(inventoryPath, JSON.stringify(entries), 'utf8');
  const { stdout, stderr } = await execFileAsync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'RemoteSigned',
      '-File',
      join(process.cwd(), 'build', 'cleanup-startup-tasks.ps1'),
      '-Action',
      'Verify',
      '-ExecutablePath',
      executablePath,
      '-InventoryPath',
      inventoryPath
    ],
    { windowsHide: true }
  );
  return { result: JSON.parse(stdout.trim()) as { status: string; matches: string[] }, stderr };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('startup task cleanup script', () => {
  it('accepts only root tasks whose SID, principal, trigger, command, and arguments are fully owned', async () => {
    const sidBoundName = `YouYu-Startup-${userSid}`;
    const { result, stderr } = await verifyInventory([
      { name: sidBoundName, path: `\\${sidBoundName}`, xml: taskXml() },
      { name: 'YouYu', path: '\\YouYu', xml: taskXml() },
      { name: `${sidBoundName}-other`, path: `\\${sidBoundName}-other`, xml: taskXml() },
      {
        name: 'YouYu-Startup-S-1-5-21-100-200-300-2002',
        path: '\\YouYu-Startup-S-1-5-21-100-200-300-2002',
        xml: taskXml()
      },
      { name: sidBoundName, path: `\\Folder\\${sidBoundName}`, xml: taskXml() },
      { name: sidBoundName, path: `\\${sidBoundName}`, xml: taskXml({ principal: 'S-1-5-18' }) },
      { name: sidBoundName, path: `\\${sidBoundName}`, xml: taskXml({ groupPrincipal: true }) },
      {
        name: sidBoundName,
        path: `\\${sidBoundName}`,
        xml: taskXml({ triggers: '<LogonTrigger /><TimeTrigger />' })
      },
      {
        name: sidBoundName,
        path: `\\${sidBoundName}`,
        xml: taskXml({ actions: '<Exec><Command>C:\\Other\\YouYu.exe</Command><Arguments>--hidden</Arguments></Exec>' })
      },
      { name: sidBoundName, path: `\\${sidBoundName}`, xml: taskXml({ arguments: '--hidden --extra' }) },
      {
        name: sidBoundName,
        path: `\\${sidBoundName}`,
        xml: taskXml({ actions: `${taskXml().match(/<Exec>[\s\S]*<\/Exec>/)?.[0]}<ComHandler />` })
      }
    ]);

    expect(result).toEqual({ status: 'verified', matches: [sidBoundName, 'YouYu'] });
    expect(stderr).toContain('Skipping startup task');
  });

  it('accepts quoted exact paths and refuses XML with a DTD', async () => {
    const sidBoundName = `YouYu-Startup-${userSid}`;
    const { result, stderr } = await verifyInventory([
      { name: sidBoundName, path: `\\${sidBoundName}`, xml: taskXml({ command: `&quot;${executablePath}&quot;` }) },
      {
        name: 'YouYu',
        path: '\\YouYu',
        xml: taskXml({ prefix: '<!DOCTYPE Task [<!ENTITY xxe SYSTEM "file:///C:/Windows/win.ini">]>' })
      }
    ]);

    expect(result.matches).toEqual([sidBoundName]);
    expect(stderr).toContain("Skipping startup task 'YouYu'");
  });

  it('rejects injected inventories in production cleanup mode before opening Task Scheduler', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'youyu-startup-cleanup-seam-test-'));
    temporaryDirectories.push(directory);
    const inventoryPath = join(directory, 'inventory.json');
    await writeFile(inventoryPath, '[]', 'utf8');

    await expect(
      execFileAsync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'RemoteSigned',
          '-File',
          join(process.cwd(), 'build', 'cleanup-startup-tasks.ps1'),
          '-Action',
          'Cleanup',
          '-ExecutablePath',
          executablePath,
          '-InventoryPath',
          inventoryPath
        ],
        { windowsHide: true }
      )
    ).rejects.toMatchObject({ code: 2 });
  });
});
