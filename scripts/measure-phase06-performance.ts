import { createElement, Profiler, act } from 'react';
import type { ProfilerOnRenderCallback } from 'react';
import { createRoot } from 'react-dom/client';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import {
  ipcChannels,
  type AppSnapshot,
  type AppUpdateSnapshot,
  type DesktopPetState,
  type ProxyNode
} from '../src/shared/ipc';
import { getUpdateDownloadPhase, normalizeUpdateBytes } from '../src/shared/updateProgress';
import { createAppWindowCoordinator } from '../src/main/appWindowCoordinator';
import { NodeList } from '../src/renderer/components/NodeList';
import { getNodeSelectRenderKey } from '../src/renderer/pages/NodeSelect';

export const PHASE_06_NODE_COUNTS = [200, 500, 1000] as const;

const DESKTOP_PET_STATES = [
  'idle',
  'walkRight',
  'walkLeft',
  'wave',
  'jump',
  'liftHold',
  'drag',
  'sleepWake',
  'focusWait',
  'happy',
  'edgeLeft',
  'edgeRight',
  'edgeLeftBlink',
  'edgeRightBlink',
  'edgeLeftSleep',
  'edgeRightSleep',
  'topSleep',
  'bottomSleep',
  'bottomDizzy',
  'bottomAngry',
  'fallRecover',
  'annoyed',
  'comfortSad',
  'rewardObserve'
] as const satisfies readonly DesktopPetState[];

const REPORT_ONLY_BUDGETS = {
  rendererSampleMs: 50,
  inputDispatchP95Ms: 100,
  mainIpcMaxBytes: 96 * 1024,
  noticeIpcMaxBytes: 512,
  petStateIpcMaxBytes: 128,
  liveRegionAnnouncementUpperBound: 12
} as const;

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

type IpcMessage = {
  channel: string;
  payload: unknown;
};

