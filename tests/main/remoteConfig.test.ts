import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RemoteConfigClient } from '../../src/main/remoteConfig';
import type { TrafficStore } from '../../src/main/traffic/store';

describe('RemoteConfigClient cache', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'youyu-remote-config-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('recovers a valid cached config from the atomic backup', async () => {
    await writeFile(join(dir, 'remote-config.json'), '{"enabled":', 'utf8');
    await writeFile(
      join(dir, 'remote-config.json.bak'),
      JSON.stringify({ version: 3, enabled: true, preferredStrategy: 'auto' }),
      'utf8'
    );
    const client = new RemoteConfigClient({
      baseDir: dir,
      endpoint: '',
      appVersion: '1.5.0',
      store: {} as TrafficStore
    });

    await expect(client.getActiveConfig()).resolves.toMatchObject({
      version: 3,
      enabled: true,
      preferredStrategy: 'auto'
    });
  });
});
