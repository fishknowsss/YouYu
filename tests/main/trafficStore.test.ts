import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TrafficStore } from '../../src/main/traffic/store';

let dir: string;

const testSecretStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (value: string) => Buffer.from(`protected:${value}`, 'utf8'),
  decryptString: (value: Buffer) => value.toString('utf8').replace(/^protected:/, '')
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'youyu-traffic-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('TrafficStore', () => {
  it('persists totals, daily totals, and pending report bytes', async () => {
    const store = new TrafficStore(dir);

    await store.addTraffic(120, 880, new Date('2026-05-10T08:00:00.000Z'));
    await store.addTraffic(30, 70, new Date('2026-05-10T09:00:00.000Z'));

    const snapshot = await store.getSnapshot(new Date('2026-05-10T10:00:00.000Z'));
    expect(snapshot.stats.totalUpload).toBe(150);
    expect(snapshot.stats.totalDownload).toBe(950);
    expect(snapshot.stats.todayUpload).toBe(150);
    expect(snapshot.stats.todayDownload).toBe(950);
    expect(snapshot.stats.pendingUpload).toBe(150);
    expect(snapshot.stats.pendingDownload).toBe(950);
  });

  it('keeps concurrent traffic increments instead of overwriting them', async () => {
    const store = new TrafficStore(dir);
    const now = new Date('2026-05-10T08:00:00.000Z');

    await Promise.all(Array.from({ length: 20 }, () => store.addTraffic(5, 7, now)));

    const snapshot = await store.getSnapshot(now);
    expect(snapshot.stats.totalUpload).toBe(100);
    expect(snapshot.stats.totalDownload).toBe(140);
    expect(snapshot.stats.pendingUpload).toBe(100);
    expect(snapshot.stats.pendingDownload).toBe(140);
  });

  it('invalidates an identity whose device seed is missing while preserving local traffic', async () => {
    await writeFile(
      join(dir, 'traffic.json'),
      JSON.stringify({
        version: 3,
        deviceSeed: '',
        identity: {
          userId: 'u_1',
          deviceId: 'd_1',
          name: 'Alice',
          deviceName: 'DESKTOP',
          verificationStatus: 'verified'
        },
        totalUpload: 120,
        totalDownload: 340,
        pendingUpload: 12,
        pendingDownload: 34,
        pendingReport: { id: 'stale-report', upload: 12, download: 34, reportedAt: '2026-05-10T08:00:00.000Z' },
        daily: { '2026-05-10': { upload: 120, download: 340 } },
        nodeUsage: {}
      })
    );
    const store = new TrafficStore(dir);

    const [first, second] = await Promise.all([store.read(), store.read()]);
    const persisted = JSON.parse(await readFile(join(dir, 'traffic.json'), 'utf8')) as {
      deviceSeed?: string;
      identity?: { registeredAt?: string };
      pendingReport?: unknown;
      reportStatus?: string;
      reportError?: string;
    };
    const reopened = await new TrafficStore(dir).read();

    expect(first.deviceSeed).not.toBe('');
    expect(second.deviceSeed).toBe(first.deviceSeed);
    expect(first.identity).toBeUndefined();
    expect(second.totalUpload).toBe(120);
    expect(second.pendingUpload).toBe(12);
    expect(persisted.deviceSeed).toBe(first.deviceSeed);
    expect(persisted.identity).toBeUndefined();
    expect(persisted.pendingReport).toBeUndefined();
    expect(persisted.reportStatus).toBe('failed');
    expect(persisted.reportError).toContain('re-registration');
    expect(reopened.deviceSeed).toBe(first.deviceSeed);
    expect(reopened.identity).toBeUndefined();
  });

  it('keeps high-frequency traffic in memory until checkpoint or explicit flush', async () => {
    const store = new TrafficStore(dir, { checkpointIntervalMs: 60_000 });

    await store.addTraffic(10, 20, new Date('2026-05-10T08:00:00.000Z'));
    await store.addTraffic(30, 40, new Date('2026-05-10T08:00:10.000Z'));

    expect((await store.getSnapshot(new Date('2026-05-10T08:00:20.000Z'))).stats.totalUpload).toBe(40);
    expect(JSON.parse(await readFile(join(dir, 'traffic.json'), 'utf8')).totalUpload).toBe(0);

    await store.flush();
    expect(JSON.parse(await readFile(join(dir, 'traffic.json'), 'utf8'))).toMatchObject({
      totalUpload: 40,
      appliedJournalIds: []
    });
    await expect(readFile(join(dir, 'traffic-journal.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('recovers traffic journaled before a checkpoint without replaying it twice', async () => {
    const recordedAt = new Date('2026-05-10T08:00:00.000Z');
    const store = new TrafficStore(dir, { checkpointIntervalMs: 60_000 });
    await store.addTraffic(15, 25, recordedAt, { nodeName: 'JP Tokyo', durationMs: 5_000 });

    await expect(readFile(join(dir, 'traffic-journal.json'), 'utf8')).resolves.toContain('JP Tokyo');
    expect(JSON.parse(await readFile(join(dir, 'traffic.json'), 'utf8')).totalUpload).toBe(0);

    const recovered = new TrafficStore(dir);
    await expect(recovered.getSnapshot(recordedAt)).resolves.toMatchObject({
      stats: {
        totalUpload: 15,
        totalDownload: 25,
        pendingUpload: 15,
        pendingDownload: 25,
        nodeUsage: {
          mostUsed: expect.objectContaining({ name: 'JP Tokyo', upload: 15, download: 25 })
        }
      }
    });
    await expect(readFile(join(dir, 'traffic-journal.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

    const replayed = new TrafficStore(dir);
    await expect(replayed.getSnapshot(recordedAt)).resolves.toMatchObject({
      stats: { totalUpload: 15, totalDownload: 25, pendingUpload: 15, pendingDownload: 25 }
    });
  });

  it.each([
    ['traffic file is missing', false],
    ['traffic file and backup are corrupt', true]
  ])('recovers a valid journal when %s', async (_label, writeCorruptTraffic) => {
    const recordedAt = '2026-05-10T08:00:00.000Z';
    const entry = {
      id: '00000000-0000-4000-8000-000000000001',
      upload: 15,
      download: 25,
      recordedAt
    };
    if (writeCorruptTraffic) {
      await writeFile(join(dir, 'traffic.json'), '{"totalUpload":', 'utf8');
      await writeFile(join(dir, 'traffic.json.bak'), '{"totalDownload":', 'utf8');
    }
    await writeFile(join(dir, 'traffic-journal.json'), JSON.stringify({ version: 1, entries: [entry] }), 'utf8');

    const recovered = new TrafficStore(dir);
    await expect(recovered.getSnapshot(new Date(recordedAt))).resolves.toMatchObject({
      stats: { totalUpload: 15, totalDownload: 25, pendingUpload: 15, pendingDownload: 25 }
    });
    await expect(readFile(join(dir, 'traffic-journal.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not mutate traffic state when the durable journal write fails', async () => {
    const journalError = new Error('journal disk full');
    const store = new TrafficStore(dir, {
      journal: {
        read: async () => [],
        append: async () => {
          throw journalError;
        },
        remove: async () => undefined
      }
    });

    await expect(store.addTraffic(15, 25, new Date('2026-05-10T08:00:00.000Z'))).rejects.toBe(journalError);
    await expect(store.getSnapshot(new Date('2026-05-10T08:00:00.000Z'))).resolves.toMatchObject({
      stats: { totalUpload: 0, totalDownload: 0, pendingUpload: 0, pendingDownload: 0 }
    });
  });

  it('uses journal application ids to make a failed cleanup replay idempotent', async () => {
    const recordedAt = new Date('2026-05-10T08:00:00.000Z');
    const store = new TrafficStore(dir, { checkpointIntervalMs: 60_000 });
    const journal = (store as unknown as { journal: { remove: (ids: readonly string[]) => Promise<void> } }).journal;
    const remove = vi.spyOn(journal, 'remove').mockRejectedValueOnce(new Error('journal cleanup failed'));

    await store.addTraffic(15, 25, recordedAt);
    await expect(store.flush()).rejects.toThrow('journal cleanup failed');
    remove.mockRestore();

    const recovered = new TrafficStore(dir);
    await expect(recovered.getSnapshot(recordedAt)).resolves.toMatchObject({
      stats: { totalUpload: 15, totalDownload: 25, pendingUpload: 15, pendingDownload: 25 }
    });
    const replayed = new TrafficStore(dir);
    await expect(replayed.getSnapshot(recordedAt)).resolves.toMatchObject({
      stats: { totalUpload: 15, totalDownload: 25, pendingUpload: 15, pendingDownload: 25 }
    });
  });

  it('does not truncate journal idempotency markers before every checkpointed entry is removed', async () => {
    const recordedAt = '2026-05-10T08:00:00.000Z';
    const ids = Array.from(
      { length: 4_100 },
      (_, index) => `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`
    );
    await writeFile(
      join(dir, 'traffic.json'),
      JSON.stringify({
        version: 4,
        deviceSeed: 'seed-1',
        totalUpload: ids.length,
        totalDownload: 0,
        pendingUpload: ids.length,
        pendingDownload: 0,
        appliedJournalIds: ids,
        daily: { '2026-05-10': { upload: ids.length, download: 0 } },
        nodeUsage: {}
      }),
      'utf8'
    );
    await writeFile(
      join(dir, 'traffic-journal.json'),
      JSON.stringify({
        version: 1,
        entries: ids.map((id) => ({ id, upload: 1, download: 0, recordedAt }))
      }),
      'utf8'
    );

    const recovered = new TrafficStore(dir);
    await expect(recovered.getSnapshot(new Date(recordedAt))).resolves.toMatchObject({
      stats: {
        totalUpload: ids.length,
        totalDownload: 0,
        pendingUpload: ids.length,
        pendingDownload: 0
      }
    });
    await expect(readFile(join(dir, 'traffic-journal.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

    const replayed = new TrafficStore(dir);
    await expect(replayed.getSnapshot(new Date(recordedAt))).resolves.toMatchObject({
      stats: { totalUpload: ids.length, pendingUpload: ids.length }
    });
  });

  it('keeps legacy traffic files and pending report ids compatible', async () => {
    await writeFile(
      join(dir, 'traffic.json'),
      JSON.stringify({
        version: 3,
        deviceSeed: 'legacy-seed',
        identity: {
          userId: 'u_1',
          deviceId: 'd_1',
          name: 'Alice',
          registeredAt: '2026-05-10T08:00:00.000Z',
          verificationStatus: 'verified'
        },
        totalUpload: 15,
        totalDownload: 25,
        pendingUpload: 15,
        pendingDownload: 25,
        pendingReport: {
          id: 'legacy-report-id',
          upload: 15,
          download: 25,
          reportedAt: '2026-05-10T08:00:00.000Z'
        },
        daily: { '2026-05-10': { upload: 15, download: 25 } },
        nodeUsage: {}
      }),
      'utf8'
    );
    const store = new TrafficStore(dir);

    await expect(
      store.getOrCreatePendingReport(15, 25, new Date('2026-05-10T08:01:00.000Z'), {
        userId: 'u_1',
        deviceId: 'd_1'
      })
    ).resolves.toMatchObject({ id: 'legacy-report-id', upload: 15, download: 25 });
  });

  it('persists a dirty in-memory snapshot when the checkpoint expires', async () => {
    vi.useFakeTimers();
    try {
      const store = new TrafficStore(dir, { checkpointIntervalMs: 5 });
      await store.addTraffic(15, 25, new Date('2026-05-10T08:00:00.000Z'));

      expect(JSON.parse(await readFile(join(dir, 'traffic.json'), 'utf8'))).toMatchObject({
        totalUpload: 0,
        totalDownload: 0
      });

      await vi.advanceTimersByTimeAsync(5);
      await store.read();

      expect(JSON.parse(await readFile(join(dir, 'traffic.json'), 'utf8'))).toMatchObject({
        totalUpload: 15,
        totalDownload: 25
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not expose the mutable in-memory snapshot to callers', async () => {
    const store = new TrafficStore(dir);
    const snapshot = await store.read();

    snapshot.totalUpload = 999;
    snapshot.daily['2099-01-01'] = { upload: 999, download: 999 };

    await expect(store.read()).resolves.toMatchObject({ totalUpload: 0, daily: {} });
  });

  it('persists staged traffic together with a critical identity mutation', async () => {
    const store = new TrafficStore(dir, { checkpointIntervalMs: 60_000 });
    await store.addTraffic(25, 75, new Date('2026-05-10T08:00:00.000Z'));

    await store.registerIdentity({ userId: 'u_1', deviceId: 'd_1', name: 'Alice', deviceName: 'PC' });

    const persisted = JSON.parse(await readFile(join(dir, 'traffic.json'), 'utf8'));
    expect(persisted.totalUpload).toBe(25);
    expect(persisted.totalDownload).toBe(75);
    expect(persisted.identity).toMatchObject({ userId: 'u_1', deviceId: 'd_1' });
  });

  it('bounds retained daily and node histories during normalization', async () => {
    const daily = Object.fromEntries(
      Array.from({ length: 450 }, (_, index) => {
        const date = new Date(Date.UTC(2025, 0, 1 + index)).toISOString().slice(0, 10);
        return [date, { upload: index, download: index }];
      })
    );
    const nodeUsage = Object.fromEntries(
      Array.from({ length: 600 }, (_, index) => [
        `Node ${index.toString().padStart(3, '0')}`,
        {
          upload: index,
          download: index,
          durationMs: index,
          lastUsedAt: new Date(1_700_000_000_000 + index).toISOString()
        }
      ])
    );
    await writeFile(
      join(dir, 'traffic.json'),
      JSON.stringify({
        version: 4,
        deviceSeed: 'seed-1',
        totalUpload: 1,
        totalDownload: 1,
        pendingUpload: 0,
        pendingDownload: 0,
        daily,
        nodeUsage
      }),
      'utf8'
    );

    await new TrafficStore(dir).read();
    const persisted = JSON.parse(await readFile(join(dir, 'traffic.json'), 'utf8'));
    expect(Object.keys(persisted.daily)).toHaveLength(400);
    expect(Object.keys(persisted.nodeUsage)).toHaveLength(512);
    expect(persisted.daily).toHaveProperty('2026-03-26');
    expect(persisted.daily).not.toHaveProperty('2025-01-01');
    expect(persisted.nodeUsage).toHaveProperty('Node 599');
    expect(persisted.nodeUsage).not.toHaveProperty('Node 000');
  });

  it('rejects a stale activation response after the device seed changes', async () => {
    const store = new TrafficStore(dir);
    const oldSeed = await store.createDeviceSeed();
    await writeFile(
      join(dir, 'traffic.json'),
      JSON.stringify({
        version: 4,
        deviceSeed: 'replacement-seed',
        totalUpload: 0,
        totalDownload: 0,
        pendingUpload: 0,
        pendingDownload: 0,
        daily: {},
        nodeUsage: {}
      }),
      'utf8'
    );
    const reopened = new TrafficStore(dir);

    await expect(
      reopened.activateIdentity(
        { userId: 'u_1', deviceId: 'd_1', name: 'Alice', deviceName: 'PC' },
        { totalUpload: 0, totalDownload: 0, todayUpload: 0, todayDownload: 0, date: '2026-05-10' },
        new Date('2026-05-10T08:00:00.000Z'),
        oldSeed
      )
    ).rejects.toMatchObject({ code: 'DEVICE_SEED_STALE' });
    expect((await reopened.getSnapshot()).identity).toBeUndefined();
  });

  it('uses the local calendar day for today totals', async () => {
    const store = new TrafficStore(dir);
    const localToday = new Date(2026, 4, 10, 0, 30, 0);
    const localTomorrow = new Date(2026, 4, 11, 0, 5, 0);

    await store.addTraffic(10, 20, localToday);

    const todaySnapshot = await store.getSnapshot(localToday);
    const tomorrowSnapshot = await store.getSnapshot(localTomorrow);
    expect(todaySnapshot.stats.todayUpload).toBe(10);
    expect(todaySnapshot.stats.todayDownload).toBe(20);
    expect(tomorrowSnapshot.stats.todayUpload).toBe(0);
    expect(tomorrowSnapshot.stats.todayDownload).toBe(0);
  });

  it('summarizes the most used and longest used nodes', async () => {
    const store = new TrafficStore(dir);

    await store.addTraffic(100, 300, new Date('2026-05-10T08:00:00.000Z'), {
      nodeName: 'JP Tokyo',
      durationMs: 5 * 60 * 1000
    });
    await store.addTraffic(10, 20, new Date('2026-05-10T08:10:00.000Z'), {
      nodeName: 'US West',
      durationMs: 12 * 60 * 1000
    });

    const snapshot = await store.getSnapshot(new Date('2026-05-10T08:20:00.000Z'));
    expect(snapshot.stats.nodeUsage.mostUsed?.name).toBe('JP Tokyo');
    expect(snapshot.stats.nodeUsage.longestUsed?.name).toBe('US West');
  });

  it('keeps identity and clears reported pending bytes', async () => {
    const store = new TrafficStore(dir);

    await store.registerIdentity({
      userId: 'u_1',
      deviceId: 'd_1',
      name: '张三',
      deviceName: 'DESKTOP'
    });
    await store.addTraffic(100, 200, new Date('2026-05-10T08:00:00.000Z'));
    await store.markReported(100, 200, new Date('2026-05-10T08:10:00.000Z'));

    const snapshot = await store.getSnapshot(new Date('2026-05-10T08:20:00.000Z'));
    expect(snapshot.identity?.name).toBe('张三');
    expect(snapshot.stats.pendingUpload).toBe(0);
    expect(snapshot.stats.pendingDownload).toBe(0);
    expect(snapshot.stats.reportStatus).toBe('synced');
  });

  it('uses backend-verified totals when available', async () => {
    const store = new TrafficStore(dir);

    await store.registerIdentity({
      userId: 'u_1',
      deviceId: 'd_1',
      name: '张三',
      deviceName: 'DESKTOP'
    });
    await store.addTraffic(100, 200, new Date('2026-05-10T08:00:00.000Z'));
    await store.markReported(100, 200, new Date('2026-05-10T08:05:00.000Z'));
    await store.markServerTotals({ totalUpload: 900, totalDownload: 1200 }, new Date('2026-05-10T08:10:00.000Z'));

    const snapshot = await store.getSnapshot(new Date('2026-05-10T08:20:00.000Z'));
    expect(snapshot.stats.totalUpload).toBe(900);
    expect(snapshot.stats.totalDownload).toBe(1200);
    expect(snapshot.stats.totalSource).toBe('server');
    expect(snapshot.stats.serverSyncedAt).toBe('2026-05-10T08:10:00.000Z');
    expect(snapshot.stats.todayUpload).toBe(100);
    expect(snapshot.stats.todayDownload).toBe(200);
  });

  it('adds pending local bytes to the last backend-verified totals', async () => {
    const store = new TrafficStore(dir);

    await store.registerIdentity({
      userId: 'u_1',
      deviceId: 'd_1',
      name: '张三',
      deviceName: 'DESKTOP'
    });
    await store.markServerTotals({ totalUpload: 900, totalDownload: 1200 }, new Date('2026-05-10T08:10:00.000Z'));
    await store.addTraffic(25, 35, new Date('2026-05-10T08:15:00.000Z'));

    const snapshot = await store.getSnapshot(new Date('2026-05-10T08:20:00.000Z'));
    expect(snapshot.stats.totalUpload).toBe(925);
    expect(snapshot.stats.totalDownload).toBe(1235);
    expect(snapshot.stats.totalSource).toBe('server');
  });

  it('uses the backend today baseline and only adds local bytes recorded after that baseline', async () => {
    const store = new TrafficStore(dir);
    const syncedAt = new Date('2026-05-10T08:10:00.000Z');

    await store.registerIdentity({
      userId: 'u_1',
      deviceId: 'd_1',
      name: 'Alice',
      deviceName: 'DESKTOP'
    });
    await store.addTraffic(100, 200, new Date('2026-05-10T08:00:00.000Z'));
    await store.markServerTotals(
      {
        totalUpload: 900,
        totalDownload: 1200,
        todayUpload: 500,
        todayDownload: 700,
        date: '2026-05-10'
      },
      syncedAt,
      undefined,
      { localDayBaseline: 'current' }
    );
    await store.addTraffic(25, 35, new Date('2026-05-10T08:15:00.000Z'));

    await expect(store.getSnapshot(new Date('2026-05-10T08:20:00.000Z'))).resolves.toMatchObject({
      stats: {
        totalUpload: 1025,
        totalDownload: 1435,
        todayUpload: 525,
        todayDownload: 735,
        totalSource: 'server'
      }
    });
  });

  it('does not hide traffic recorded while a backend report is in flight', async () => {
    const store = new TrafficStore(dir);
    const reportStartedAt = new Date('2026-05-10T08:00:00.000Z');

    await store.registerIdentity({
      userId: 'u_1',
      deviceId: 'd_1',
      name: 'Alice',
      deviceName: 'DESKTOP'
    });
    await store.addTraffic(100, 200, reportStartedAt);
    const report = await store.getOrCreatePendingReport(100, 200, reportStartedAt, {
      userId: 'u_1',
      deviceId: 'd_1'
    });
    await store.addTraffic(25, 35, new Date('2026-05-10T08:01:00.000Z'));
    await store.markReported(100, 200, new Date('2026-05-10T08:02:00.000Z'), report?.id, {
      userId: 'u_1',
      deviceId: 'd_1'
    });
    await store.markServerTotals(
      {
        totalUpload: 1000,
        totalDownload: 1400,
        todayUpload: 500,
        todayDownload: 700,
        date: '2026-05-10'
      },
      new Date('2026-05-10T08:02:00.000Z'),
      { userId: 'u_1', deviceId: 'd_1' },
      {
        localDayBaseline: {
          date: report!.localDate!,
          upload: report!.localDayUpload!,
          download: report!.localDayDownload!
        }
      }
    );

    await expect(store.getSnapshot(new Date('2026-05-10T08:03:00.000Z'))).resolves.toMatchObject({
      stats: {
        totalUpload: 1025,
        totalDownload: 1435,
        todayUpload: 525,
        todayDownload: 735,
        pendingUpload: 25,
        pendingDownload: 35,
        totalSource: 'server'
      }
    });
  });

  it('atomically replaces a verified identity together with its cloud baselines', async () => {
    const store = new TrafficStore(dir);
    const now = new Date('2026-05-10T08:10:00.000Z');
    await store.registerIdentity({ userId: 'old-user', deviceId: 'device', name: 'Alice', deviceName: 'PC' });
    await store.addTraffic(100, 200, now, { nodeName: 'Old Node', durationMs: 5_000 });

    const writableStore = store as unknown as { write(value: unknown, backupExisting?: boolean): Promise<void> };
    const writeSpy = vi.spyOn(writableStore, 'write');
    const activated = await store.activateIdentity(
      { userId: 'new-user', deviceId: 'device', name: 'Bob', deviceName: 'PC' },
      {
        totalUpload: 4_096,
        totalDownload: 8_192,
        todayUpload: 1_024,
        todayDownload: 2_048,
        date: '2026-05-10'
      },
      now
    );

    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(activated).toMatchObject({
      identity: { userId: 'new-user', deviceId: 'device', name: 'Bob' },
      pendingUpload: 0,
      pendingDownload: 0
    });
    await expect(store.getSnapshot(now)).resolves.toMatchObject({
      identity: { userId: 'new-user', deviceId: 'device', name: 'Bob' },
      stats: {
        totalUpload: 4_096,
        totalDownload: 8_192,
        todayUpload: 1_024,
        todayDownload: 2_048,
        pendingUpload: 0,
        pendingDownload: 0,
        totalSource: 'server',
        nodeUsage: {}
      }
    });
  });

  it('updates only the current verified identity name when a signed remote profile is synchronized', async () => {
    const store = new TrafficStore(dir);
    await store.registerIdentity({ userId: 'user-1', deviceId: 'device-1', name: 'Ailce', deviceName: 'PC' });

    await expect(
      store.syncIdentityProfile({ userId: 'user-1', deviceId: 'stale-device' }, { name: 'Wrong' })
    ).resolves.toBe(false);
    await expect(
      store.syncIdentityProfile({ userId: 'user-1', deviceId: 'device-1' }, { name: 'Alice' })
    ).resolves.toBe(true);
    await expect(
      store.syncIdentityProfile({ userId: 'user-1', deviceId: 'device-1' }, { name: 'Alice' })
    ).resolves.toBe(false);
    await expect(
      store.syncIdentityProfile({ userId: 'user-1', deviceId: 'device-1' }, { name: 'A'.repeat(81) })
    ).rejects.toThrow('invalid remote traffic profile');
    await expect(
      store.syncIdentityProfile({ userId: 'user-1', deviceId: 'device-1' }, { name: 'Alice\nAdmin' })
    ).rejects.toThrow('invalid remote traffic profile');
    await expect(store.getSnapshot()).resolves.toMatchObject({
      identity: { userId: 'user-1', deviceId: 'device-1', name: 'Alice', verificationStatus: 'verified' }
    });

    const reopened = new TrafficStore(dir);
    await expect(reopened.getSnapshot()).resolves.toMatchObject({ identity: { name: 'Alice' } });
  });

  it('keeps the old identity and usage when the atomic activation write fails', async () => {
    const store = new TrafficStore(dir);
    const now = new Date('2026-05-10T08:10:00.000Z');
    await store.registerIdentity({ userId: 'old-user', deviceId: 'device', name: 'Alice', deviceName: 'PC' });
    await store.addTraffic(100, 200, now, { nodeName: 'Old Node', durationMs: 5_000 });
    const before = await store.getSnapshot(now);

    const writableStore = store as unknown as { write(value: unknown, backupExisting?: boolean): Promise<void> };
    const writeSpy = vi.spyOn(writableStore, 'write').mockRejectedValueOnce(new Error('disk full'));
    await expect(
      store.activateIdentity(
        { userId: 'new-user', deviceId: 'device', name: 'Bob', deviceName: 'PC' },
        {
          totalUpload: 4_096,
          totalDownload: 8_192,
          todayUpload: 1_024,
          todayDownload: 2_048,
          date: '2026-05-10'
        },
        now
      )
    ).rejects.toThrow('disk full');
    writeSpy.mockRestore();

    await expect(store.getSnapshot(now)).resolves.toEqual(before);
  });

  it('does not reuse backend totals after the registered identity changes', async () => {
    const store = new TrafficStore(dir);

    await store.registerIdentity({
      userId: 'u_1',
      deviceId: 'd_1',
      name: '张三',
      deviceName: 'DESKTOP'
    });
    await store.markServerTotals({ totalUpload: 900, totalDownload: 1200 }, new Date('2026-05-10T08:10:00.000Z'));
    await store.registerIdentity({
      userId: 'u_2',
      deviceId: 'd_2',
      name: '李四',
      deviceName: 'DESKTOP'
    });

    const snapshot = await store.getSnapshot(new Date('2026-05-10T08:20:00.000Z'));
    expect(snapshot.identity?.userId).toBe('u_2');
    expect(snapshot.stats.totalUpload).toBe(0);
    expect(snapshot.stats.totalDownload).toBe(0);
    expect(snapshot.stats.totalSource).toBe('local');
    expect(snapshot.stats.serverSyncedAt).toBeUndefined();
  });

  it('clears identity-scoped traffic when switching between verified identities', async () => {
    const store = new TrafficStore(dir);
    const recordedAt = new Date('2026-05-10T08:00:00.000Z');

    await store.registerIdentity({
      userId: 'u_1',
      deviceId: 'd_1',
      name: 'Alice',
      deviceName: 'DESKTOP'
    });
    await store.addTraffic(100, 200, recordedAt, { nodeName: 'Node A', durationMs: 5_000 });
    await store.markServerTotals({ totalUpload: 900, totalDownload: 1200 }, recordedAt);
    const pendingReport = await store.getOrCreatePendingReport(100, 200, recordedAt, {
      userId: 'u_1',
      deviceId: 'd_1'
    });

    await store.registerIdentity({
      userId: 'u_2',
      deviceId: 'd_2',
      name: 'Bob',
      deviceName: 'DESKTOP'
    });

    const snapshot = await store.getSnapshot(recordedAt);
    const persisted = await store.read();
    expect(pendingReport).toBeDefined();
    expect(snapshot.identity).toMatchObject({ userId: 'u_2', deviceId: 'd_2', name: 'Bob' });
    expect(snapshot.stats).toMatchObject({
      totalUpload: 0,
      totalDownload: 0,
      todayUpload: 0,
      todayDownload: 0,
      pendingUpload: 0,
      pendingDownload: 0,
      totalSource: 'local',
      nodeUsage: {},
      reportStatus: 'idle'
    });
    expect(snapshot.stats.serverSyncedAt).toBeUndefined();
    expect(persisted.pendingReport).toBeUndefined();
    expect(persisted.daily).toEqual({});
    expect(persisted.nodeUsage).toEqual({});
    expect(persisted.lastUpdatedAt).toBeUndefined();
    expect(persisted.lastReportedAt).toBeUndefined();
  });

  it('keeps identity-scoped traffic when the same verified identity registers again', async () => {
    const store = new TrafficStore(dir);
    const recordedAt = new Date('2026-05-10T08:00:00.000Z');

    await store.registerIdentity({
      userId: 'u_1',
      deviceId: 'd_1',
      name: 'Alice',
      deviceName: 'DESKTOP'
    });
    await store.addTraffic(100, 200, recordedAt, { nodeName: 'Node A', durationMs: 5_000 });
    await store.markServerTotals({ totalUpload: 900, totalDownload: 1200 }, recordedAt);
    const pendingReport = await store.getOrCreatePendingReport(100, 200, recordedAt, {
      userId: 'u_1',
      deviceId: 'd_1'
    });

    await store.registerIdentity({
      userId: 'u_1',
      deviceId: 'd_1',
      name: 'Alice',
      deviceName: 'DESKTOP-RENAMED'
    });

    const snapshot = await store.getSnapshot(recordedAt);
    const persisted = await store.read();
    expect(snapshot.stats).toMatchObject({
      totalUpload: 1000,
      totalDownload: 1400,
      todayUpload: 100,
      todayDownload: 200,
      pendingUpload: 100,
      pendingDownload: 200,
      totalSource: 'server',
      nodeUsage: {
        mostUsed: expect.objectContaining({ name: 'Node A' }),
        longestUsed: expect.objectContaining({ name: 'Node A' })
      }
    });
    expect(persisted.pendingReport).toEqual(pendingReport);
    expect(persisted.serverUserId).toBe('u_1');
    expect(persisted.serverDeviceId).toBe('d_1');
  });

  it('does not create a pending report for an identity that changed after the snapshot was read', async () => {
    const store = new TrafficStore(dir);
    await store.registerIdentity({
      userId: 'u_1',
      deviceId: 'd_1',
      name: 'Alice',
      deviceName: 'DESKTOP'
    });
    await store.addTraffic(100, 200, new Date('2026-05-10T08:00:00.000Z'));

    const stale = await store.getSnapshot();
    await store.registerIdentity({
      userId: 'u_2',
      deviceId: 'd_2',
      name: 'Bob',
      deviceName: 'DESKTOP'
    });

    await expect(
      store.getOrCreatePendingReport(stale.stats.pendingUpload, stale.stats.pendingDownload, new Date(), {
        userId: stale.identity!.userId,
        deviceId: stale.identity!.deviceId
      })
    ).resolves.toBeUndefined();
    await expect(store.getSnapshot()).resolves.toMatchObject({
      identity: { userId: 'u_2', deviceId: 'd_2' },
      stats: { pendingUpload: 0, pendingDownload: 0 }
    });
    expect((await store.read()).pendingReport).toBeUndefined();
  });

  it('can keep a pending local registration until activation succeeds later', async () => {
    const store = new TrafficStore(dir, { secretStorage: testSecretStorage });
    const recordedAt = new Date('2026-05-10T08:00:00.000Z');

    const pending = await store.registerPendingIdentity({
      name: '张三',
      passphrase: 'secret'
    });
    await store.addTraffic(100, 200, recordedAt, { nodeName: 'Node A', durationMs: 5_000 });

    expect(pending.verificationStatus).toBe('pending');
    await expect(store.getPendingRegistration()).resolves.toEqual({
      name: '张三',
      passphrase: 'secret'
    });

    const verified = await store.registerIdentity({
      userId: 'u_1',
      deviceId: 'd_1',
      name: '张三',
      deviceName: 'DESKTOP'
    });

    expect(verified.verificationStatus).toBe('verified');
    await expect(store.getPendingRegistration()).resolves.toBeUndefined();
    await expect(store.getSnapshot(recordedAt)).resolves.toMatchObject({
      identity: { userId: 'u_1', deviceId: 'd_1', verificationStatus: 'verified' },
      stats: {
        totalUpload: 100,
        totalDownload: 200,
        todayUpload: 100,
        todayDownload: 200,
        pendingUpload: 100,
        pendingDownload: 200,
        nodeUsage: {
          mostUsed: expect.objectContaining({ name: 'Node A' }),
          longestUsed: expect.objectContaining({ name: 'Node A' })
        }
      }
    });
  });

  it('can clear a failed pending registration so the gate can be shown again', async () => {
    const store = new TrafficStore(dir, { secretStorage: testSecretStorage });

    await store.registerPendingIdentity({
      name: '张三',
      passphrase: 'bad-secret'
    });
    await store.clearIdentity('traffic activation failed: 403 invalid passphrase');

    const snapshot = await store.getSnapshot();
    expect(snapshot.identity).toBeUndefined();
    expect(snapshot.stats.reportStatus).toBe('failed');
    expect(snapshot.stats.reportError).toBe('traffic activation failed: 403 invalid passphrase');
    await expect(store.getPendingRegistration()).resolves.toBeUndefined();
  });

  it('persists pending registration passphrases only as protected ciphertext', async () => {
    const store = new TrafficStore(dir, { secretStorage: testSecretStorage });

    await store.registerPendingIdentity({ name: 'Alice', passphrase: 'plain-secret' });

    const persisted = await readFile(join(dir, 'traffic.json'), 'utf8');
    expect(persisted).not.toContain('plain-secret');
    expect(persisted).not.toContain('"passphrase"');
    expect(persisted).toContain('"encryptedPassphrase"');
    await expect(store.getPendingRegistration()).resolves.toEqual({
      name: 'Alice',
      passphrase: 'plain-secret'
    });
  });

  it('migrates a legacy plaintext pending passphrase after it is read', async () => {
    await writeFile(
      join(dir, 'traffic.json'),
      `${JSON.stringify({
        version: 1,
        deviceSeed: 'seed-1',
        identity: {
          userId: 'pending:seed-1',
          deviceId: 'pending:seed-1',
          name: 'Alice',
          registeredAt: '2026-05-10T08:00:00.000Z',
          verificationStatus: 'pending'
        },
        pendingRegistration: { name: 'Alice', passphrase: 'legacy-secret' },
        totalUpload: 0,
        totalDownload: 0,
        pendingUpload: 0,
        pendingDownload: 0,
        daily: {},
        nodeUsage: {}
      })}\n`,
      'utf8'
    );
    const store = new TrafficStore(dir, { secretStorage: testSecretStorage });

    await expect(store.getPendingRegistration()).resolves.toEqual({
      name: 'Alice',
      passphrase: 'legacy-secret'
    });
    const persisted = await readFile(join(dir, 'traffic.json'), 'utf8');
    expect(persisted).not.toContain('legacy-secret');
    expect(persisted).toContain('"encryptedPassphrase"');
    expect(await readFile(join(dir, 'traffic.json.bak'), 'utf8')).not.toContain('legacy-secret');
  });

  it('removes a legacy plaintext secret when secure storage is unavailable', async () => {
    await writeFile(
      join(dir, 'traffic.json'),
      `${JSON.stringify({
        version: 1,
        deviceSeed: 'seed-1',
        identity: {
          userId: 'pending:seed-1',
          deviceId: 'pending:seed-1',
          name: 'Alice',
          registeredAt: '2026-05-10T08:00:00.000Z',
          verificationStatus: 'pending'
        },
        pendingRegistration: { name: 'Alice', passphrase: 'legacy-secret' },
        totalUpload: 0,
        totalDownload: 0,
        pendingUpload: 0,
        pendingDownload: 0,
        daily: {},
        nodeUsage: {}
      })}\n`,
      'utf8'
    );
    const store = new TrafficStore(dir);

    const snapshot = await store.getSnapshot();

    expect(snapshot.identity).toBeUndefined();
    expect(await readFile(join(dir, 'traffic.json'), 'utf8')).not.toContain('legacy-secret');
    expect(await readFile(join(dir, 'traffic.json.bak'), 'utf8')).not.toContain('legacy-secret');
  });

  it('does not preserve a corrupt traffic file that may contain a plaintext secret', async () => {
    await writeFile(join(dir, 'traffic.json'), '{"pendingRegistration":{"passphrase":"plain-secret"', 'utf8');
    await writeFile(join(dir, 'traffic.json.bak'), '{"pendingRegistration":{"passphrase":"backup-secret"', 'utf8');
    const store = new TrafficStore(dir);

    await store.getSnapshot();

    const entries = await readdir(dir);
    expect(entries.some((name) => name.startsWith('traffic.json.corrupt-'))).toBe(false);
    expect(await readFile(join(dir, 'traffic.json'), 'utf8')).not.toContain('plain-secret');
    const backup = await readFile(join(dir, 'traffic.json.bak'), 'utf8');
    expect(backup).not.toContain('plain-secret');
    expect(backup).not.toContain('backup-secret');
  });

  it('clears a pending identity when ciphertext can no longer be decrypted', async () => {
    const store = new TrafficStore(dir, { secretStorage: testSecretStorage });
    await store.registerPendingIdentity({ name: 'Alice', passphrase: 'protected-secret' });
    const unreadable = new TrafficStore(dir, {
      secretStorage: {
        ...testSecretStorage,
        decryptString: () => {
          throw new Error('key unavailable');
        }
      }
    });

    await expect(unreadable.getPendingRegistration()).resolves.toBeUndefined();
    expect((await unreadable.getSnapshot()).identity).toBeUndefined();
    expect(await readFile(join(dir, 'traffic.json'), 'utf8')).not.toContain('protected-secret');
  });

  it('repairs known damaged identity name JSON instead of dropping registration', async () => {
    await writeFile(
      join(dir, 'traffic.json'),
      `{
  "version": 1,
  "deviceSeed": "seed-1",
  "identity": {
    "userId": "u_1",
    "deviceId": "d_1",
    "name": "损坏姓名,
    "deviceName": "DESKTOP",
    "registeredAt": "2026-05-10T08:00:00.000Z",
    "verificationStatus": "verified"
  },
  "totalUpload": 12,
  "totalDownload": 34,
  "pendingUpload": 0,
  "pendingDownload": 0,
  "daily": {},
  "reportStatus": "synced"
}
`,
      'utf8'
    );

    const store = new TrafficStore(dir);
    const snapshot = await store.getSnapshot();

    expect(snapshot.identity).toMatchObject({
      userId: 'u_1',
      deviceId: 'd_1',
      name: '损坏姓名',
      verificationStatus: 'verified'
    });
    expect(JSON.parse(await readFile(join(dir, 'traffic.json'), 'utf8')).identity.name).toBe('损坏姓名');
  });
});