export async function collectPhase06PerformanceBaseline(options: BaselineOptions = {}) {
  const nodeCounts = options.nodeCounts ?? PHASE_06_NODE_COUNTS;
  const progressEventCount = options.progressEventCount ?? 100;
  const warmupSamples = options.warmupSamples ?? 2;
  const measuredSamples = options.measuredSamples ?? 5;
  const progressEvents = createProgressEvents(progressEventCount);
  const progressMeasurements = nodeCounts.map((nodeCount) => ({
    nodeCount,
    measurement: measureSync(() => processProgressEvents(progressEvents, nodeCount), warmupSamples, measuredSamples)
  }));

  const nodes = [];
  for (const nodeCount of nodeCounts) {
    const snapshot = createSnapshot(createNodes(nodeCount));
    const serializedSnapshot = JSON.stringify(snapshot);
    const render = await measureNodeRender(nodeCount, warmupSamples, measuredSamples);
    nodes.push({
      nodeCount,
      initialMountReactProfilerDurationMs: render.initialMountProfiler,
      initialMountWallMs: render.initialMountWall,
      initialMountSamplesOver50Ms: render.initialMountWallSamples.filter((duration) => duration > 50).length,
      updateReactProfilerDurationMs: render.updateProfiler,
      updateWallMs: render.updateWall,
      updateSamplesOver50Ms: render.updateWallSamples.filter((duration) => duration > 50).length,
      inputDispatchMs: render.input,
      renderKeyMs: measureSync(() => getNodeSelectRenderKey(snapshot), warmupSamples, measuredSamples).metric,
      snapshotPayloadBytes: Buffer.byteLength(serializedSnapshot),
      ipcSerializeMs: measureSync(() => JSON.stringify(snapshot), warmupSamples, measuredSamples).metric,
      ipcParseMs: measureSync(() => JSON.parse(serializedSnapshot), warmupSamples, measuredSamples).metric
    });
  }

  const petStatePayload = measurePetStatePayload();
  const observedBudgetExceedances: string[] = [];
  for (const node of nodes) {
    if (node.initialMountWallMs.p95 > REPORT_ONLY_BUDGETS.rendererSampleMs) {
      observedBudgetExceedances.push(`${node.nodeCount}-node initial mount p95 exceeded renderer sample budget`);
    }
    if (node.updateWallMs.p95 > REPORT_ONLY_BUDGETS.rendererSampleMs) {
      observedBudgetExceedances.push(`${node.nodeCount}-node update p95 exceeded renderer sample budget`);
    }
    if (node.inputDispatchMs.p95 > REPORT_ONLY_BUDGETS.inputDispatchP95Ms) {
      observedBudgetExceedances.push(`${node.nodeCount}-node input dispatch p95 exceeded input budget`);
    }
  }
  for (const { nodeCount, measurement } of progressMeasurements) {
    if (measurement.value.windowFanout.main.maxIpcBytes > REPORT_ONLY_BUDGETS.mainIpcMaxBytes) {
      observedBudgetExceedances.push(`${nodeCount}-node main progress payload exceeded IPC budget`);
    }
    if (measurement.value.windowFanout.notice.maxIpcBytes > REPORT_ONLY_BUDGETS.noticeIpcMaxBytes) {
      observedBudgetExceedances.push(`${nodeCount}-node notice progress payload exceeded IPC budget`);
    }
  }
  if (petStatePayload.maxIpcBytes > REPORT_ONLY_BUDGETS.petStateIpcMaxBytes) {
    observedBudgetExceedances.push('pet state payload exceeded IPC budget');
  }
  if (progressEventCount > REPORT_ONLY_BUDGETS.liveRegionAnnouncementUpperBound) {
    observedBudgetExceedances.push('progress live-region candidate count exceeded report-only budget');
  }

  return {
    schemaVersion: 2,
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
      rendererMeasurement:
        'React Profiler in jsdom; fresh roots measure initial mount, a warmed root measures updates, and input dispatch is a synthetic MouseEvent proxy',
      ipcMeasurement:
        'UTF-8 JSON envelope proxy for Electron structured-clone payload cost; main and notice use the production window coordinator, while pet progress fan-out is expected to remain zero',
      liveRegionMeasurement: 'aria-live atomic update upper bound; no screen-reader automation',
      budgetPolicy:
        'report only; observations are not CI gates and do not authorize production optimization by themselves'
    },
    updateProgress: {
      byNodeCount: progressMeasurements.map(({ nodeCount, measurement }) => ({
        nodeCount,
        processingMs: measurement.metric,
        windowFanout: measurement.value.windowFanout
      })),
      petStatePayload,
      liveRegionAnnouncementUpperBound: progressEventCount
    },
    nodes,
    reportOnlyBudgets: REPORT_ONLY_BUDGETS,
    observedBudgetExceedances,
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

function processProgressEvents(events: ProgressEvent[], nodeCount: number) {
  let previousPercent: number | undefined;
  let previousPhase: AppUpdateSnapshot['downloadPhase'];
  const mainMessages: IpcMessage[] = [];
  const noticeMessages: IpcMessage[] = [];
  const petMessages: IpcMessage[] = [];
  const mainWindow = createMeasurementWindow(mainMessages);
  const noticeWindow = createMeasurementWindow(noticeMessages);
  const petWindow = createMeasurementWindow(petMessages);
  const nodes = createNodes(nodeCount);
  const coordinator = createAppWindowCoordinator({
    getMainWindow: () => mainWindow,
    getNoticeWindow: () => noticeWindow,
    getPetWindow: () => petWindow,
    createNoticeWindow: async () => noticeWindow,
    isPetFeatureEnabled: () => true,
    isPetFullscreenSuppressed: () => false,
    isCleanupStarted: () => false,
    isQuitting: () => false,
    screen: {
      getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
      getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } })
    },
    noticeWindowSize: { width: 360, height: 180 },
    onNoticeExpired: async () => undefined,
    onError: () => undefined
  });

  try {
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
      coordinator.send(createSnapshot(nodes, update));
    }
  } finally {
    coordinator.dispose();
  }

  return {
    windowFanout: {
      main: summarizeIpcMessages(mainMessages),
      notice: summarizeIpcMessages(noticeMessages),
      pet: summarizeIpcMessages(petMessages)
    },
    liveRegionAnnouncementUpperBound: events.length
  };
}

function measurePetStatePayload() {
  const sizes = DESKTOP_PET_STATES.map((state) =>
    ipcMessageBytes({ channel: ipcChannels.petStateUpdated, payload: state })
  );
  return {
    referenceStateCount: DESKTOP_PET_STATES.length,
    minIpcBytes: Math.min(...sizes),
    maxIpcBytes: Math.max(...sizes)
  };
}

function createMeasurementWindow(messages: IpcMessage[]) {
  return {
    isDestroyed: () => false,
    isVisible: () => true,
    getBounds: () => ({ x: 0, y: 0, width: 128, height: 128 }),
    setBounds: () => undefined,
    showInactive: () => undefined,
    hide: () => undefined,
    webContents: {
      send: (channel: string, payload: unknown) => messages.push({ channel, payload }),
      isLoading: () => false
    }
  };
}

