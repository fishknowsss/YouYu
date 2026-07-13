import { randomUUID } from 'node:crypto';
import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { isDeepStrictEqual } from 'node:util';
import type { PersistentTrafficStats, TrafficIdentity } from '../../shared/ipc';
import { readJsonFile, writeJsonFileAtomic } from '../storage/jsonFile';

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
  pendingRegistration?: StoredTrafficRegistrationSecret;
  totalUpload: number;
  totalDownload: number;
  serverTotalUpload?: number;
  serverTotalDownload?: number;
  serverUserId?: string;
  serverDeviceId?: string;
  serverSyncedAt?: string;
  pendingUpload: number;
  pendingDownload: number;
  pendingReport?: PendingTrafficReport;
  daily: Record<string, TrafficDay>;
  nodeUsage: Record<string, TrafficNodeUsage>;
  lastUpdatedAt?: string;
  lastReportedAt?: string;
  reportStatus?: PersistentTrafficStats['reportStatus'];
  reportError?: string;
};

export type PendingTrafficReport = {
  id: string;
  upload: number;
  download: number;
  reportedAt: string;
};

type TrafficIdentityKey = Pick<TrafficIdentity, 'userId' | 'deviceId'>;

type TrafficRegistrationSecret = {
  name: string;
  passphrase: string;
};

type StoredTrafficRegistrationSecret = {
  name: string;
  encryptedPassphrase?: string;
  passphrase?: string;
};

export type TrafficSecretStorage = {
  isEncryptionAvailable: () => boolean;
  encryptString: (value: string) => Buffer;
  decryptString: (value: Buffer) => string;
};

type TrafficStoreOptions = {
  secretStorage?: TrafficSecretStorage;
};

const trafficFileName = 'traffic.json';
const currentVersion = 3;

