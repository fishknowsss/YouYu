export type UpdateDownloadRoute = 'direct' | 'local-proxy';

export type UpdateDownloadHealthReason = 'slow-direct-route' | 'stalled-direct-route';

export class UpdateRouteHealthError extends Error {
  readonly code = 'ERR_UPDATE_ROUTE_UNHEALTHY';

  constructor(
    readonly reason: UpdateDownloadHealthReason,
    cause: unknown
  ) {
    super(reason === 'slow-direct-route' ? 'direct update route is too slow' : 'direct update route stalled', {
      cause
    });
    this.name = 'UpdateRouteHealthError';
  }
}

export type UpdateDownloadHealthSample = {
  route: UpdateDownloadRoute;
  proxyAvailable: boolean;
  elapsedMs: number;
  idleMs: number;
  observedBytes: number;
  transferredBytes: number;
  totalBytes?: number;
};

type DownloadProgressSource = {
  on: (event: 'download-progress', listener: (value: unknown) => void) => unknown;
  removeListener: (event: 'download-progress', listener: (value: unknown) => void) => unknown;
};

type UpdateDownloadHealthMonitorOptions = {
  source: DownloadProgressSource;
  route: UpdateDownloadRoute;
  getProxyUrl: () => string | undefined;
  cancel: () => void;
  onUnhealthy?: (reason: UpdateDownloadHealthReason) => void;
  now?: () => number;
  setInterval?: (callback: () => void, delayMs: number) => ReturnType<typeof setInterval>;
  clearInterval?: (timer: ReturnType<typeof setInterval>) => void;
};

const slowRouteObservationMs = 20_000;
const stalledRouteMs = 45_000;
const slowRouteBytesPerSecond = 128 * 1024;
const excessiveRemainingMs = 15 * 60_000;
const healthPollIntervalMs = 5_000;

export function evaluateUpdateDownloadHealth(
  sample: UpdateDownloadHealthSample
): UpdateDownloadHealthReason | undefined {
  if (sample.route !== 'direct' || !sample.proxyAvailable) return undefined;
  if (sample.totalBytes !== undefined && sample.transferredBytes >= sample.totalBytes) return undefined;
  if (sample.idleMs >= stalledRouteMs) return 'stalled-direct-route';
  if (
    sample.elapsedMs < slowRouteObservationMs ||
    sample.observedBytes <= 0 ||
    sample.totalBytes === undefined ||
    sample.totalBytes <= sample.transferredBytes
  ) {
    return undefined;
  }

  const bytesPerSecond = sample.observedBytes / (sample.elapsedMs / 1000);
  const remainingMs = ((sample.totalBytes - sample.transferredBytes) / bytesPerSecond) * 1000;
  return bytesPerSecond < slowRouteBytesPerSecond && remainingMs > excessiveRemainingMs
    ? 'slow-direct-route'
    : undefined;
}

export function createUpdateDownloadHealthMonitor(options: UpdateDownloadHealthMonitorOptions) {
  const now = options.now ?? Date.now;
  const schedule = options.setInterval ?? setInterval;
  const clear = options.clearInterval ?? clearInterval;
  const startedAt = now();
  let observationStartedAt = startedAt;
  let baselineBytes = 0;
  let transferredBytes = 0;
  let totalBytes: number | undefined;
  let lastProgressAt = startedAt;
  let hasProgress = false;
  let unhealthyReason: UpdateDownloadHealthReason | undefined;

  const onProgress = (value: unknown) => {
    if (!value || typeof value !== 'object') return;
    const progress = value as Record<string, unknown>;
    const transferred = normalizeBytes(progress.transferred);
    const total = normalizeBytes(progress.total);
    if (transferred !== undefined) {
      const currentTime = now();
      if (!hasProgress) {
        hasProgress = true;
        observationStartedAt = currentTime;
        baselineBytes = transferred;
        lastProgressAt = currentTime;
      } else if (transferred > transferredBytes) {
        lastProgressAt = currentTime;
      }
      transferredBytes = Math.max(transferredBytes, transferred);
    }
    if (total !== undefined && total > 0) totalBytes = total;
    inspect();
  };

  const inspect = () => {
    if (unhealthyReason || options.route !== 'direct' || !hasUsableProxy(options.getProxyUrl)) return;
    const currentTime = now();
    const reason = evaluateUpdateDownloadHealth({
      route: options.route,
      proxyAvailable: true,
      elapsedMs: currentTime - observationStartedAt,
      idleMs: currentTime - lastProgressAt,
      observedBytes: Math.max(0, transferredBytes - baselineBytes),
      transferredBytes,
      totalBytes
    });
    if (!reason) return;
    unhealthyReason = reason;
    options.onUnhealthy?.(reason);
    options.cancel();
  };

  options.source.on('download-progress', onProgress);
  const timer = schedule(inspect, healthPollIntervalMs);
  unrefTimer(timer);

  return {
    dispose() {
      clear(timer);
      options.source.removeListener('download-progress', onProgress);
    },
    getReason: () => unhealthyReason
  };
}

function hasUsableProxy(getProxyUrl: () => string | undefined): boolean {
  try {
    return Boolean(getProxyUrl());
  } catch {
    return false;
  }
}

function normalizeBytes(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function unrefTimer(timer: ReturnType<typeof setInterval>): void {
  if (!timer || typeof timer !== 'object' || !('unref' in timer)) return;
  const unref = (timer as { unref?: unknown }).unref;
  if (typeof unref === 'function') unref.call(timer);
}
