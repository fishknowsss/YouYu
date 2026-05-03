import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { syncRemoteConfig } from '../../src/main/remoteConfig';
import { SettingsStore } from '../../src/main/storage/settings';

let tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs = [];
});

async function makeStore() {
  const dir = await mkdtemp(join(tmpdir(), 'youyu-remote-config-'));
  tempDirs.push(dir);
  return new SettingsStore(dir);
}

describe('syncRemoteConfig', () => {
  it('applies remote subscription and default node keywords', async () => {
    const store = await makeStore();
    const fetcher = vi.fn(async () =>
      Response.json({
        enabled: true,
        subscriptionUrl: ' https://example.com/remote-sub ',
        defaultNode: {
          keywords: ['香港', 'HK', '香港']
        },
        version: 1
      })
    );

    const settings = await syncRemoteConfig({
      url: 'https://fishknowsss.com/youyu/config.json',
      settingsStore: store,
      fetcher
    });

    expect(settings.subscriptionUrl).toBe('https://example.com/remote-sub');
    expect(settings.defaultNodeKeywords).toEqual(['香港', 'HK']);
  });

  it('keeps the cached settings when the remote file is unavailable', async () => {
    const store = await makeStore();
    await store.update({
      subscriptionUrl: 'https://example.com/cached-sub',
      defaultNodeKeywords: ['日本']
    });
    const fetcher = vi.fn(async () => new Response(null, { status: 404 }));

    const settings = await syncRemoteConfig({
      url: 'https://fishknowsss.com/youyu/config.json',
      settingsStore: store,
      fetcher
    });

    expect(settings.subscriptionUrl).toBe('https://example.com/cached-sub');
    expect(settings.defaultNodeKeywords).toEqual(['日本']);
  });
});
