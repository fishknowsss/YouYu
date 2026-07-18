export type UpdateDownloadPhase = 'downloading' | 'full-download' | 'verifying';

export const updateInstallingMessage = '已开始自动安装，无需操作';

export function getUpdateDownloadPhase(input: {
  previousPercent?: number;
  previousPhase?: UpdateDownloadPhase;
  percent?: number;
}): UpdateDownloadPhase {
  const percent = normalizePercent(input.percent);
  if (percent !== undefined && percent >= 100) return 'verifying';

  const previous = normalizePercent(input.previousPercent);
  if (previous !== undefined && percent !== undefined && previous >= 85 && percent + 10 < previous) {
    return 'full-download';
  }

  return input.previousPhase === 'full-download' ? 'full-download' : 'downloading';
}

export function normalizeUpdateBytes(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
  return Math.round(value);
}

function normalizePercent(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.max(0, Math.min(100, value));
}
