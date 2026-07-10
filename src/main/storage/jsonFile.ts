import { createHash, randomUUID } from 'node:crypto';
import { COPYFILE_EXCL } from 'node:constants';
import { copyFile, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

export type JsonReadResult<T> =
  | { status: 'found'; value: T; recoveredFromBackup: boolean }
  | { status: 'missing' }
  | { status: 'invalid'; raw: string };

type JsonReadOptions<T> = {
  repair?: (raw: string) => T | undefined;
  preserveInvalid?: boolean;
  validate?: (value: T) => boolean;
};

type JsonWriteOptions = {
  backupExisting?: boolean;
  preserveInvalid?: boolean;
};

export async function readJsonFile<T>(filePath: string, options: JsonReadOptions<T> = {}): Promise<JsonReadResult<T>> {
  let primary = await readJsonCandidate<T>(filePath);
  if (primary.status === 'found') {
    if (!options.validate || options.validate(primary.value)) {
      return { status: 'found', value: primary.value, recoveredFromBackup: false };
    }
    primary = { status: 'invalid', raw: primary.raw };
  }

  if (primary.status === 'invalid') {
    const repaired = options.repair?.(primary.raw);
    if (repaired !== undefined) {
      await writeJsonFileAtomic(filePath, repaired, { preserveInvalid: options.preserveInvalid });
      return { status: 'found', value: repaired, recoveredFromBackup: false };
    }
    if (options.preserveInvalid !== false) await preserveCorruptFile(filePath, primary.raw);
  }

  const backupPath = getBackupPath(filePath);
  let backup = await readJsonCandidate<T>(backupPath);
  if (backup.status === 'found') {
    if (!options.validate || options.validate(backup.value)) {
      await writeJsonFileAtomic(filePath, backup.value, { preserveInvalid: options.preserveInvalid });
      return { status: 'found', value: backup.value, recoveredFromBackup: true };
    }
    backup = { status: 'invalid', raw: backup.raw };
  }
  if (backup.status === 'invalid') {
    if (options.preserveInvalid !== false) await preserveCorruptFile(backupPath, backup.raw);
  }

  return primary;
}

export async function writeJsonFileAtomic(
  filePath: string,
  value: unknown,
  options: JsonWriteOptions = {}
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const current = await readJsonCandidate(filePath);
  if (current.status === 'found' && options.backupExisting !== false) {
    await copyFileAtomic(filePath, getBackupPath(filePath));
  } else if (current.status === 'invalid' && options.preserveInvalid !== false) {
    await preserveCorruptFile(filePath, current.raw);
  }

  if (options.backupExisting === false) {
    await rm(getBackupPath(filePath), { force: true });
  }

  await writeTextFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
  if (options.backupExisting === false) {
    await copyFileAtomic(filePath, getBackupPath(filePath));
  }
}

export async function removeJsonFile(filePath: string): Promise<void> {
  await Promise.all([rm(filePath, { force: true }), rm(getBackupPath(filePath), { force: true })]);
}

export function getBackupPath(filePath: string): string {
  return `${filePath}.bak`;
}

async function readJsonCandidate<T>(
  filePath: string
): Promise<{ status: 'found'; value: T; raw: string } | { status: 'missing' } | { status: 'invalid'; raw: string }> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return { status: 'missing' };
    throw error;
  }

  try {
    return { status: 'found', value: JSON.parse(raw) as T, raw };
  } catch {
    return { status: 'invalid', raw };
  }
}

async function preserveCorruptFile(filePath: string, raw: string): Promise<void> {
  const digest = createHash('sha256').update(raw).digest('hex').slice(0, 12);
  const corruptPath = `${filePath}.corrupt-${digest}`;
  try {
    await copyFile(filePath, corruptPath, COPYFILE_EXCL);
  } catch (error) {
    if (isNodeError(error) && (error.code === 'EEXIST' || error.code === 'ENOENT')) return;
    throw error;
  }
}

async function copyFileAtomic(sourcePath: string, targetPath: string): Promise<void> {
  const tempPath = createTempPath(targetPath);
  try {
    await copyFile(sourcePath, tempPath);
    await rename(tempPath, targetPath);
  } finally {
    await rm(tempPath, { force: true }).catch(() => undefined);
  }
}

async function writeTextFileAtomic(filePath: string, content: string): Promise<void> {
  const tempPath = createTempPath(filePath);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(tempPath, 'wx');
    await handle.writeFile(content, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(tempPath, filePath);
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(tempPath, { force: true }).catch(() => undefined);
  }
}

function createTempPath(filePath: string): string {
  return `${filePath}.tmp-${process.pid}-${randomUUID()}`;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
