import type { RuntimeConnectionStats, RuntimeStats } from '../../shared/ipc';
import { remoteDesktopProcessNames } from '../mihomo/config';
import type { TrafficStore } from './store';

type TrafficTrackerOptions = {
  store: TrafficStore;
  readRuntimeStats: () => Promise<RuntimeStats>;
  isRunning: () => boolean;
  intervalMs?: number;
  onError?: (error: unknown) => void;
};

export class TrafficTracker {
  private timer: ReturnType<typeof setInterval> | undefined;
  private lastUpload = 0;
  private lastDownload = 0;
  private excludedConnections = new Map<string, { upload: number; download: number }>();

  constructor(private readonly options: TrafficTrackerOptions) {}

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.sample().catch((error) => this.options.onError?.(error));
    }, this.options.intervalMs ?? 10000);
    void this.sample().catch((error) => this.options.onError?.(error));
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.lastUpload = 0;
    this.lastDownload = 0;
    this.excludedConnections.clear();
  }

  async flush() {
    await this.sample();
  }

  private async sample() {
    if (!this.options.isRunning()) {
      this.lastUpload = 0;
      this.lastDownload = 0;
      this.excludedConnections.clear();
      return;
    }

    const stats = await this.options.readRuntimeStats();
    const uploadDelta = this.lastUpload > 0 && stats.uploadTotal >= this.lastUpload
      ? stats.uploadTotal - this.lastUpload
      : 0;
    const downloadDelta = this.lastDownload > 0 && stats.downloadTotal >= this.lastDownload
      ? stats.downloadTotal - this.lastDownload
      : 0;
    const excludedDelta = this.collectExcludedDelta(stats.connections ?? []);

    this.lastUpload = stats.uploadTotal;
    this.lastDownload = stats.downloadTotal;
    await this.options.store.addTraffic(
      Math.max(0, uploadDelta - excludedDelta.upload),
      Math.max(0, downloadDelta - excludedDelta.download)
    );
  }

  private collectExcludedDelta(connections: RuntimeConnectionStats[]) {
    const activeKeys = new Set<string>();
    let upload = 0;
    let download = 0;

    for (const connection of connections) {
      if (!isExcludedConnection(connection)) continue;

      const key = getConnectionKey(connection);
      activeKeys.add(key);
      const currentUpload = normalizeBytes(connection.upload);
      const currentDownload = normalizeBytes(connection.download);
      const previous = this.excludedConnections.get(key);
      if (previous && currentUpload >= previous.upload) {
        upload += currentUpload - previous.upload;
      }
      if (previous && currentDownload >= previous.download) {
        download += currentDownload - previous.download;
      }
      this.excludedConnections.set(key, {
        upload: currentUpload,
        download: currentDownload
      });
    }

    for (const key of this.excludedConnections.keys()) {
      if (!activeKeys.has(key)) {
        this.excludedConnections.delete(key);
      }
    }

    return { upload, download };
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
