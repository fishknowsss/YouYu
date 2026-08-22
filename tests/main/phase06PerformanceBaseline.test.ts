import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { PHASE_06_NODE_COUNTS, collectPhase06PerformanceBaseline } from '../../scripts/measure-phase06-performance';

describe('phase 06 performance baseline harness', () => {
  it('covers the required 500+ node scales without setting optimization thresholds', () => {
    expect(PHASE_06_NODE_COUNTS).toEqual([200, 500, 1000]);
  });

  it('reports update event, React render, input response, and IPC payload measurements', async () => {
    const baseline = await collectPhase06PerformanceBaseline({
      nodeCounts: [20],
      progressEventCount: 5,
      warmupSamples: 0,
      measuredSamples: 1
    });

    expect(baseline.updateProgress.ipcEvents).toBe(5);
    expect(baseline.updateProgress.totalIpcBytes).toBeGreaterThan(0);
    expect(baseline.updateProgress.liveRegionAnnouncementUpperBound).toBe(5);
    expect(baseline.nodes).toHaveLength(1);
    expect(baseline.nodes[0]).toMatchObject({ nodeCount: 20 });
    expect(baseline.nodes[0]?.snapshotPayloadBytes).toBeGreaterThan(0);
    expect(baseline.nodes[0]?.reactProfilerActualDurationMs.samples).toBe(1);
    expect(baseline.nodes[0]?.inputDispatchMs.samples).toBe(1);
    expect(baseline.optimizationsApplied).toEqual([]);
  });

  it('keeps a checked-in measurement record without converting observations into optimization gates', async () => {
    const baseline = JSON.parse(await readFile('docs/performance/phase06-baseline.json', 'utf8')) as {
      methodology: { progressEventCount: number; nodeCounts: number[] };
      nodes: Array<{ nodeCount: number; snapshotPayloadBytes: number }>;
      optimizationsApplied: string[];
    };

    expect(baseline.methodology).toMatchObject({ progressEventCount: 100, nodeCounts: [200, 500, 1000] });
    expect(baseline.nodes.map((entry) => entry.nodeCount)).toEqual([200, 500, 1000]);
    expect(baseline.nodes.every((entry) => entry.snapshotPayloadBytes > 0)).toBe(true);
    expect(baseline.optimizationsApplied).toEqual([]);
  });
});
