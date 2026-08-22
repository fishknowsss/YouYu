import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { PHASE_06_NODE_COUNTS, collectPhase06PerformanceBaseline } from '../../scripts/measure-phase06-performance';

describe('phase 06 performance baseline harness', () => {
  it('covers the required 500+ node scales without setting optimization thresholds', () => {
    expect(PHASE_06_NODE_COUNTS).toEqual([200, 500, 1000]);
  });

  it('reports update fan-out, mount/update rendering, input response, and IPC payload measurements', async () => {
    const baseline = await collectPhase06PerformanceBaseline({
      nodeCounts: [20],
      progressEventCount: 5,
      warmupSamples: 0,
      measuredSamples: 1
    });

    expect(baseline.updateProgress.byNodeCount).toHaveLength(1);
    expect(baseline.updateProgress.byNodeCount[0]?.nodeCount).toBe(20);
    expect(baseline.updateProgress.byNodeCount[0]?.windowFanout.main.ipcEvents).toBe(5);
    expect(baseline.updateProgress.byNodeCount[0]?.windowFanout.main.totalIpcBytes).toBeGreaterThan(0);
    expect(baseline.updateProgress.byNodeCount[0]?.windowFanout.notice.ipcEvents).toBe(5);
    expect(baseline.updateProgress.byNodeCount[0]?.windowFanout.notice.totalIpcBytes).toBeGreaterThan(0);
    expect(baseline.updateProgress.byNodeCount[0]?.windowFanout.pet).toMatchObject({
      ipcEvents: 0,
      totalIpcBytes: 0
    });
    expect(baseline.updateProgress.petStatePayload.referenceStateCount).toBeGreaterThan(0);
    expect(baseline.updateProgress.petStatePayload.minIpcBytes).toBeGreaterThan(0);
    expect(baseline.updateProgress.petStatePayload.maxIpcBytes).toBeGreaterThanOrEqual(
      baseline.updateProgress.petStatePayload.minIpcBytes
    );
    expect(baseline.updateProgress.liveRegionAnnouncementUpperBound).toBe(5);
    expect(baseline.nodes).toHaveLength(1);
    expect(baseline.nodes[0]).toMatchObject({ nodeCount: 20 });
    expect(baseline.nodes[0]?.snapshotPayloadBytes).toBeGreaterThan(0);
    expect(baseline.nodes[0]?.initialMountReactProfilerDurationMs.samples).toBe(1);
    expect(baseline.nodes[0]?.initialMountWallMs.samples).toBe(1);
    expect(baseline.nodes[0]?.updateReactProfilerDurationMs.samples).toBe(1);
    expect(baseline.nodes[0]?.updateWallMs.samples).toBe(1);
    expect(baseline.nodes[0]?.inputDispatchMs.samples).toBe(1);
    expect(baseline.reportOnlyBudgets).toMatchObject({ rendererSampleMs: 50, inputDispatchP95Ms: 100 });
    expect(Array.isArray(baseline.observedBudgetExceedances)).toBe(true);
    expect(baseline.optimizationsApplied).toEqual([]);
  });

  it('keeps a checked-in measurement record without converting observations into optimization gates', async () => {
    const baseline = JSON.parse(await readFile('docs/performance/phase06-baseline.json', 'utf8')) as {
      schemaVersion: number;
      methodology: { progressEventCount: number; nodeCounts: number[] };
      updateProgress: {
        byNodeCount: Array<{
          nodeCount: number;
          windowFanout: Record<'main' | 'notice' | 'pet', { ipcEvents: number; totalIpcBytes: number }>;
        }>;
      };
      nodes: Array<{
        nodeCount: number;
        snapshotPayloadBytes: number;
        initialMountWallMs: { samples: number };
        updateWallMs: { samples: number };
      }>;
      observedBudgetExceedances: string[];
      optimizationsApplied: string[];
    };

    expect(baseline.schemaVersion).toBe(2);
    expect(baseline.methodology).toMatchObject({ progressEventCount: 100, nodeCounts: [200, 500, 1000] });
    expect(baseline.updateProgress.byNodeCount.map((entry) => entry.nodeCount)).toEqual([200, 500, 1000]);
    for (const entry of baseline.updateProgress.byNodeCount) {
      expect(entry.windowFanout.main.ipcEvents).toBe(100);
      expect(entry.windowFanout.notice.ipcEvents).toBe(100);
      expect(entry.windowFanout.pet).toEqual(expect.objectContaining({ ipcEvents: 0, totalIpcBytes: 0 }));
    }
    expect(baseline.nodes.map((entry) => entry.nodeCount)).toEqual([200, 500, 1000]);
    expect(baseline.nodes.every((entry) => entry.snapshotPayloadBytes > 0)).toBe(true);
    expect(baseline.nodes.every((entry) => entry.initialMountWallMs.samples > 0)).toBe(true);
    expect(baseline.nodes.every((entry) => entry.updateWallMs.samples > 0)).toBe(true);
    expect(Array.isArray(baseline.observedBudgetExceedances)).toBe(true);
    expect(baseline.optimizationsApplied).toEqual([]);
  });
});
