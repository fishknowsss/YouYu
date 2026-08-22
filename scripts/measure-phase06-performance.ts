import { createElement, Profiler, act } from 'react';
import type { ProfilerOnRenderCallback } from 'react';
import { createRoot } from 'react-dom/client';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import type { AppSnapshot, AppUpdateSnapshot, ProxyNode } from '../src/shared/ipc';
import { getUpdateDownloadPhase, normalizeUpdateBytes } from '../src/shared/updateProgress';
import { NodeList } from '../src/renderer/components/NodeList';
import { getNodeSelectRenderKey } from '../src/renderer/pages/NodeSelect';

export const PHASE_06_NODE_COUNTS = [200, 500, 1000] as const;

type MeasurementDom = {
  window: {
    document: Document;
    navigator: Navigator;
    HTMLElement: typeof HTMLElement;
    Node: typeof Node;
    Event: typeof Event;
    MouseEvent: typeof MouseEvent;
    close: () => void;
  };
};

const { JSDOM } = createRequire(import.meta.url)('jsdom') as {
  JSDOM: new (html: string, options: { url: string }) => MeasurementDom;
};

type MetricSummary = {
  samples: number;
  median: number;
  p95: number;
  max: number;
};

type BaselineOptions = {
  nodeCounts?: readonly number[];
  progressEventCount?: number;
  warmupSamples?: number;
  measuredSamples?: number;
};

type ProgressEvent = {
  percent: number;
  transferred: number;
  total: number;
  bytesPerSecond: number;
};

export async function collectPhase06PerformanceBaseline(options: BaselineOptions = {}) {
  const nodeCounts = options.nodeCounts ?? PHASE_06_NODE_COUNTS;
  const progressEventCount = options.progressEventCount ?? 100;
  const warmupSamples = options.warmupSamples ?? 2;
  const measuredSamples = options.measuredSamples ?? 5;
  const progressEvents = createProgressEvents(progressEventCount);
  const progressMeasurement = measureSync(() => processProgressEvents(progressEvents), warmupSamples, measuredSamples);

  const nodes = [];
  for (const nodeCount of nodeCounts) {
    const snapshot = createSnapshot(createNodes(nodeCount));
    const serializedSnapshot = JSON.stringify(snapshot);
    const render = await measureNodeRender(nodeCount, warmupSamples, measuredSamples);
    nodes.push({
      nodeCount,
      reactProfilerActualDurationMs: render.profiler,
      renderWallMs: render.wall,
      longTaskSamplesOver50Ms: render.wallSamples.filter((duration) => duration > 50).length,
      inputDispatchMs: render.input,
      renderKeyMs: measureSync(() => getNodeSelectRenderKey(snapshot), warmupSamples, measuredSamples).metric,
      snapshotPayloadBytes: Buffer.byteLength(serializedSnapshot),
      ipcSerializeMs: measureSync(() => JSON.stringify(snapshot), warmupSamples, measuredSamples).metric,
      ipcParseMs: measureSync(() => JSON.parse(serializedSnapshot), warmupSamples, measuredSamples).metric
    });
  }

  return {
    schemaVersion: 1,
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch
    },
    methodology: {
      progressEventCount,
      nodeCounts: [...nodeCounts],
      warmupSamples,
      measuredSamples,
      rendererMeasurement: 'React Profiler in jsdom; input dispatch is a synthetic MouseEvent proxy',
      ipcMeasurement: 'UTF-8 JSON serialization proxy for Electron structured-clone payload cost',
      liveRegionMeasurement: 'aria-live atomic update upper bound; no screen-reader automation'
    },
    updateProgress: {
      processingMs: progressMeasurement.metric,
      ipcEvents: progressMeasurement.value.ipcEvents,
      totalIpcBytes: progressMeasurement.value.totalIpcBytes,
      averageIpcBytes: progressMeasurement.value.averageIpcBytes,
      maxIpcBytes: progressMeasurement.value.maxIpcBytes,
      liveRegionAnnouncementUpperBound: progressMeasurement.value.liveRegionAnnouncementUpperBound
    },
    nodes,
    optimizationsApplied: [] as string[]
  };
}

function createProgressEvents(count: number): ProgressEvent[] {
  const total = 100 * 1024 * 1024;
  return Array.from({ length: count }, (_, index) => {
    const percent = ((index + 1) / count) * 100;
    return {
      percent,
      transferred: Math.round((total * percent) / 100),
      total,
      bytesPerSecond: 3 * 1024 * 1024
    };
  });
}

function processProgressEvents(events: ProgressEvent[]) {
  let previousPercent: number | undefined;
  let previousPhase: AppUpdateSnapshot['downloadPhase'];
  let totalIpcBytes = 0;
  let maxIpcBytes = 0;

  for (const event of events) {
    const update: AppUpdateSnapshot = {
      currentVersion: '1.7.13',
      buildChannel: 'standard',
      updateChannel: 'latest',
      status: 'downloading',
      availableVersion: '1.7.14',
      percent: event.percent,
      downloadPhase: getUpdateDownloadPhase({
        previousPercent,
        previousPhase,
        percent: event.percent
      }),
      transferredBytes: normalizeUpdateBytes(event.transferred),
      totalBytes: normalizeUpdateBytes(event.total),
      bytesPerSecond: normalizeUpdateBytes(event.bytesPerSecond)
    };
    previousPercent = update.percent;
    previousPhase = update.downloadPhase;
    const payload = JSON.stringify({ channel: 'app:snapshot-updated', args: [createSnapshot(createNodes(1), update)] });
    const bytes = Buffer.byteLength(payload);
    totalIpcBytes += bytes;
    maxIpcBytes = Math.max(maxIpcBytes, bytes);
  }

  return {
    ipcEvents: events.length,
    totalIpcBytes,
    averageIpcBytes: events.length === 0 ? 0 : Math.round(totalIpcBytes / events.length),
    maxIpcBytes,
    liveRegionAnnouncementUpperBound: events.length
  };
}

