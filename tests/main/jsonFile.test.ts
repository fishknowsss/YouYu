import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readJsonFile, writeJsonFileAtomic } from '../../src/main/storage/jsonFile';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('atomic JSON persistence', () => {
  it('keeps the last valid value as a backup and recovers a corrupted primary file', async () => {
    const dir = await createTempDir();
    const filePath = join(dir, 'state.json');
    await writeJsonFileAtomic(filePath, { generation: 1 });
    await writeJsonFileAtomic(filePath, { generation: 2 });
    await writeFile(filePath, '{broken json', 'utf8');

    const result = await readJsonFile<{ generation: number }>(filePath);

    expect(result).toEqual({ status: 'found', value: { generation: 1 }, recoveredFromBackup: true });
    expect(JSON.parse(await readFile(filePath, 'utf8'))).toEqual({ generation: 1 });
    expect((await readdir(dir)).some((name) => name.startsWith('state.json.corrupt-'))).toBe(true);
  });

  it('preserves an invalid file even when no valid backup exists', async () => {
    const dir = await createTempDir();
    const filePath = join(dir, 'state.json');
    await writeFile(filePath, '{valuable but incomplete', 'utf8');

    const result = await readJsonFile(filePath);

    expect(result.status).toBe('invalid');
    const corruptName = (await readdir(dir)).find((name) => name.startsWith('state.json.corrupt-'));
    expect(corruptName).toBeDefined();
    expect(await readFile(join(dir, corruptName!), 'utf8')).toBe('{valuable but incomplete');
  });

  it('recovers the backup when JSON syntax is valid but its required structure is not', async () => {
    const dir = await createTempDir();
    const filePath = join(dir, 'state.json');
    await writeJsonFileAtomic(filePath, { version: 1, value: 'valid' });
    await writeJsonFileAtomic(filePath, { version: 2, value: 'new' });
    await writeFile(filePath, '{}\n', 'utf8');

    const result = await readJsonFile<{ version?: number; value?: string }>(filePath, {
      validate: (value) => value.version === 1 || value.version === 2
    });

    expect(result).toEqual({
      status: 'found',
      value: { version: 1, value: 'valid' },
      recoveredFromBackup: true
    });
  });
});

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'youyu-json-'));
  tempDirs.push(dir);
  return dir;
}
