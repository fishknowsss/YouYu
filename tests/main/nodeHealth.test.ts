import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ConnectivityResult, ConnectivityStatus } from '../../src/shared/ipc';
import {
  createAvailabilityRecord,
  getAvailabilityTone,
  NodeHealthStore,
  type StoredNodeAvailability
} from '../../src/main/storage/nodeHealth';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('node availability health', () => {
  it('calculates availability percent and threshold colors by probe ratio', () => {
    expect(getAvailabilityTone(8, 16)).toBe('danger');
    expect(getAvailabilityTone(10, 16)).toBe('warning');
    expect(getAvailabilityTone(13, 16)).toBe('warning');
    expect(getAvailabilityTone(14, 16)).toBe('success');

    const record = createAvailabilityRecord(
      'JP Tokyo',
      [
        ...Array.from({ length: 8 }, () => createConnectivityResult('available')),
        createConnectivityResult('blocked'),
        createConnectivityResult('timeout')
      ],
      new Date(2026, 6, 3, 12)
    );

    expect(record).toMatchObject({
      nodeName: 'JP Tokyo',
      date: '2026-07-03',
      availableCount: 8,
      totalCount: 10,
      percent: 80,
      tone: 'warning'
    });
  });

  it('keeps one availability result per node for the current local day', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'youyu-node-health-'));
    tempDirs.push(dir);
    const store = new NodeHealthStore(dir);
    const record: StoredNodeAvailability = {
      nodeName: 'JP Tokyo',
      date: '2026-07-03',
      checkedAt: new Date(2026, 6, 3, 12).toISOString(),
      availableCount: 9,
      totalCount: 10,
      percent: 90,
      tone: 'success'
    };

    await store.saveAvailability(record);

    await expect(store.getTodayAvailability('JP Tokyo', new Date(2026, 6, 3, 23))).resolves.toEqual(record);
    await expect(store.getTodayAvailability('JP Tokyo', new Date(2026, 6, 4, 0))).resolves.toBeUndefined();
  });

  it('serializes concurrent node updates without dropping either record', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'youyu-node-health-'));
    tempDirs.push(dir);
    const store = new NodeHealthStore(dir);
    const checkedAt = new Date(2026, 6, 3, 12);

    await Promise.all([
      store.saveAvailability(createAvailabilityRecord('JP Tokyo', [createConnectivityResult('available')], checkedAt)),
      store.saveAvailability(createAvailabilityRecord('US West', [createConnectivityResult('blocked')], checkedAt))
    ]);

    await expect(store.getTodayAvailability('JP Tokyo', checkedAt)).resolves.toBeDefined();
    await expect(store.getTodayAvailability('US West', checkedAt)).resolves.toBeDefined();
  });

  it('recalculates cached availability tone after probe thresholds change', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'youyu-node-health-'));
    tempDirs.push(dir);
    await writeFile(
      join(dir, 'node-health.json'),
      `${JSON.stringify({
        version: 1,
        availabilityByNode: {
          'JP Tokyo': {
            nodeName: 'JP Tokyo',
            date: '2026-07-03',
            checkedAt: new Date(2026, 6, 3, 12).toISOString(),
            availableCount: 9,
            totalCount: 16,
            percent: 56,
            tone: 'success'
          }
        }
      })}\n`,
      'utf8'
    );

    const store = new NodeHealthStore(dir);
    await expect(store.getTodayAvailability('JP Tokyo', new Date(2026, 6, 3, 23))).resolves.toMatchObject({
      availableCount: 9,
      totalCount: 16,
      tone: 'danger'
    });
  });
});

function createConnectivityResult(status: ConnectivityStatus): ConnectivityResult {
  return {
    key: 'steam',
    name: 'Steam',
    url: 'https://store.steampowered.com',
    status,
    statusText: status,
    timings: {}
  };
}
