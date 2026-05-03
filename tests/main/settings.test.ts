import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { SettingsStore } from '../../src/main/storage/settings';

let tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs = [];
});

async function makeStore() {
  const dir = await mkdtemp(join(tmpdir(), 'youyu-settings-'));
  tempDirs.push(dir);
  return new SettingsStore(dir);
}

describe('SettingsStore', () => {
  it('creates defaults with a stable generated secret', async () => {
    const store = await makeStore();
    const first = await store.read();
    const second = await store.read();

    expect(first.subscriptionUrl).toBe('');
    expect(first.defaultNodeKeywords).toEqual([]);
    expect(first.controllerSecret).toHaveLength(32);
    expect(second.controllerSecret).toBe(first.controllerSecret);
  });

  it('persists subscription url without replacing the secret', async () => {
    const store = await makeStore();
    const before = await store.read();

    await store.update({ subscriptionUrl: 'https://example.com/sub' });
    const after = await store.read();

    expect(after.subscriptionUrl).toBe('https://example.com/sub');
    expect(after.controllerSecret).toBe(before.controllerSecret);
  });

  it('normalizes remote default node keywords', async () => {
    const store = await makeStore();

    await store.update({ defaultNodeKeywords: [' 香港 ', '', 'HK', '香港'] });
    const after = await store.read();

    expect(after.defaultNodeKeywords).toEqual(['香港', 'HK']);
  });
});
