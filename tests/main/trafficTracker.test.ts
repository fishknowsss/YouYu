import { afterEach, describe, expect, it, vi } from 'vitest';
import { TrafficTracker } from '../../src/main/traffic/tracker';
import type { TrafficStore } from '../../src/main/traffic/store';
import type { RuntimeStats } from '../../src/shared/ipc';

afterEach(() => {
  vi.restoreAllMocks();
});

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

  it('subtracts all counters from a remote desktop connection first observed after the baseline', async () => {
    const added: Array<{ upload: number; download: number }> = [];
    const samples: RuntimeStats[] = [
      { activeConnections: 0, uploadTotal: 100, downloadTotal: 1000, connections: [] },
      {
        activeConnections: 1,
        uploadTotal: 250,
        downloadTotal: 1450,
        connections: [
          {
            id: 'remote-new',
            upload: 100,
            download: 400,
            metadata: { processPath: 'C:\\Program Files\\ToDesk\\ToDesk.exe' }
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

    expect(added).toEqual([
      { upload: 0, download: 0 },
      { upload: 50, download: 50 }
    ]);
  });

  it('retries from the last persisted sampling baseline after a traffic write fails', async () => {
    vi.spyOn(Date, 'now').mockReturnValueOnce(1000).mockReturnValueOnce(2000).mockReturnValueOnce(3000);
    const samples: RuntimeStats[] = [
      { activeConnections: 0, uploadTotal: 100, downloadTotal: 1000, connections: [] },
      {
        activeConnections: 1,
        uploadTotal: 180,
        downloadTotal: 1500,
        connections: [
          {
            id: 'remote-new',
            upload: 60,
            download: 400,
            metadata: { process: 'ToDesk.exe' }
          }
        ]
      },
      {
        activeConnections: 1,
        uploadTotal: 250,
        downloadTotal: 1900,
        connections: [
          {
            id: 'remote-new',
            upload: 90,
            download: 600,
            metadata: { process: 'ToDesk.exe' }
          }
        ]
      }
    ];
    const nodes = ['Node A', 'Node B', 'Node C'];
    let writeCount = 0;
    const addTraffic = vi.fn(
      async (_upload: number, _download: number, _now: Date, _usage?: { nodeName?: string; durationMs?: number }) => {
        writeCount += 1;
        if (writeCount === 2) throw new Error('disk full');
      }
    );
    const tracker = new TrafficTracker({
      store: { addTraffic } as unknown as TrafficStore,
      isRunning: () => true,
      readRuntimeStats: async () => samples.shift() ?? samples[0],
      readCurrentNode: async () => nodes.shift() ?? 'Node C'
    });

    await tracker.flush();
    await expect(tracker.flush()).rejects.toThrow('disk full');
    await tracker.flush();

    expect(addTraffic.mock.calls.map(([upload, download, , usage]) => ({ upload, download, ...usage }))).toEqual([
      { upload: 0, download: 0, nodeName: 'Node A', durationMs: 0 },
      { upload: 20, download: 100, nodeName: 'Node A', durationMs: 1000 },
      { upload: 60, download: 300, nodeName: 'Node A', durationMs: 2000 }
    ]);
  });

  it('attributes each sampling interval to the previous active node', async () => {
    const added: Array<{ upload: number; download: number; nodeName?: string }> = [];
    const samples: RuntimeStats[] = [
      { activeConnections: 1, uploadTotal: 100, downloadTotal: 1000, connections: [] },
      { activeConnections: 1, uploadTotal: 150, downloadTotal: 1400, connections: [] },
      { activeConnections: 1, uploadTotal: 180, downloadTotal: 1600, connections: [] }
    ];
    const nodes = ['Node A', 'Node B', 'Node B'];

    const tracker = new TrafficTracker({
      store: {
        addTraffic: async (upload: number, download: number, _now: Date, usage?: { nodeName?: string }) => {
          added.push({ upload, download, nodeName: usage?.nodeName });
        }
      } as unknown as TrafficStore,
      isRunning: () => true,
      readRuntimeStats: async () => samples.shift() ?? samples[0],
      readCurrentNode: async () => nodes.shift() ?? 'Node B'
    });

    await tracker.flush();
    await tracker.flush();
    await tracker.flush();

    expect(added).toEqual([
      { upload: 0, download: 0, nodeName: 'Node A' },
      { upload: 50, download: 400, nodeName: 'Node A' },
      { upload: 30, download: 200, nodeName: 'Node B' }
    ]);
  });

  it('shares an in-flight sample and ignores it after stop', async () => {
    let resolveStats: ((stats: RuntimeStats) => void) | undefined;
    const stats = new Promise<RuntimeStats>((resolve) => {
      resolveStats = resolve;
    });
    const addTraffic = vi.fn(async () => undefined);
    let running = true;
    const tracker = new TrafficTracker({
      store: { addTraffic } as unknown as TrafficStore,
      isRunning: () => running,
      readRuntimeStats: vi.fn(() => stats)
    });

    const first = tracker.flush();
    const second = tracker.flush();
    running = false;
    tracker.stop();
    resolveStats?.({ activeConnections: 0, uploadTotal: 100, downloadTotal: 200 });
    await Promise.all([first, second]);

    expect(addTraffic).not.toHaveBeenCalled();
  });
});