function ipcMessageBytes(message: IpcMessage): number {
  return Buffer.byteLength(JSON.stringify({ channel: message.channel, args: [message.payload] }));
}

function summarizeIpcMessages(messages: IpcMessage[]) {
  const sizes = messages.map(ipcMessageBytes);
  const totalIpcBytes = sizes.reduce((total, size) => total + size, 0);
  return {
    ipcEvents: messages.length,
    totalIpcBytes,
    averageIpcBytes: messages.length === 0 ? 0 : Math.round(totalIpcBytes / messages.length),
    maxIpcBytes: Math.max(0, ...sizes)
  };
}

async function measureNodeRender(nodeCount: number, warmupSamples: number, measuredSamples: number) {
  return withMeasurementDom(async (dom) => {
    const initialMountProfilerSamples: number[] = [];
    const initialMountWallSamples: number[] = [];

    async function mountSample(record: boolean, sequence: number): Promise<void> {
      const container = dom.window.document.createElement('div');
      dom.window.document.body.append(container);
      const root = createRoot(container);
      let profilerDuration = 0;
      const wallStart = performance.now();
      await act(async () => {
        root.render(
          createElement(
            Profiler,
            {
              id: `node-list-mount-${nodeCount}`,
              onRender: (_id, _phase, actualDuration) => {
                profilerDuration = actualDuration;
              }
            },
            createElement(NodeList, {
              nodes: createNodes(nodeCount, sequence),
              selectionBusy: false,
              testingBusy: false,
              onSelect: () => undefined,
              onTestNode: () => undefined
            })
          )
        );
      });
      const wallDuration = performance.now() - wallStart;
      if (record) {
        initialMountProfilerSamples.push(profilerDuration);
        initialMountWallSamples.push(wallDuration);
      }
      await act(async () => root.unmount());
      container.remove();
    }

    let mountSequence = 0;
    for (let index = 0; index < warmupSamples; index += 1) await mountSample(false, (mountSequence += 1));
    for (let index = 0; index < measuredSamples; index += 1) await mountSample(true, (mountSequence += 1));

    const updateContainer = dom.window.document.createElement('div');
    dom.window.document.body.append(updateContainer);
    const updateRoot = createRoot(updateContainer);
    const updateProfilerSamples: number[] = [];
    const updateWallSamples: number[] = [];
    const inputSamples: number[] = [];
    let latestProfilerDuration = 0;
    let renderSequence = 0;
    let selectedNode = '';
    const onUpdateRender: ProfilerOnRenderCallback = (_id, _phase, actualDuration) => {
      latestProfilerDuration = actualDuration;
    };

    async function updateSample(record: boolean): Promise<void> {
      renderSequence += 1;
      const nodes = createNodes(nodeCount, renderSequence);
      const wallStart = performance.now();
      await act(async () => {
        updateRoot.render(
          createElement(
            Profiler,
            { id: `node-list-update-${nodeCount}`, onRender: onUpdateRender },
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
      const target = updateContainer.querySelectorAll<HTMLButtonElement>('.node-main').item(nodeCount - 1);
      const inputStart = performance.now();
      await act(async () => {
        target.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
      });
      const inputDuration = performance.now() - inputStart;
      if (selectedNode !== `节点 ${nodeCount}`) throw new Error(`node input dispatch failed for ${nodeCount} nodes`);
      if (record) {
        updateProfilerSamples.push(latestProfilerDuration);
        updateWallSamples.push(wallDuration);
        inputSamples.push(inputDuration);
      }
    }

    try {
      await updateSample(false);
      for (let index = 0; index < warmupSamples; index += 1) await updateSample(false);
      for (let index = 0; index < measuredSamples; index += 1) await updateSample(true);
    } finally {
      await act(async () => updateRoot.unmount());
      updateContainer.remove();
    }

    return {
      initialMountProfiler: summarize(initialMountProfilerSamples),
      initialMountWall: summarize(initialMountWallSamples),
      initialMountWallSamples,
      updateProfiler: summarize(updateProfilerSamples),
      updateWall: summarize(updateWallSamples),
      updateWallSamples,
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
    userNotice: {
      revision: 7,
      message: '用于性能基线的通知消息',
      tone: 'info',
      expiresAt: '2099-01-01T00:00:00.000Z',
      updatedAt: '2026-08-22T00:00:00.000Z'
    },
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
