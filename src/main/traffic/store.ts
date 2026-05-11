import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { hostname } from 'node:os';
import type { PersistentTrafficStats, TrafficIdentity } from '../../shared/ipc';

type TrafficDay = {
  upload: number;
  download: number;
};

type TrafficFile = {
  version: number;
  deviceSeed: string;
  identity?: TrafficIdentity;
  pendingRegistration?: TrafficRegistrationSecret;
  totalUpload: number;
  totalDownload: number;
  pendingUpload: number;
  pendingDownload: number;
  daily: Record<string, TrafficDay>;
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

  constructor(private readonly baseDir: string) {
    this.filePath = join(baseDir, trafficFileName);
  }

  async read(): Promise<TrafficFile> {
    try {
      const raw = await readFile(this.filePath, 'utf8');
      return this.normalize(JSON.parse(raw) as Partial<TrafficFile>);
    } catch {
      const defaults = this.createDefaults();
      await this.write(defaults);
      return defaults;
    }
  }

  async addTraffic(uploadDelta: number, downloadDelta: number, now = new Date()): Promise<void> {
    const upload = normalizeBytes(uploadDelta);
    const download = normalizeBytes(downloadDelta);
    if (upload === 0 && download === 0) return;

    const current = await this.read();
    const dateKey = toDateKey(now);
    const day = current.daily[dateKey] ?? { upload: 0, download: 0 };
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
      lastUpdatedAt: now.toISOString(),
      reportStatus: current.identity ? 'pending' : current.reportStatus ?? 'idle',
      reportError: undefined
    };
    await this.write(next);
  }

  async registerIdentity(identity: Omit<TrafficIdentity, 'registeredAt'>): Promise<TrafficIdentity> {
    const current = await this.read();
    const registered: TrafficIdentity = {
      ...identity,
      name: identity.name.trim(),
      deviceName: identity.deviceName?.trim() || hostname(),
      registeredAt: current.identity?.registeredAt ?? new Date().toISOString(),
      lastReportedAt: current.identity?.lastReportedAt,
      verificationStatus: identity.verificationStatus ?? 'verified'
    };
    await this.write({
      ...current,
      identity: registered,
      pendingRegistration: registered.verificationStatus === 'pending' ? current.pendingRegistration : undefined,
      reportStatus: current.pendingUpload || current.pendingDownload ? 'pending' : 'idle',
      reportError: undefined
    });
    return registered;
  }

  async registerPendingIdentity(input: TrafficRegistrationSecret): Promise<TrafficIdentity> {
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
      pendingRegistration: {
        name,
        passphrase
      },
      reportStatus: 'pending',
      reportError: 'traffic activation pending'
    });
    return registered;
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
    const current = await this.read();
    await this.write({
      ...current,
      identity: undefined,
      pendingRegistration: undefined,
      reportStatus: message ? 'failed' : 'idle',
      reportError: message
    });
  }

  async createDeviceSeed(): Promise<string> {
    const current = await this.read();
    if (current.deviceSeed) return current.deviceSeed;
    const deviceSeed = randomUUID();
    await this.write({ ...current, deviceSeed });
    return deviceSeed;
  }

  async markReported(upload: number, download: number, reportedAt = new Date()): Promise<void> {
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
  }

  async markReportFailed(message: string): Promise<void> {
    const current = await this.read();
    await this.write({
      ...current,
      reportStatus: 'failed',
      reportError: message
    });
  }

  async markNotConfigured(): Promise<void> {
    const current = await this.read();
    await this.write({
      ...current,
      reportStatus: 'not-configured',
      reportError: undefined
    });
  }

  async getSnapshot(now = new Date()): Promise<{
    identity?: TrafficIdentity;
    stats: PersistentTrafficStats;
  }> {
    const current = await this.read();
    const today = current.daily[toDateKey(now)] ?? { upload: 0, download: 0 };
    return {
      identity: current.identity,
      stats: {
        totalUpload: current.totalUpload,
        totalDownload: current.totalDownload,
        todayUpload: today.upload,
        todayDownload: today.download,
        pendingUpload: current.pendingUpload,
        pendingDownload: current.pendingDownload,
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

  private normalize(value: Partial<TrafficFile>): TrafficFile {
    return {
      version: currentVersion,
      deviceSeed: typeof value.deviceSeed === 'string' && value.deviceSeed ? value.deviceSeed : randomUUID(),
      identity: normalizeIdentity(value.identity),
      pendingRegistration: normalizePendingRegistration(value.pendingRegistration),
      totalUpload: normalizeBytes(value.totalUpload),
      totalDownload: normalizeBytes(value.totalDownload),
      pendingUpload: normalizeBytes(value.pendingUpload),
      pendingDownload: normalizeBytes(value.pendingDownload),
      daily: normalizeDaily(value.daily),
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

function normalizeBytes(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function normalizeReportStatus(value: unknown): PersistentTrafficStats['reportStatus'] {
  return value === 'synced' || value === 'pending' || value === 'failed' || value === 'not-configured'
    ? value
    : 'idle';
}

function toDateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}
