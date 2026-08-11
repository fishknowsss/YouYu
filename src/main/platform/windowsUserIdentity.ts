import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createWindowsPowerShellEnvironment, resolveWindowsPowerShellPath } from './windowsPowerShell';

const execFileAsync = promisify(execFile);

export type WindowsUserIdentity = {
  userSid: string;
  sessionId: number;
};

export type WindowsIdentityPowerShellRunner = (script: string) => Promise<string>;

export function normalizeWindowsUserSid(value: string): string {
  const sid = value.trim().toUpperCase();
  if (!/^S-1-\d+(?:-\d+){2,14}$/.test(sid)) throw new Error('invalid Windows user SID');
  if (['S-1-5-18', 'S-1-5-19', 'S-1-5-20'].includes(sid) || sid.startsWith('S-1-5-80-') || sid.endsWith('-500')) {
    throw new Error('Windows identity is not a standard user SID');
  }
  return sid;
}

export function buildSidBoundStartupTaskName(userSid: string): string {
  return `YouYu-Startup-${normalizeWindowsUserSid(userSid)}`;
}

export async function resolveCurrentWindowsUserIdentity(
  options: {
    platform?: NodeJS.Platform;
    processId?: number;
    runPowerShell?: WindowsIdentityPowerShellRunner;
  } = {}
): Promise<WindowsUserIdentity> {
  if ((options.platform ?? process.platform) !== 'win32') {
    throw new Error('Windows user identity is only available on Windows');
  }
  const processId = options.processId ?? process.pid;
  if (!Number.isSafeInteger(processId) || processId <= 0) throw new Error('invalid Windows process id');
  const runPowerShell = options.runPowerShell ?? defaultRunPowerShell;
  const script = [
    "$ErrorActionPreference = 'Stop'",
    '$identity = [Security.Principal.WindowsIdentity]::GetCurrent()',
    '$principal = New-Object Security.Principal.WindowsPrincipal($identity)',
    `$targetProcess = Get-Process -Id ${processId} -ErrorAction Stop`,
    '[pscustomobject]@{ userSid = $identity.User.Value; sessionId = [int] $targetProcess.SessionId; isElevated = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) } | ConvertTo-Json -Compress'
  ].join('; ');
  const raw = (await runPowerShell(script)).trim().replace(/^\uFEFF/, '');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error('invalid Windows identity response', { cause: error });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('invalid Windows identity response');
  }
  const candidate = parsed as { userSid?: unknown; sessionId?: unknown; isElevated?: unknown };
  if (typeof candidate.userSid !== 'string') throw new Error('invalid Windows identity SID');
  if (!Number.isSafeInteger(candidate.sessionId) || Number(candidate.sessionId) <= 0) {
    throw new Error('invalid Windows identity session');
  }
  if (typeof candidate.isElevated !== 'boolean') throw new Error('invalid Windows identity elevation state');
  if (candidate.isElevated) throw new Error('elevated Windows identity cannot own a user-scoped handoff');
  return {
    userSid: normalizeWindowsUserSid(candidate.userSid),
    sessionId: Number(candidate.sessionId)
  };
}

async function defaultRunPowerShell(script: string): Promise<string> {
  const { stdout } = await execFileAsync(
    resolveWindowsPowerShellPath(),
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'RemoteSigned', '-Command', script],
    { windowsHide: true, timeout: 5000, env: createWindowsPowerShellEnvironment() }
  );
  return String(stdout);
}
