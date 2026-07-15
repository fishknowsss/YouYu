import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getTeamInstallerNames, refreshTeamBuilds } from '../../scripts/team-builds.mjs';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('team build handoff', () => {
  it('replaces the old handoff with only the current private installers', async () => {
    const root = await createTemporaryRoot();
    const sourceDir = join(root, 'private-source');
    const targetDir = join(root, 'team-builds');
    const names = getTeamInstallerNames('1.6.1');

    await mkdir(sourceDir);
    await mkdir(join(targetDir, '1.6.0'), { recursive: true });
    await writeFile(join(targetDir, 'YouYu-1.6.0-x64-in.exe.blockmap'), 'not for manual distribution');
    await writeFile(join(targetDir, '1.6.0', 'YouYu-1.6.0-x64-in.exe'), 'old private build');
    await writeFile(join(sourceDir, names[0]), 'current internal build');
    await writeFile(join(sourceDir, names[1]), 'current no-pet build');
    await writeFile(join(sourceDir, 'YouYu-1.6.1-x64.exe'), 'public standard build');
    await writeFile(join(sourceDir, `${names[0]}.blockmap`), 'differential update metadata');

    await refreshTeamBuilds({ root, sourceDir, version: '1.6.1' });

    expect((await readdir(targetDir)).sort()).toEqual([...names].sort());
    expect(await readFile(join(targetDir, names[0]), 'utf8')).toBe('current internal build');
    expect(await readFile(join(targetDir, names[1]), 'utf8')).toBe('current no-pet build');
  });

  it('keeps the previous handoff when a private source installer is missing', async () => {
    const root = await createTemporaryRoot();
    const sourceDir = join(root, 'private-source');
    const targetDir = join(root, 'team-builds');
    const names = getTeamInstallerNames('1.6.1');

    await mkdir(sourceDir);
    await mkdir(targetDir);
    await writeFile(join(targetDir, 'YouYu-1.6.0-x64-in.exe'), 'previous usable build');
    await writeFile(join(sourceDir, names[0]), 'only one new installer');

    await expect(refreshTeamBuilds({ root, sourceDir, version: '1.6.1' })).rejects.toThrow();

    expect(await readdir(targetDir)).toEqual(['YouYu-1.6.0-x64-in.exe']);
    expect(await readFile(join(targetDir, 'YouYu-1.6.0-x64-in.exe'), 'utf8')).toBe('previous usable build');
  });

  it('rejects a non-versioned handoff name', () => {
    expect(() => getTeamInstallerNames('../latest')).toThrow('Invalid package version');
  });
});

async function createTemporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'youyu-team-builds-test-'));
  temporaryRoots.push(root);
  return root;
}
