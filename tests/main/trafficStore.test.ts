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
