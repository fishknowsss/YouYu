import type { RuntimeStats } from '../../shared/ipc';
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
  }

  async flush() {
    await this.sample();
  }

  private async sample() {
    if (!this.options.isRunning()) {
      this.lastUpload = 0;
      this.lastDownload = 0;
      return;
    }

    const stats = await this.options.readRuntimeStats();
    const uploadDelta = this.lastUpload > 0 && stats.uploadTotal >= this.lastUpload
      ? stats.uploadTotal - this.lastUpload
      : 0;
    const downloadDelta = this.lastDownload > 0 && stats.downloadTotal >= this.lastDownload
      ? stats.downloadTotal - this.lastDownload
      : 0;

    this.lastUpload = stats.uploadTotal;
    this.lastDownload = stats.downloadTotal;
    await this.options.store.addTraffic(uploadDelta, downloadDelta);
  }
}
