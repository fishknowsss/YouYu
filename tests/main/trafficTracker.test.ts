import { describe, expect, it } from 'vitest';
import { TrafficTracker } from '../../src/main/traffic/tracker';
import type { TrafficStore } from '../../src/main/traffic/store';
import type { RuntimeStats } from '../../src/shared/ipc';

describe('TrafficTracker', () => {
  it('filters remote desktop process traffic from reported deltas', async () => {
    const added: Array<{ upload: number; download: number }> = [];
    const samples: RuntimeStats[] = [
      {
        activeConnections: 1,
        uploadTotal: 100,
        downloadTotal: 1000,
        connections: [
          {
            id: 'remote-1',
            upload: 100,
            download: 1000,
            metadata: { process: 'ToDesk.exe' }
          }
        ]
      },
      {
        activeConnections: 1,
        uploadTotal: 160,
        downloadTotal: 1800,
        connections: [
          {
            id: 'remote-1',
            upload: 160,
            download: 1800,
            metadata: { process: 'ToDesk.exe' }
          }
        ]
      },
      {
        activeConnections: 1,
        uploadTotal: 210,
        downloadTotal: 2200,
        connections: [
          {
            id: 'normal-1',
            upload: 50,
            download: 400,
            metadata: { process: 'chrome.exe' }
          }
        ]
      }
    ];

    const tracker = new TrafficTracker({
      store: {
        addTraffic: async (upload: number, download: number) => {
          added.push({ upload, download });
        }
      } as unknown as TrafficStore,
      isRunning: () => true,
      readRuntimeStats: async () => samples.shift() ?? samples[0]
    });

    await tracker.flush();
    await tracker.flush();
    await tracker.flush();

    expect(added).toEqual([
      { upload: 0, download: 0 },
      { upload: 0, download: 0 },
      { upload: 50, download: 400 }
    ]);
  });
});