export class TrafficStore {
  private readonly filePath: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly baseDir: string,
    private readonly options: TrafficStoreOptions = {}
  ) {
    this.filePath = join(baseDir, trafficFileName);
  }

  async read(): Promise<TrafficFile> {
    return this.enqueue(() => this.readCurrent());
  }

  private async readCurrent(): Promise<TrafficFile> {
    const result = await readJsonFile<Partial<TrafficFile>>(this.filePath, {
      preserveInvalid: false,
      validate: (value) =>
        typeof value?.deviceSeed === 'string' &&
        typeof value.totalUpload === 'number' &&
        typeof value.totalDownload === 'number' &&
        Boolean(value.daily) &&
        typeof value.daily === 'object',
      repair: (raw) => {
        const repaired = repairKnownTrafficJsonDamage(raw);
        return repaired ? this.normalize(repaired) : undefined;
      }
    });
    if (result.status === 'found') {
      const normalized = this.normalize(result.value);
      const legacyPending = normalized.pendingRegistration;
      if (legacyPending?.passphrase && !this.options.secretStorage?.isEncryptionAvailable()) {
        const sanitized = {
          ...normalized,
          identity: normalized.identity?.verificationStatus === 'pending' ? undefined : normalized.identity,
          pendingRegistration: undefined,
          reportStatus: 'failed' as const,
          reportError: 'secure traffic registration storage is unavailable'
        };
        await this.write(sanitized, false);
        await this.removeLegacySecretArtifacts();
        return sanitized;
      }
      if (legacyPending?.passphrase) {
        const migrated = {
          ...normalized,
          pendingRegistration: {
            name: legacyPending.name,
            encryptedPassphrase: this.encryptPassphrase(legacyPending.passphrase)
          }
        };
        await this.write(migrated, false);
        await this.removeLegacySecretArtifacts();
        return migrated;
      }
      if (shouldRewriteNormalizedTraffic(result.value, normalized)) {
        await this.write(normalized, false);
      }
      return normalized;
    }

    const defaults = this.createDefaults();
    await this.write(defaults, false);
    await this.removeLegacySecretArtifacts();
    return defaults;
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
      const current = await this.readCurrent();
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
            : (current.reportStatus ?? 'idle'),
        reportError: undefined
      };
      await this.write(next);
    });
  }

  async registerIdentity(identity: Omit<TrafficIdentity, 'registeredAt'>): Promise<TrafficIdentity> {
    return this.enqueue(async () => {
      const current = await this.readCurrent();
      const sameIdentity = isSameTrafficIdentity(current.identity, identity);
      const registered: TrafficIdentity = {
        ...identity,
        name: identity.name.trim(),
        deviceName: identity.deviceName?.trim() || hostname(),
        registeredAt: sameIdentity
          ? (current.identity?.registeredAt ?? new Date().toISOString())
          : new Date().toISOString(),
        lastReportedAt: sameIdentity ? current.identity?.lastReportedAt : undefined,
        verificationStatus: identity.verificationStatus ?? 'verified'
      };
      await this.write({
        ...current,
        identity: registered,
        ...getServerTotalState(current, sameIdentity),
        pendingReport: sameIdentity ? current.pendingReport : undefined,
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
      const current = await this.readCurrent();
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
          encryptedPassphrase: this.encryptPassphrase(passphrase)
        },
        pendingReport: undefined,
        reportStatus: 'pending',
        reportError: 'traffic activation pending'
      });
      return registered;
    });
  }

  async getPendingRegistration(): Promise<TrafficRegistrationSecret | undefined> {
    return this.enqueue(async () => {
      const current = await this.readCurrent();
      if (current.identity?.verificationStatus !== 'pending') return undefined;
      const pending = current.pendingRegistration;
      if (!pending?.name.trim()) return undefined;

      let passphrase: string | undefined;
      try {
        passphrase = pending.encryptedPassphrase
          ? this.decryptPassphrase(pending.encryptedPassphrase)
          : pending.passphrase?.trim();
      } catch {
        await this.write(
          {
            ...current,
            identity: undefined,
            pendingRegistration: undefined,
            reportStatus: 'failed',
            reportError: 'traffic registration secret cannot be decrypted'
          },
          false
        );
        await this.removeLegacySecretArtifacts();
        return undefined;
      }
      if (!passphrase) return undefined;

      if (!pending.encryptedPassphrase) {
        await this.write(
          {
            ...current,
            pendingRegistration: {
              name: pending.name.trim(),
              encryptedPassphrase: this.encryptPassphrase(passphrase)
            }
          },
          false
        );
        await this.removeLegacySecretArtifacts();
      }

      return {
        name: pending.name.trim(),
        passphrase
      };
    });
  }

  async clearIdentity(message?: string): Promise<void> {
    await this.enqueue(async () => {
      const current = await this.readCurrent();
      await this.write({
        ...current,
        identity: undefined,
        pendingRegistration: undefined,
        pendingReport: undefined,
        ...getServerTotalState(current, false),
        reportStatus: message ? 'failed' : 'idle',
        reportError: message
      });
    });
  }

  async clearIdentityIfCurrent(identity: TrafficIdentityKey, reportId: string, message?: string): Promise<boolean> {
    return this.enqueue(async () => {
      const current = await this.readCurrent();
      if (!isSameTrafficIdentity(current.identity, identity) || current.pendingReport?.id !== reportId) return false;
      await this.write({
        ...current,
        identity: undefined,
        pendingRegistration: undefined,
        pendingReport: undefined,
        ...getServerTotalState(current, false),
        reportStatus: message ? 'failed' : 'idle',
        reportError: message
      });
      return true;
    });
  }

  async createDeviceSeed(): Promise<string> {
    return this.enqueue(async () => {
      const current = await this.readCurrent();
      if (current.deviceSeed) return current.deviceSeed;
      const deviceSeed = randomUUID();
      await this.write({ ...current, deviceSeed });
      return deviceSeed;
    });
  }

  async getOrCreatePendingReport(
    upload: number,
    download: number,
    now = new Date(),
    identity?: TrafficIdentityKey
  ): Promise<PendingTrafficReport | undefined> {
    return this.enqueue(async () => {
      const current = await this.readCurrent();
      if (identity && !isSameTrafficIdentity(current.identity, identity)) return undefined;
      if (current.pendingReport) return current.pendingReport;

      const pendingReport: PendingTrafficReport = {
        id: randomUUID(),
        upload: normalizeBytes(upload),
        download: normalizeBytes(download),
        reportedAt: now.toISOString()
      };
      await this.write({ ...current, pendingReport });
      return pendingReport;
    });
  }

  async markReported(
    upload: number,
    download: number,
    reportedAt = new Date(),
    reportId?: string,
    identity?: TrafficIdentityKey
  ): Promise<boolean> {
    return this.enqueue(async () => {
      const current = await this.readCurrent();
      if (identity && !isSameTrafficIdentity(current.identity, identity)) return false;
      if (reportId && current.pendingReport?.id !== reportId) return false;
      const pendingUpload = Math.max(0, current.pendingUpload - normalizeBytes(upload));
      const pendingDownload = Math.max(0, current.pendingDownload - normalizeBytes(download));
      const lastReportedAt = reportedAt.toISOString();
      await this.write({
        ...current,
        pendingUpload,
        pendingDownload,
        pendingReport: undefined,
        lastReportedAt,
        identity: current.identity ? { ...current.identity, lastReportedAt } : undefined,
        reportStatus: pendingUpload || pendingDownload ? 'pending' : 'synced',
        reportError: undefined
      });
      return true;
    });
  }

  async markServerTotals(
    input: { totalUpload?: number; totalDownload?: number },
    syncedAt = new Date(),
    identity?: TrafficIdentityKey
  ): Promise<boolean> {
    const totalUpload = normalizeOptionalBytes(input.totalUpload);
    const totalDownload = normalizeOptionalBytes(input.totalDownload);
    if (typeof totalUpload !== 'number' || typeof totalDownload !== 'number') return false;

    return this.enqueue(async () => {
      const current = await this.readCurrent();
      if (!current.identity || current.identity.verificationStatus === 'pending') return false;
      if (identity && !isSameTrafficIdentity(current.identity, identity)) return false;
      await this.write({
        ...current,
        serverTotalUpload: totalUpload,
        serverTotalDownload: totalDownload,
        serverUserId: current.identity.userId,
        serverDeviceId: current.identity.deviceId,
        serverSyncedAt: syncedAt.toISOString()
      });
      return true;
    });
  }

  async markReportFailed(message: string): Promise<void> {
    await this.enqueue(async () => {
      const current = await this.readCurrent();
      await this.write({
        ...current,
        reportStatus: 'failed',
        reportError: message
      });
    });
  }

  async markReportFailedIfCurrent(identity: TrafficIdentityKey, reportId: string, message: string): Promise<boolean> {
    return this.enqueue(async () => {
      const current = await this.readCurrent();
      if (!isSameTrafficIdentity(current.identity, identity) || current.pendingReport?.id !== reportId) return false;
      await this.write({
        ...current,
        reportStatus: 'failed',
        reportError: message
      });
      return true;
    });
  }

  async markNotConfigured(): Promise<void> {
    await this.enqueue(async () => {
      const current = await this.readCurrent();
      await this.write({
        ...current,
        reportStatus: 'not-configured',
        reportError: undefined
      });
    });
  }

  async getDeviceSecret(): Promise<string | undefined> {
    const current = await this.read();
    return current.deviceSeed;
  }

  async getSnapshot(now = new Date()): Promise<{
    identity?: TrafficIdentity;
    stats: PersistentTrafficStats;
  }> {
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

  private async write(value: TrafficFile, backupExisting = true): Promise<void> {
    await writeJsonFileAtomic(this.filePath, this.normalize(value), { backupExisting, preserveInvalid: false });
  }

  private async removeLegacySecretArtifacts(): Promise<void> {
    const entries = await readdir(this.baseDir).catch(() => []);
    await Promise.all(
      entries
        .filter((name) => name.startsWith(`${trafficFileName}.corrupt-`) || name.startsWith(`${trafficFileName}.tmp-`))
        .map((name) => rm(join(this.baseDir, name), { force: true }))
    );
  }

  private encryptPassphrase(passphrase: string): string {
    const secretStorage = this.getSecretStorage();
    return secretStorage.encryptString(passphrase).toString('base64');
  }

  private decryptPassphrase(encryptedPassphrase: string): string {
    const secretStorage = this.getSecretStorage();
    try {
      return secretStorage.decryptString(Buffer.from(encryptedPassphrase, 'base64')).trim();
    } catch {
      throw new Error('traffic registration secret cannot be decrypted');
    }
  }

  private getSecretStorage(): TrafficSecretStorage {
    const secretStorage = this.options.secretStorage;
    if (!secretStorage?.isEncryptionAvailable()) {
      throw new Error('secure traffic registration storage is unavailable');
    }
    return secretStorage;
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
      pendingReport: normalizePendingReport(value.pendingReport),
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

function shouldRewriteNormalizedTraffic(parsed: Partial<TrafficFile>, normalized: TrafficFile): boolean {
  const persisted = JSON.parse(JSON.stringify(normalized)) as Partial<TrafficFile>;
  return !isDeepStrictEqual(parsed, persisted);
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
): Pick<
  TrafficFile,
  'serverTotalUpload' | 'serverTotalDownload' | 'serverUserId' | 'serverDeviceId' | 'serverSyncedAt'
> {
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
  const repairedRaw = raw.replace(/("name"\s*:\s*")([^"\r\n]*?),?\r?\n(\s*"deviceName"\s*:)/, '$1$2",\n$3');

  if (repairedRaw === raw) {
    return undefined;
  }

  try {
    return JSON.parse(repairedRaw) as Partial<TrafficFile>;
  } catch {
    return undefined;
  }
}

function normalizePendingRegistration(value: unknown): StoredTrafficRegistrationSecret | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const registration = value as Partial<StoredTrafficRegistrationSecret>;
  const name = typeof registration.name === 'string' ? registration.name.trim() : '';
  const passphrase = typeof registration.passphrase === 'string' ? registration.passphrase.trim() : '';
  const encryptedPassphrase =
    typeof registration.encryptedPassphrase === 'string' ? registration.encryptedPassphrase.trim() : '';
  if (!name || (!passphrase && !encryptedPassphrase)) return undefined;
  return {
    name,
    encryptedPassphrase: encryptedPassphrase || undefined,
    passphrase: encryptedPassphrase ? undefined : passphrase
  };
}

function normalizePendingReport(value: unknown): PendingTrafficReport | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const report = value as Partial<PendingTrafficReport>;
  const id = typeof report.id === 'string' ? report.id.trim() : '';
  const reportedAt = typeof report.reportedAt === 'string' ? report.reportedAt : '';
  if (!id || !Number.isFinite(Date.parse(reportedAt))) return undefined;
  return {
    id,
    upload: normalizeBytes(report.upload),
    download: normalizeBytes(report.download),
    reportedAt
  };
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
  return value === 'synced' || value === 'pending' || value === 'failed' || value === 'not-configured' ? value : 'idle';
}

function toDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
