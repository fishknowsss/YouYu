import { lstatSync } from 'node:fs';
import { win32 } from 'node:path';
import {
  createWindowsPowerShellEnvironment,
  windowsPowerShellModuleAnalysisCacheEnvironment,
  windowsPowerShellModulePathEnvironment
} from '../../src/main/platform/windowsPowerShell';

type CachePathProbe = (path: string) => boolean;

const isExistingRegularFile: CachePathProbe = (path) => {
  try {
    const stats = lstatSync(path);
    return stats.isFile() && !stats.isSymbolicLink();
  } catch {
    return false;
  }
};

export function isReusableWindowsPowerShellAnalysisCachePath(
  value: string | undefined,
  isRegularFile: CachePathProbe = isExistingRegularFile
): value is string {
  if (!value || value !== value.trim() || value.includes('\0')) return false;
  if (value.toLowerCase() === 'nul' || !/^[a-z]:\\/i.test(value) || !win32.isAbsolute(value)) return false;
  return isRegularFile(win32.normalize(value));
}

export function createWindowsPowerShellFixtureEnvironment(
  source: NodeJS.ProcessEnv = process.env,
  isRegularFile: CachePathProbe = isExistingRegularFile
): NodeJS.ProcessEnv {
  const environment = createWindowsPowerShellEnvironment(source);
  const inheritedCachePaths = Object.entries(source).filter(
    ([key]) => key.toLowerCase() === windowsPowerShellModuleAnalysisCacheEnvironment.toLowerCase()
  );
  if (
    inheritedCachePaths.length === 1 &&
    isReusableWindowsPowerShellAnalysisCachePath(inheritedCachePaths[0]?.[1], isRegularFile)
  ) {
    environment[windowsPowerShellModuleAnalysisCacheEnvironment] = inheritedCachePaths[0][1];
  }
  return environment;
}

export function prepareWindowsPowerShellFixtureEnvironment(target: NodeJS.ProcessEnv = process.env): void {
  const environment = createWindowsPowerShellFixtureEnvironment(target);
  for (const key of Object.keys(target)) {
    const normalizedKey = key.toLowerCase();
    if (
      normalizedKey === windowsPowerShellModulePathEnvironment.toLowerCase() ||
      normalizedKey === windowsPowerShellModuleAnalysisCacheEnvironment.toLowerCase()
    ) {
      delete target[key];
    }
  }
  const reusableCachePath = environment[windowsPowerShellModuleAnalysisCacheEnvironment];
  if (reusableCachePath) {
    target[windowsPowerShellModuleAnalysisCacheEnvironment] = reusableCachePath;
  }
}
