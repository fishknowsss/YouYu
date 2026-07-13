import type { RuntimeConnectionStats, RuntimeStats } from '../../shared/ipc';
import { remoteDesktopProcessNames } from '../mihomo/config';
import type { TrafficStore } from './store';

type TrafficTrackerOptions = {
  store: TrafficStore;
  readRuntimeStats: () => Promise<RuntimeStats>;
  readCurrentNode?: () => Promise<string>;
  isRunning: () => boolean;
  intervalMs?: number;
  onSample?: () => void;
  onError?: (error: unknown) => void;
};

export class TrafficTracker {
  private timer: ReturnType<typeof setInterval> | undefined;
  private lastUpload = 0;
  private lastDownload = 0;
  private lastSampleAt = 0;
  private lastNode: string | undefined;
  private excludedConnections = new Map<string, { upload: number; download: number }>();
  private sampling: Promise<void> | undefined;
  private generation = 0;

  constructor(private readonly options: TrafficTrackerOptions) {}

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.sample().catch((error) => this.options.onError?.(error));
    }, this.options.intervalMs ?? 10000);
    void this.sample().catch((error) => this.options.onError?.(error));
  }

  stop() {
    this.generation += 1;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.lastUpload = 0;
    this.lastDownload = 0;
    this.lastSampleAt = 0;
    this.lastNode = undefined;
    this.excludedConnections.clear();
  }

  async flush() {
    await this.sample();
  }

  private async sample() {
    if (this.sampling) return this.sampling;
    const generation = this.generation;
    const sampling = this.sampleOnce(generation);
    this.sampling = sampling;
    try {
      await sampling;
    } finally {
      if (this.sampling === sampling) this.sampling = undefined;
    }
  }

  private async sampleOnce(generation: number) {
    if (!this.options.isRunning()) {
      this.lastUpload = 0;
      this.lastDownload = 0;
      this.lastSampleAt = 0;
      this.lastNode = undefined;
      this.excludedConnections.clear();
      return;
    }

    const sampledAt = Date.now();
    const [stats, currentNode] = await Promise.all([
      this.options.readRuntimeStats(),
      this.options.readCurrentNode?.().catch(() => undefined)
    ]);
    if (generation !== this.generation || !this.options.isRunning()) return;
    const uploadDelta =
      this.lastUpload > 0 && stats.uploadTotal >= this.lastUpload ? stats.uploadTotal - this.lastUpload : 0;
    const downloadDelta =
      this.lastDownload > 0 && stats.downloadTotal >= this.lastDownload ? stats.downloadTotal - this.lastDownload : 0;
    const durationMs = this.lastSampleAt > 0 ? Math.max(0, sampledAt - this.lastSampleAt) : 0;
    const sampledNode = this.lastNode ?? currentNode;
    const excludedSample = this.collectExcludedDelta(stats.connections ?? []);

    await this.options.store.addTraffic(
      Math.max(0, uploadDelta - excludedSample.upload),
      Math.max(0, downloadDelta - excludedSample.download),
      new Date(sampledAt),
      { nodeName: sampledNode, durationMs }
    );
    if (generation !== this.generation || !this.options.isRunning()) return;
    this.lastUpload = stats.uploadTotal;
    this.lastDownload = stats.downloadTotal;
    this.lastSampleAt = sampledAt;
    this.lastNode = currentNode;
    this.excludedConnections = excludedSample.connections;
    this.options.onSample?.();
  }

  private collectExcludedDelta(connections: RuntimeConnectionStats[]) {
    const nextConnections = new Map<string, { upload: number; download: number }>();
    let upload = 0;
    let download = 0;

    for (const connection of connections) {
      if (!isExcludedConnection(connection)) continue;

      const key = getConnectionKey(connection);
      const currentUpload = normalizeBytes(connection.upload);
      const currentDownload = normalizeBytes(connection.download);
      const previous = this.excludedConnections.get(key);
      upload += previous && currentUpload >= previous.upload ? currentUpload - previous.upload : currentUpload;
      download +=
        previous && currentDownload >= previous.download ? currentDownload - previous.download : currentDownload;
      nextConnections.set(key, {
        upload: currentUpload,
        download: currentDownload
      });
    }

    return { upload, download, connections: nextConnections };
  }
}

const excludedProcessNames = new Set(remoteDesktopProcessNames.map((name) => name.toLowerCase()));

function isExcludedConnection(connection: RuntimeConnectionStats): boolean {
  return [connection.metadata?.process, connection.metadata?.processPath]
    .map((value) => normalizeProcessName(value))
    .some((name) => Boolean(name && excludedProcessNames.has(name)));
}

function normalizeProcessName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (!text) return undefined;
  const parts = text.split(/[\\/]/);
  return (parts.at(-1) ?? text).toLowerCase();
}

function getConnectionKey(connection: RuntimeConnectionStats): string {
  return [
    connection.id,
    connection.metadata?.process,
    connection.metadata?.processPath,
    connection.metadata?.sourceIP,
    connection.metadata?.sourcePort,
    connection.metadata?.destinationIP,
    connection.metadata?.destinationPort,
    connection.metadata?.host
  ]
    .filter(Boolean)
    .join('|');
}

function normalizeBytes(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}
