import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, rename, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';

export type WindowsFullscreenProbe = {
  stop: () => void;
};

export function parseFullscreenProbeSample(value: string): boolean | undefined {
  const sample = value.trim();
  if (sample === '1') return true;
  if (sample === '0') return false;
  return undefined;
}

export function createFullscreenSuppressionStabilizer(
  onChange: (suppressed: boolean) => void,
  clearSampleThreshold = 2
): {
  update: (detected: boolean) => void;
  reset: () => void;
  isSuppressed: () => boolean;
} {
  const threshold = Math.max(1, Math.round(clearSampleThreshold));
  let suppressed = false;
  let consecutiveClearSamples = 0;

  return {
    update(detected) {
      if (detected) {
        consecutiveClearSamples = 0;
        if (suppressed) return;
        suppressed = true;
        onChange(true);
        return;
      }

      if (!suppressed) return;
      consecutiveClearSamples += 1;
      if (consecutiveClearSamples < threshold) return;
      consecutiveClearSamples = 0;
      suppressed = false;
      onChange(false);
    },
    reset() {
      consecutiveClearSamples = 0;
      if (!suppressed) return;
      suppressed = false;
      onChange(false);
    },
    isSuppressed: () => suppressed
  };
}

export function getNativeWindowHandleDecimal(handle: Buffer): string {
  if (handle.length >= 8) return handle.readBigUInt64LE(0).toString();
  if (handle.length >= 4) return BigInt(handle.readUInt32LE(0)).toString();
  throw new Error('unsupported native window handle');
}

export function createFullscreenProbeOutputConsumer(options: {
  isActive: () => boolean;
  onSample: (fullscreenOnPetMonitor: boolean) => void;
}): (chunk: string) => void {
  let received = '';

  return (chunk) => {
    if (!options.isActive()) return;
    received += chunk;
    const lines = received.split(/\r?\n/);
    received = lines.pop() ?? '';
    for (const line of lines) {
      if (!options.isActive()) return;
      const sample = parseFullscreenProbeSample(line);
      if (sample !== undefined) options.onSample(sample);
    }
  };
}

export async function prepareWindowsFullscreenProbeExecutable(options: {
  sourcePath: string;
  runtimeDirectory: string;
}): Promise<string> {
  const source = await readFile(options.sourcePath);
  const sourceDigest = createHash('sha256').update(source).digest('hex');
  const filename = `windows-fullscreen-probe-${sourceDigest.slice(0, 16)}.exe`;
  const destinationPath = join(options.runtimeDirectory, filename);
  await mkdir(options.runtimeDirectory, { recursive: true });

  if (!(await matchesDigest(destinationPath, sourceDigest))) {
    const temporaryPath = join(options.runtimeDirectory, `.windows-fullscreen-probe-${process.pid}-${Date.now()}.exe`);
    try {
      await copyFile(options.sourcePath, temporaryPath);
      if (!(await matchesDigest(temporaryPath, sourceDigest))) {
        throw new Error('fullscreen probe runtime copy failed integrity verification');
      }
      await rm(destinationPath, { force: true });
      try {
        await rename(temporaryPath, destinationPath);
      } catch (error) {
        if (!(await matchesDigest(destinationPath, sourceDigest))) throw error;
      }
    } finally {
      await rm(temporaryPath, { force: true });
    }
  }

  if (!(await matchesDigest(destinationPath, sourceDigest))) {
    throw new Error('fullscreen probe runtime executable failed integrity verification');
  }

  const entries = await readdir(options.runtimeDirectory, { withFileTypes: true });
  await Promise.all(
    entries
      .filter(
        (entry) =>
          entry.isFile() &&
          /^windows-fullscreen-probe-[a-f0-9]{16}\.exe$/i.test(entry.name) &&
          entry.name !== basename(destinationPath)
      )
      .map((entry) => rm(join(options.runtimeDirectory, entry.name), { force: true }).catch(() => undefined))
  );

  return destinationPath;
}

export function startWindowsFullscreenProbe(options: {
  helperPath: string;
  petWindowHandle: string;
  parentProcessId?: number;
  pollIntervalMs?: number;
  restartDelayMs?: number;
  onSample: (fullscreenOnPetMonitor: boolean) => void;
  onError: (error: Error) => void;
}): WindowsFullscreenProbe {
  if (!/^\d+$/.test(options.petWindowHandle)) throw new Error('invalid pet window handle');
  const parentProcessId = toPositiveInteger(options.parentProcessId ?? process.pid, 'parent process id');
  const pollIntervalMs = Math.max(250, Math.round(options.pollIntervalMs ?? 650));
  const initialRestartDelayMs = Math.max(1000, options.restartDelayMs ?? 5000);
  let restartDelayMs = initialRestartDelayMs;
  let restartTimer: ReturnType<typeof setTimeout> | undefined;
  let currentProcess: ReturnType<typeof spawn> | undefined;
  let stopped = false;

  const scheduleRestart = () => {
    if (stopped || restartTimer) return;
    restartTimer = setTimeout(() => {
      restartTimer = undefined;
      launch();
    }, restartDelayMs);
    restartTimer.unref();
    restartDelayMs = Math.min(60_000, restartDelayMs * 2);
  };

  const launch = () => {
    if (stopped) return;
    const child = spawn(
      options.helperPath,
      [options.petWindowHandle, String(parentProcessId), String(pollIntervalMs)],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
    );
    currentProcess = child;
    let completed = false;
    let stderr = '';

    const fail = (error: Error) => {
      if (completed || stopped) return;
      completed = true;
      if (currentProcess === child) currentProcess = undefined;
      options.onError(error);
      scheduleRestart();
    };

    const consumeOutput = createFullscreenProbeOutputConsumer({
      isActive: () => !stopped && !completed,
      onSample: (sample) => {
        restartDelayMs = initialRestartDelayMs;
        options.onSample(sample);
      }
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', consumeOutput);
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-2000);
    });
    child.once('error', (error) => fail(error));
    child.once('exit', (code) => {
      if (stopped) return;
      const detail = stderr.trim();
      fail(new Error(detail || `全屏检测进程意外退出：${code ?? 'unknown'}`));
    });
  };

  launch();
  return {
    stop() {
      if (stopped) return;
      stopped = true;
      if (restartTimer) {
        clearTimeout(restartTimer);
        restartTimer = undefined;
      }
      currentProcess?.kill();
      currentProcess = undefined;
    }
  };
}

async function matchesDigest(path: string, expectedDigest: string): Promise<boolean> {
  try {
    const content = await readFile(path);
    return createHash('sha256').update(content).digest('hex') === expectedDigest;
  } catch {
    return false;
  }
}

function toPositiveInteger(value: number, label: string): number {
  const integer = Math.round(value);
  if (!Number.isSafeInteger(integer) || integer <= 0) throw new Error(`invalid ${label}`);
  return integer;
}
