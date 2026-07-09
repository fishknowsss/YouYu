import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { hostname } from 'node:os';
import type { PersistentTrafficStats, TrafficIdentity } from '../../shared/ipc';

type TrafficDay = {
  upload: number;
  download: number;
};

type TrafficNodeUsage = {
  upload: number;
  download: number;
  durationMs: number;
  lastUsedAt?: string;
};

type TrafficFile = {
  version: number;
  deviceSeed: string;
  identity?: TrafficIdentity;
  pendingRegistration?: TrafficRegistrationSecret;
  totalUpload: number;
  totalDownload: number;
  serverTotalUpload?: number;
  serverTotalDownload?: number;
  serverUserId?: string;
  serverDeviceId?: string;
  serverSyncedAt?: string;
  pendingUpload: number;
  pendingDownload: number;
  daily: Record<string, TrafficDay>;
  nodeUsage: Record<string, TrafficNodeUsage>;
  lastUpdatedAt?: string;
  lastReportedAt?: string;
  reportStatus?: PersistentTrafficStats['reportStatus'];
  reportError?: string;
};

type TrafficRegistrationSecret = {
  name: string;
  passphrase: string;
};

const trafficFileName = 'traffic.json';
const currentVersion = 1;

export class TrafficStore {
  private readonly filePath: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly baseDir: string) {
    this.filePath = join(baseDir, trafficFileName);
  }

  async read(): Promise<TrafficFile> {
    try {
      const raw = await readFile(this.filePath, 'utf8');
      try {
        return this.normalize(JSON.parse(raw) as Partial<TrafficFile>);
      } catch {
        const repaired = repairKnownTrafficJsonDamage(raw);
        if (repaired) {
          const normalized = this.normalize(repaired);
          await this.write(normalized);
          return normalized;
        }
        throw new Error('traffic file invalid');
      }
    } catch {
      const defaults = this.createDefaults();
      await this.write(defaults);
      return defaults;
    }
  }

  async addTraffic(
    uploadDelta: number,
    downloadDelta: number,
    now = new Date(),
    usage?: { nodeName?: string; durationMs?: number }
  ): Promise<void> {
    const upload = normalizeBytes(uploadDelta);
    const download = normalizeBytes(downloadDelta);
    const nodeName = normalizeNodeName(usage?.nodeName);
    const durationMs = normalizeDurationMs(usage?.durationMs);
    if (upload === 0 && download === 0 && (!nodeName || durationMs === 0)) return;

    await this.enqueue(async () => {
      const current = await this.read();
      const dateKey = toDateKey(now);
      const day = current.daily[dateKey] ?? { upload: 0, download: 0 };
      const nodeUsage = { ...current.nodeUsage };
      if (nodeName) {
        const currentNodeUsage = nodeUsage[nodeName] ?? { upload: 0, download: 0, durationMs: 0 };
        nodeUsage[nodeName] = {
          upload: currentNodeUsage.upload + upload,
          download: currentNodeUsage.download + download,
          durationMs: currentNodeUsage.durationMs + durationMs,
          lastUsedAt: now.toISOString()
        };
      }
      const next: TrafficFile = {
        ...current,
        totalUpload: current.totalUpload + upload,
        totalDownload: current.totalDownload + download,
        pendingUpload: current.pendingUpload + upload,
        pendingDownload: current.pendingDownload + download,
        daily: {
          ...current.daily,
          [dateKey]: {
            upload: day.upload + upload,
            download: day.download + download
          }
        },
        nodeUsage,
        lastUpdatedAt: now.toISOString(),
        reportStatus:
          current.identity && (current.pendingUpload + upload > 0 || current.pendingDownload + download > 0)
            ? 'pending'
            : current.reportStatus ?? 'idle',
        reportError: undefined
      };
      await this.write(next);
    });
  }

  async registerIdentity(identity: Omit<TrafficIdentity, 'registeredAt'>): Promise<TrafficIdentity> {
    return this.enqueue(async () => {
      const current = await this.read();
      const sameIdentity = isSameTrafficIdentity(current.identity, identity);
      const registered: TrafficIdentity = {
        ...identity,
        name: identity.name.trim(),
        deviceName: identity.deviceName?.trim() || hostname(),
        registeredAt: sameIdentity ? current.identity?.registeredAt ?? new Date().toISOString() : new Date().toISOString(),
        lastReportedAt: sameIdentity ? current.identity?.lastReportedAt : undefined,
        verificationStatus: identity.verificationStatus ?? 'verified'
      };
      await this.write({
        ...current,
        identity: registered,
        ...getServerTotalState(current, sameIdentity),
        pendingRegistration: registered.verificationStatus === 'pending' ? current.pendingRegistration : undefined,
        reportStatus: current.pendingUpload || current.pendingDownload ? 'pending' : 'idle',
        reportError: undefined
      });
      return registered;
    });
  }

  async registerPendingIdentity(input: TrafficRegistrationSecret): Promise<TrafficIdentity> {
    return this.enqueue(async () => {
      const name = input.name.trim();
      const passphrase = input.passphrase.trim();
      const current = await this.read();
      const deviceSeed = current.deviceSeed || randomUUID();
      const registered: TrafficIdentity = {
        userId: `pending:${deviceSeed}`,
        deviceId: `pending:${deviceSeed}`,
        name,
        deviceName: hostname(),
        registeredAt: current.identity?.registeredAt ?? new Date().toISOString(),
        lastReportedAt: current.identity?.lastReportedAt,
        verificationStatus: 'pending'
      };
      await this.write({
        ...current,
        deviceSeed,
        identity: registered,
        ...getServerTotalState(current, false),
        pendingRegistration: {
          name,
          passphrase
        },
        reportStatus: 'pending',
        reportError: 'traffic activation pending'
      });
      return registered;
    });
  }

  async getPendingRegistration(): Promise<TrafficRegistrationSecret | undefined> {
    const current = await this.read();
    if (current.identity?.verificationStatus !== 'pending') return undefined;
    const pending = current.pendingRegistration;
    if (!pending?.name.trim() || !pending.passphrase.trim()) return undefined;
    return {
      name: pending.name.trim(),
      passphrase: pending.passphrase.trim()
    };
  }

  async clearIdentity(message?: string): Promise<void> {
    await this.enqueue(async () => {
      const current = await this.read();
      await this.write({
        ...current,
        identity: undefined,
        pendingRegistration: undefined,
        ...getServerTotalState(current, false),
        reportStatus: message ? 'failed' : 'idle',
        reportError: message
      });
    });
  }

  async createDeviceSeed(): Promise<string> {
    return this.enqueue(async () => {
      const current = await this.read();
      if (current.deviceSeed) return current.deviceSeed;
      const deviceSeed = randomUUID();
      await this.write({ ...current, deviceSeed });
      return deviceSeed;
    });
  }

  async markReported(upload: number, download: number, reportedAt = new Date()): Promise<void> {
    await this.enqueue(async () => {
      const current = await this.read();
      const pendingUpload = Math.max(0, current.pendingUpload - normalizeBytes(upload));
      const pendingDownload = Math.max(0, current.pendingDownload - normalizeBytes(download));
      const lastReportedAt = reportedAt.toISOString();
      await this.write({
        ...current,
        pendingUpload,
        pendingDownload,
        lastReportedAt,
        identity: current.identity ? { ...current.identity, lastReportedAt } : undefined,
        reportStatus: pendingUpload || pendingDownload ? 'pending' : 'synced',
        reportError: undefined
      });
    });
  }

  async markServerTotals(input: { totalUpload?: number; totalDownload?: number }, syncedAt = new Date()): Promise<void> {
    const totalUpload = normalizeOptionalBytes(input.totalUpload);
    const totalDownload = normalizeOptionalBytes(input.totalDownload);
    if (typeof totalUpload !== 'number' || typeof totalDownload !== 'number') return;

    await this.enqueue(async () => {
      const current = await this.read();
      if (!current.identity || current.identity.verificationStatus === 'pending') return;
      await this.write({
        ...current,
        serverTotalUpload: totalUpload,
        serverTotalDownload: totalDownload,
        serverUserId: current.identity.userId,
        serverDeviceId: current.identity.deviceId,
        serverSyncedAt: syncedAt.toISOString()
      });
    });
  }

  async markReportFailed(message: string): Promise<void> {
    await this.enqueue(async () => {
      const current = await this.read();
      await this.write({
        ...current,
        reportStatus: 'failed',
        reportError: message
      });
    });
  }

  async markNotConfigured(): Promise<void> {
    await this.enqueue(async () => {
      const current = await this.read();
      await this.write({
        ...current,
        reportStatus: 'not-configured',
        reportError: undefined
      });
    });
  }

  async getDeviceSecret(): Promise<string | undefined> {
    await this.queue.catch(() => undefined);
    const current = await this.read();
    return current.deviceSeed;
  }

  async getSnapshot(now = new Date()): Promise<{
    identity?: TrafficIdentity;
    stats: PersistentTrafficStats;
  }> {
    await this.queue.catch(() => undefined);
    const current = await this.read();
    const today = current.daily[toDateKey(now)] ?? { upload: 0, download: 0 };
    const serverTotalUpload = current.serverTotalUpload;
    const serverTotalDownload = current.serverTotalDownload;
    const hasServerTotals =
      typeof serverTotalUpload === 'number' &&
      typeof serverTotalDownload === 'number' &&
      current.identity?.verificationStatus !== 'pending' &&
      current.serverUserId === current.identity?.userId &&
      current.serverDeviceId === current.identity?.deviceId;
    return {
      identity: current.identity,
      stats: {
        totalUpload: hasServerTotals ? serverTotalUpload + current.pendingUpload : current.totalUpload,
        totalDownload: hasServerTotals ? serverTotalDownload + current.pendingDownload : current.totalDownload,
        todayUpload: today.upload,
        todayDownload: today.download,
        pendingUpload: current.pendingUpload,
        pendingDownload: current.pendingDownload,
        totalSource: hasServerTotals ? 'server' : 'local',
        serverSyncedAt: hasServerTotals ? current.serverSyncedAt : undefined,
        nodeUsage: summarizeNodeUsage(current.nodeUsage),
        lastUpdatedAt: current.lastUpdatedAt,
        lastReportedAt: current.lastReportedAt,
        reportStatus: current.reportStatus ?? 'idle',
        reportError: current.reportError
      }
    };
  }

  private async write(value: TrafficFile): Promise<void> {
    await mkdir(this.baseDir, { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify(this.normalize(value), null, 2)}\n`, 'utf8');
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private normalize(value: Partial<TrafficFile>): TrafficFile {
    return {
      version: currentVersion,
      deviceSeed: typeof value.deviceSeed === 'string' && value.deviceSeed ? value.deviceSeed : randomUUID(),
      identity: normalizeIdentity(value.identity),
      pendingRegistration: normalizePendingRegistration(value.pendingRegistration),
      totalUpload: normalizeBytes(value.totalUpload),
      totalDownload: normalizeBytes(value.totalDownload),
      serverTotalUpload: normalizeOptionalBytes(value.serverTotalUpload),
      serverTotalDownload: normalizeOptionalBytes(value.serverTotalDownload),
      serverUserId: typeof value.serverUserId === 'string' ? value.serverUserId : undefined,
      serverDeviceId: typeof value.serverDeviceId === 'string' ? value.serverDeviceId : undefined,
      serverSyncedAt: typeof value.serverSyncedAt === 'string' ? value.serverSyncedAt : undefined,
      pendingUpload: normalizeBytes(value.pendingUpload),
      pendingDownload: normalizeBytes(value.pendingDownload),
      daily: normalizeDaily(value.daily),
      nodeUsage: normalizeNodeUsage(value.nodeUsage),
      lastUpdatedAt: typeof value.lastUpdatedAt === 'string' ? value.lastUpdatedAt : undefined,
      lastReportedAt: typeof value.lastReportedAt === 'string' ? value.lastReportedAt : undefined,
      reportStatus: normalizeReportStatus(value.reportStatus),
      reportError: typeof value.reportError === 'string' ? value.reportError : undefined
    };
  }

  private createDefaults(): TrafficFile {
    return this.normalize({});
  }
}

function normalizeIdentity(value: unknown): TrafficIdentity | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const identity = value as Partial<TrafficIdentity>;
  if (
    typeof identity.userId !== 'string' ||
    typeof identity.deviceId !== 'string' ||
    typeof identity.name !== 'string' ||
    !identity.userId.trim() ||
    !identity.deviceId.trim() ||
    !identity.name.trim()
  ) {
    return undefined;
  }
  return {
    userId: identity.userId,
    deviceId: identity.deviceId,
    name: identity.name.trim(),
    deviceName: typeof identity.deviceName === 'string' ? identity.deviceName : undefined,
    registeredAt: typeof identity.registeredAt === 'string' ? identity.registeredAt : new Date().toISOString(),
    lastReportedAt: typeof identity.lastReportedAt === 'string' ? identity.lastReportedAt : undefined,
    verificationStatus: identity.verificationStatus === 'pending' ? 'pending' : 'verified'
  };
}

function isSameTrafficIdentity(
  current: Pick<TrafficIdentity, 'userId' | 'deviceId'> | undefined,
  next: Pick<TrafficIdentity, 'userId' | 'deviceId'>
): boolean {
  return current?.userId === next.userId && current.deviceId === next.deviceId;
}

function getServerTotalState(
  current: TrafficFile,
  keep: boolean
): Pick<TrafficFile, 'serverTotalUpload' | 'serverTotalDownload' | 'serverUserId' | 'serverDeviceId' | 'serverSyncedAt'> {
  if (keep) {
    return {
      serverTotalUpload: current.serverTotalUpload,
      serverTotalDownload: current.serverTotalDownload,
      serverUserId: current.serverUserId,
      serverDeviceId: current.serverDeviceId,
      serverSyncedAt: current.serverSyncedAt
    };
  }
  return {
    serverTotalUpload: undefined,
    serverTotalDownload: undefined,
    serverUserId: undefined,
    serverDeviceId: undefined,
    serverSyncedAt: undefined
  };
}

function repairKnownTrafficJsonDamage(raw: string): Partial<TrafficFile> | undefined {
  const repairedRaw = raw.replace(
    /("name"\s*:\s*")([^"\r\n]*?),?\r?\n(\s*"deviceName"\s*:)/,
    '$1$2",\n$3'
  );

  if (repairedRaw === raw) {
    return undefined;
  }

  try {
    return JSON.parse(repairedRaw) as Partial<TrafficFile>;
  } catch {
    return undefined;
  }
}

function normalizePendingRegistration(value: unknown): TrafficRegistrationSecret | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const registration = value as Partial<TrafficRegistrationSecret>;
  const name = typeof registration.name === 'string' ? registration.name.trim() : '';
  const passphrase = typeof registration.passphrase === 'string' ? registration.passphrase.trim() : '';
  return name && passphrase ? { name, passphrase } : undefined;
}

function normalizeDaily(value: unknown): Record<string, TrafficDay> {
  if (!value || typeof value !== 'object') return {};
  const next: Record<string, TrafficDay> = {};
  for (const [key, day] of Object.entries(value as Record<string, Partial<TrafficDay>>)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) continue;
    next[key] = {
      upload: normalizeBytes(day.upload),
      download: normalizeBytes(day.download)
    };
  }
  return next;
}

function normalizeNodeUsage(value: unknown): Record<string, TrafficNodeUsage> {
  if (!value || typeof value !== 'object') return {};
  const next: Record<string, TrafficNodeUsage> = {};
  for (const [key, usage] of Object.entries(value as Record<string, Partial<TrafficNodeUsage>>)) {
    const nodeName = normalizeNodeName(key);
    if (!nodeName) continue;
    next[nodeName] = {
      upload: normalizeBytes(usage.upload),
      download: normalizeBytes(usage.download),
      durationMs: normalizeDurationMs(usage.durationMs),
      lastUsedAt: typeof usage.lastUsedAt === 'string' ? usage.lastUsedAt : undefined
    };
  }
  return next;
}

function summarizeNodeUsage(value: Record<string, TrafficNodeUsage>): PersistentTrafficStats['nodeUsage'] {
  const entries = Object.entries(value)
    .map(([name, usage]) => ({
      name,
      upload: normalizeBytes(usage.upload),
      download: normalizeBytes(usage.download),
      durationMs: normalizeDurationMs(usage.durationMs),
      lastUsedAt: usage.lastUsedAt
    }))
    .filter((usage) => usage.name && (usage.upload > 0 || usage.download > 0 || usage.durationMs > 0));

  return {
    mostUsed: entries.toSorted(compareMostUsedNode)[0],
    longestUsed: entries.toSorted(compareLongestUsedNode)[0]
  };
}

function compareMostUsedNode(left: TrafficNodeUsage & { name: string }, right: TrafficNodeUsage & { name: string }) {
  const leftBytes = left.upload + left.download;
  const rightBytes = right.upload + right.download;
  if (rightBytes !== leftBytes) return rightBytes - leftBytes;
  if (right.durationMs !== left.durationMs) return right.durationMs - left.durationMs;
  return compareLastUsedAt(left, right);
}

function compareLongestUsedNode(left: TrafficNodeUsage & { name: string }, right: TrafficNodeUsage & { name: string }) {
  if (right.durationMs !== left.durationMs) return right.durationMs - left.durationMs;
  const leftBytes = left.upload + left.download;
  const rightBytes = right.upload + right.download;
  if (rightBytes !== leftBytes) return rightBytes - leftBytes;
  return compareLastUsedAt(left, right);
}

function compareLastUsedAt(left: TrafficNodeUsage, right: TrafficNodeUsage) {
  const rightTime = Date.parse(right.lastUsedAt ?? '');
  const leftTime = Date.parse(left.lastUsedAt ?? '');
  return (Number.isFinite(rightTime) ? rightTime : 0) - (Number.isFinite(leftTime) ? leftTime : 0);
}

function normalizeBytes(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function normalizeOptionalBytes(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined;
}

function normalizeDurationMs(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function normalizeNodeName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (!text || text === 'DIRECT') return undefined;
  return text;
}

function normalizeReportStatus(value: unknown): PersistentTrafficStats['reportStatus'] {
  return value === 'synced' || value === 'pending' || value === 'failed' || value === 'not-configured'
    ? value
    : 'idle';
}

function toDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
