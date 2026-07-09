import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TrafficStore } from '../../src/main/traffic/store';

let dir: string;

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

  it('can keep a pending local registration until activation succeeds later', async () => {
    const store = new TrafficStore(dir);

    const pending = await store.registerPendingIdentity({
      name: '张三',
      passphrase: 'secret'
    });

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
  });

  it('can clear a failed pending registration so the gate can be shown again', async () => {
    const store = new TrafficStore(dir);

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
