import { readFileSync } from 'node:fs';

export type AppVersionOptions = {
  isPackaged: boolean;
  packagedVersion: string;
  developmentPackagePath: string;
  readFile?: (path: string) => string;
};

export function resolveAppVersion(options: AppVersionOptions): string {
  if (options.isPackaged) return normalizeVersion(options.packagedVersion) ?? '0.0.0';

  try {
    const readFile = options.readFile ?? ((path: string) => readFileSync(path, 'utf8'));
    const parsed = JSON.parse(readFile(options.developmentPackagePath)) as { version?: unknown };
    return normalizeVersion(parsed.version) ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function normalizeVersion(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
