import { win32 } from 'node:path';

export const windowsPowerShellModuleAnalysisCacheEnvironment = 'PSModuleAnalysisCachePath';
export const windowsPowerShellModulePathEnvironment = 'PSModulePath';

export function createWindowsPowerShellEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...source };
  for (const key of Object.keys(environment)) {
    const normalizedKey = key.toLowerCase();
    if (
      normalizedKey === windowsPowerShellModuleAnalysisCacheEnvironment.toLowerCase() ||
      normalizedKey === windowsPowerShellModulePathEnvironment.toLowerCase()
    ) {
      delete environment[key];
    }
  }

  // PowerShell 7 exports a module path that is incompatible with Windows PowerShell 5.1 when an
  // intermediate Node/NSIS process preserves it. Absence makes 5.1 rebuild its native defaults;
  // the separate NUL cache prevents concurrent 5.1 helpers from sharing an asynchronous cache file.
  environment[windowsPowerShellModuleAnalysisCacheEnvironment] = 'NUL';
  return environment;
}

export function resolveWindowsPowerShellPath(systemRoot = process.env.SystemRoot): string {
  const root = (systemRoot ?? 'C:\\Windows').trim();
  if (!root || root.includes('\0') || !win32.isAbsolute(root)) {
    throw new Error('Windows system root path is invalid');
  }
  return win32.join(win32.normalize(root), 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}