async function measureNodeRender(nodeCount: number, warmupSamples: number, measuredSamples: number) {
  return withMeasurementDom(async (dom) => {
    const container = dom.window.document.createElement('div');
    dom.window.document.body.append(container);
    const root = createRoot(container);
    const profilerSamples: number[] = [];
    const wallSamples: number[] = [];
    const inputSamples: number[] = [];
    let latestProfilerDuration = 0;
    let renderSequence = 0;
    let selectedNode = '';
    const onRender: ProfilerOnRenderCallback = (_id, _phase, actualDuration) => {
      latestProfilerDuration = actualDuration;
    };

    async function renderSample(record: boolean): Promise<void> {
      renderSequence += 1;
      const nodes = createNodes(nodeCount, renderSequence);
      const wallStart = performance.now();
      await act(async () => {
        root.render(
          createElement(
            Profiler,
            { id: `node-list-${nodeCount}`, onRender },
            createElement(NodeList, {
              nodes,
              selectionBusy: false,
              testingBusy: false,
              onSelect: (name) => {
                selectedNode = name;
              },
              onTestNode: () => undefined
            })
          )
        );
      });
      const wallDuration = performance.now() - wallStart;
      const target = container.querySelectorAll<HTMLButtonElement>('.node-main').item(nodeCount - 1);
      const inputStart = performance.now();
      await act(async () => {
        target.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
      });
      const inputDuration = performance.now() - inputStart;
      if (selectedNode !== `节点 ${nodeCount}`) throw new Error(`node input dispatch failed for ${nodeCount} nodes`);
      if (record) {
        profilerSamples.push(latestProfilerDuration);
        wallSamples.push(wallDuration);
        inputSamples.push(inputDuration);
      }
    }

    try {
      for (let index = 0; index < warmupSamples; index += 1) await renderSample(false);
      for (let index = 0; index < measuredSamples; index += 1) await renderSample(true);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }

    return {
      profiler: summarize(profilerSamples),
      wall: summarize(wallSamples),
      wallSamples,
      input: summarize(inputSamples)
    };
  });
}

async function withMeasurementDom<T>(run: (dom: MeasurementDom) => Promise<T>): Promise<T> {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://127.0.0.1/' });
  const replacements: Record<string, unknown> = {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    Event: dom.window.Event,
    MouseEvent: dom.window.MouseEvent,
    IS_REACT_ACT_ENVIRONMENT: true
  };
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries(replacements)) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  try {
    return await run(dom);
  } finally {
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  }
}

function createNodes(count: number, sequence = 0): ProxyNode[] {
  return Array.from({ length: count }, (_, index) => ({
    name: `节点 ${index + 1}`,
    delay: 20 + ((index + sequence) % 480),
    active: index === 0,
    testState: 'tested' as const
  }));
}

function createSnapshot(nodes: ProxyNode[], update?: AppUpdateSnapshot): AppSnapshot {
  return {
    status: 'running',
    currentNode: nodes[0]?.name ?? '自动选择',
    nodes,
    nodeHealth: {
      nodeName: nodes[0]?.name ?? '自动选择',
      delayStatus: 'measured',
      delay: nodes[0]?.delay,
      availability: {
        status: 'measured',
        totalCount: nodes.length,
        availableCount: nodes.length,
        percent: nodes.length > 0 ? 100 : 0,
        tone: 'success'
      }
    },
    strategies: [{ key: 'auto', label: '自动', target: '自动选择', active: true }],
    mode: 'rule',
    strategy: 'auto',
    ruleProfile: 'ruleset',
    features: {
      systemProxyEnabled: true,
      dnsEnhanced: true,
      snifferEnabled: true,
      tunEnabled: false,
      strictRouteEnabled: true,
      allowLan: false,
      subscriptionRefreshIntervalHours: 12
    },
    runtime: { activeConnections: 0, uploadTotal: 0, downloadTotal: 0 },
    traffic: {
      totalUpload: 0,
      totalDownload: 0,
      todayUpload: 0,
      todayDownload: 0,
      pendingUpload: 0,
      pendingDownload: 0,
      nodeUsage: {},
      reportStatus: 'idle'
    },
    subscriptionUrl: 'https://example.invalid/subscription',
    subscriptionRevision: 1,
    update: update ?? {
      currentVersion: '1.7.13',
      buildChannel: 'standard',
      updateChannel: 'latest',
      status: 'idle'
    },
    diagnostics: { logs: [] }
  };
}

function measureSync<T>(run: () => T, warmupSamples: number, measuredSamples: number) {
  for (let index = 0; index < warmupSamples; index += 1) run();
  const durations: number[] = [];
  let value!: T;
  for (let index = 0; index < measuredSamples; index += 1) {
    const start = performance.now();
    value = run();
    durations.push(performance.now() - start);
  }
  return { metric: summarize(durations), value };
}

function summarize(values: number[]): MetricSummary {
  const sorted = [...values].sort((left, right) => left - right);
  const percentile = (fraction: number) =>
    sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
  return {
    samples: sorted.length,
    median: round(percentile(0.5)),
    p95: round(percentile(0.95)),
    max: round(sorted.at(-1) ?? 0)
  };
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  collectPhase06PerformanceBaseline()
    .then((baseline) => console.log(JSON.stringify(baseline, null, 2)))
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
