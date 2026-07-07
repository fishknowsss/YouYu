import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  ConnectivityResult,
  CurrentNodeHealth,
  NodeAvailabilitySnapshot,
  NodeAvailabilityTone
} from '../../shared/ipc';

export type StoredNodeAvailability = {
  nodeName: string;
  date: string;
  checkedAt: string;
  availableCount: number;
  totalCount: number;
  percent: number;
  tone: NodeAvailabilityTone;
};

type NodeHealthFile = {
  version: number;
  availabilityByNode: Record<string, StoredNodeAvailability>;
};

const nodeHealthFileName = 'node-health.json';
const currentNodeHealthVersion = 1;

export class NodeHealthStore {
  private readonly filePath: string;

  constructor(private readonly baseDir: string) {
    this.filePath = join(baseDir, nodeHealthFileName);
  }

  async getTodayAvailability(nodeName: string, now = new Date()): Promise<StoredNodeAvailability | undefined> {
    const file = await this.read();
    const record = file.availabilityByNode[nodeName];
    return record?.date === formatLocalDate(now) ? record : undefined;
  }

  async saveAvailability(record: StoredNodeAvailability): Promise<void> {
    const file = await this.read();
    await this.write({
      version: currentNodeHealthVersion,
      availabilityByNode: {
        ...file.availabilityByNode,
        [record.nodeName]: record
      }
    });
  }

  private async read(): Promise<NodeHealthFile> {
    try {
      const raw = await readFile(this.filePath, 'utf8');
      return normalizeNodeHealthFile(JSON.parse(raw));
    } catch {
      return createEmptyNodeHealthFile();
    }
  }

  private async write(file: NodeHealthFile): Promise<void> {
    await mkdir(this.baseDir, { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
  }
}

export function createEmptyCurrentNodeHealth(nodeName: string, totalCount: number): CurrentNodeHealth {
  return {
    nodeName,
    delayStatus: 'untested',
    availability: {
      status: 'untested',
      totalCount
    }
  };
}

export function createAvailabilityRecord(
  nodeName: string,
  results: ConnectivityResult[],
  checkedAt = new Date()
): StoredNodeAvailability {
  const totalCount = results.length;
  const availableCount = results.filter((result) => result.status === 'available').length;
  return {
    nodeName,
    date: formatLocalDate(checkedAt),
    checkedAt: checkedAt.toISOString(),
    availableCount,
    totalCount,
    percent: totalCount > 0 ? Math.round((availableCount / totalCount) * 100) : 0,
    tone: getAvailabilityTone(availableCount)
  };
}

export function availabilitySnapshotFromRecord(record: StoredNodeAvailability): NodeAvailabilitySnapshot {
  return {
    status: 'measured',
    totalCount: record.totalCount,
    availableCount: record.availableCount,
    percent: record.percent,
    tone: record.tone,
    checkedAt: record.checkedAt
  };
}

export function getAvailabilityTone(availableCount: number): NodeAvailabilityTone {
  if (availableCount <= 5) return 'danger';
  if (availableCount <= 8) return 'warning';
  return 'success';
}

function normalizeNodeHealthFile(value: unknown): NodeHealthFile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return createEmptyNodeHealthFile();
  }

  const candidate = value as Partial<NodeHealthFile>;
  const entries = Object.entries(candidate.availabilityByNode ?? {})
    .map(([nodeName, record]) => [nodeName, normalizeAvailabilityRecord(record)] as const)
    .filter((entry): entry is readonly [string, StoredNodeAvailability] => Boolean(entry[1]));

  return {
    version: currentNodeHealthVersion,
    availabilityByNode: Object.fromEntries(entries)
  };
}

function normalizeAvailabilityRecord(value: unknown): StoredNodeAvailability | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;

  const record = value as Partial<StoredNodeAvailability>;
  if (!record.nodeName || !record.date || !record.checkedAt) return undefined;
  if (!Number.isFinite(record.availableCount) || !Number.isFinite(record.totalCount)) return undefined;

  const availableCount = Math.max(0, Math.floor(record.availableCount as number));
  const totalCount = Math.max(0, Math.floor(record.totalCount as number));
  return {
    nodeName: String(record.nodeName),
    date: String(record.date),
    checkedAt: String(record.checkedAt),
    availableCount,
    totalCount,
    percent:
      Number.isFinite(record.percent) && typeof record.percent === 'number'
        ? Math.min(100, Math.max(0, Math.round(record.percent)))
        : totalCount > 0
        ? Math.round((availableCount / totalCount) * 100)
        : 0,
    tone: record.tone === 'danger' || record.tone === 'warning' || record.tone === 'success'
      ? record.tone
      : getAvailabilityTone(availableCount)
  };
}

function createEmptyNodeHealthFile(): NodeHealthFile {
  return {
    version: currentNodeHealthVersion,
    availabilityByNode: {}
  };
}

function formatLocalDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
