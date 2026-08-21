import { join } from 'node:path';
import { readJsonFile, removeJsonFile, writeJsonFileAtomic } from '../storage/jsonFile';

export type TrafficJournalEntry = {
  id: string;
  upload: number;
  download: number;
  recordedAt: string;
  nodeName?: string;
  durationMs?: number;
};

export type TrafficJournal = {
  read: () => Promise<TrafficJournalEntry[]>;
  append: (entry: TrafficJournalEntry) => Promise<void>;
  remove: (ids: readonly string[]) => Promise<void>;
};

type TrafficJournalFile = {
  version: 1;
  entries: TrafficJournalEntry[];
};

const trafficJournalFileName = 'traffic-journal.json';

export function createTrafficJournal(baseDir: string): TrafficJournal {
  const filePath = join(baseDir, trafficJournalFileName);

  async function read(): Promise<TrafficJournalEntry[]> {
    const result = await readJsonFile<unknown>(filePath, {
      validate: (value) => normalizeJournalFile(value) !== undefined
    });
    if (result.status === 'missing') return [];
    if (result.status === 'invalid') throw new Error('traffic journal is invalid');
    return normalizeJournalFile(result.value)?.entries ?? [];
  }

  return {
    read,
    async append(entry) {
      const normalized = normalizeJournalEntry(entry);
      if (!normalized) throw new Error('traffic journal entry is invalid');
      const entries = await read();
      if (entries.some((current) => current.id === normalized.id)) return;
      await writeJsonFileAtomic(
        filePath,
        { version: 1, entries: [...entries, normalized] } satisfies TrafficJournalFile,
        { preserveInvalid: false }
      );
    },
    async remove(ids) {
      const removed = new Set(ids);
      if (removed.size === 0) return;
      const remaining = (await read()).filter((entry) => !removed.has(entry.id));
      if (remaining.length === 0) {
        await removeJsonFile(filePath);
        return;
      }
      await writeJsonFileAtomic(filePath, { version: 1, entries: remaining } satisfies TrafficJournalFile, {
        preserveInvalid: false
      });
    }
  };
}

function normalizeJournalFile(value: unknown): TrafficJournalFile | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const candidate = value as Partial<TrafficJournalFile>;
  if (candidate.version !== 1 || !Array.isArray(candidate.entries)) return undefined;
  const entries = candidate.entries.map(normalizeJournalEntry);
  if (entries.some((entry) => !entry)) return undefined;
  const normalized = entries as TrafficJournalEntry[];
  if (new Set(normalized.map((entry) => entry.id)).size !== normalized.length) return undefined;
  return { version: 1, entries: normalized };
}

function normalizeJournalEntry(value: unknown): TrafficJournalEntry | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const candidate = value as Partial<TrafficJournalEntry>;
  const id = typeof candidate.id === 'string' ? candidate.id.trim().toLowerCase() : '';
  const recordedAt = typeof candidate.recordedAt === 'string' ? candidate.recordedAt : '';
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)) {
    return undefined;
  }
  if (!Number.isFinite(Date.parse(recordedAt))) return undefined;
  const upload = normalizeNonNegativeInteger(candidate.upload);
  const download = normalizeNonNegativeInteger(candidate.download);
  const durationMs = normalizeNonNegativeInteger(candidate.durationMs);
  const nodeName = typeof candidate.nodeName === 'string' ? candidate.nodeName.trim() : '';
  if (nodeName.length > 256) return undefined;
  return {
    id,
    upload,
    download,
    recordedAt,
    nodeName: nodeName || undefined,
    durationMs: durationMs || undefined
  };
}

function normalizeNonNegativeInteger(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}
