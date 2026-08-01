import type { SystemProxyAdapter } from '../lifecycle';
import { RuntimeOperationError } from '../runtimeRecoveryPolicy';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { readJsonFile, removeJsonFile, writeJsonFileAtomic } from '../storage/jsonFile';

const execFileAsync = promisify(execFile);
const internetSettingsKey = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
const refreshInternetSettingsScript = `
$ErrorActionPreference = 'Stop';
$signature = '[DllImport("wininet.dll", SetLastError=true)] public static extern bool InternetSetOption(IntPtr hInternet, int dwOption, IntPtr lpBuffer, int dwBufferLength);';
$type = Add-Type -MemberDefinition $signature -Name WinInet -Namespace Native -PassThru;
$settingsChanged = $type::InternetSetOption([IntPtr]::Zero, 39, [IntPtr]::Zero, 0);
$settingsRefreshed = $type::InternetSetOption([IntPtr]::Zero, 37, [IntPtr]::Zero, 0);
if (-not $settingsChanged -or -not $settingsRefreshed) {
  $errorCode = [Runtime.InteropServices.Marshal]::GetLastWin32Error();
  throw "Failed to refresh WinINet proxy settings: $errorCode";
}
`;

type PreviousProxyState = {
  enabled: boolean;
  server: string;
  override: string;
};

type ProxyOwnershipState = {
  version: 2;
  capturedAt: string;
  previous: PreviousProxyState;
  applied: PreviousProxyState;
  appliedFields: Record<keyof PreviousProxyState, boolean>;
};

export type SystemProxyCommand = {
  file: string;
  args: string[];
};

export type SystemProxyOptions = {
  platform?: NodeJS.Platform;
  runCommand?: (command: SystemProxyCommand) => Promise<string>;
  runElevatedCommand?: (command: SystemProxyCommand, signal?: AbortSignal) => Promise<void>;
  shouldManageProxy?: () => Promise<boolean>;
  getProxyServer?: () => string;
  stateDirectory?: string;
};

export type RepairableSystemProxyAdapter = SystemProxyAdapter & {
  disableForRepair: (signal?: AbortSignal) => Promise<void>;
  flushDnsForRepair: (signal?: AbortSignal) => Promise<void>;
  repairSystemNetwork: (signal?: AbortSignal) => Promise<void>;
};

const proxyOwnershipFileName = 'system-proxy-ownership.json';

const proxyOverride = [
  'localhost',
  '127.*',
  '10.*',
  '172.16.*',
  '172.17.*',
  '172.18.*',
  '172.19.*',
  '172.20.*',
  '172.21.*',
  '172.22.*',
  '172.23.*',
  '172.24.*',
  '172.25.*',
  '172.26.*',
  '172.27.*',
  '172.28.*',
  '172.29.*',
  '172.30.*',
  '172.31.*',
  '192.168.*',
  '*.local',
  '*.lan',
  '*.cn',
  '*.qq.com',
  '*.tencent.com',
  '*.weixin.qq.com',
  '*.wechat.com',
  '*.alipay.com',
  '*.taobao.com',
  '*.tmall.com',
  '*.jd.com',
  '*.bilibili.com',
  '<local>'
].join(';');

const microsoftStoreLoopbackPackageNames = [
  'Microsoft.WindowsStore',
  'Microsoft.StorePurchaseApp',
  'Microsoft.Services.Store.Engagement',
  'Microsoft.DesktopAppInstaller',
  'Microsoft.GamingApp',
  'Microsoft.XboxApp',
  'Microsoft.XboxGamingOverlay',
  'Microsoft.XboxIdentityProvider'
];
const microsoftStoreLoopbackQueryScript = `
$ErrorActionPreference = 'Stop';
$names = @(${microsoftStoreLoopbackPackageNames.map((name) => `'${name}'`).join(',')});
foreach ($name in $names) {
  Get-AppxPackage -Name $name -ErrorAction Stop |
    Select-Object -ExpandProperty PackageFamilyName -Unique
}
`;

async function defaultRunCommand(command: SystemProxyCommand): Promise<string> {
  const { stdout } = await execFileAsync(command.file, command.args, {
    windowsHide: true
  });
  return stdout;
}

function parseEnabled(output: string): boolean {
  return /0x1\b/i.test(output);
}

function parseStringValue(output: string, valueName: string): string {
  const escapedName = valueName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = output.match(new RegExp(`${escapedName}\\s+REG_SZ\\s+(.+)`, 'i'));
  return match?.[1]?.trim() ?? '';
}

export function createSystemProxyAdapter(options: SystemProxyOptions = {}): RepairableSystemProxyAdapter {
  const platform = options.platform ?? process.platform;
  const runCommand = options.runCommand ?? defaultRunCommand;
  const shouldManageProxy = options.shouldManageProxy ?? (async () => true);
  const runElevatedCommand = options.runElevatedCommand;
  const getProxyServer = options.getProxyServer ?? (() => '127.0.0.1:7890');
  const ownershipFilePath = options.stateDirectory ? join(options.stateDirectory, proxyOwnershipFileName) : undefined;
  let previous: PreviousProxyState | null = null;
  let activeOwnership: ProxyOwnershipState | null = null;
  let enabledByApp = false;

  function reg(args: string[]): Promise<string> {
    return runCommand({ file: 'reg.exe', args });
  }

  function notifySettingsChanged(): Promise<string> {
    return runCommand({
      file: 'powershell.exe',
      args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', refreshInternetSettingsScript]
    });
  }

  async function queryOptionalStringValue(valueName: 'ProxyServer' | 'ProxyOverride'): Promise<string> {
    try {
      return await reg(['query', internetSettingsKey, '/v', valueName]);
    } catch (error) {
      if (isMissingRegistryValueError(error)) return '';
      throw error;
    }
  }

  async function queryPrevious(): Promise<PreviousProxyState> {
    const [enabledOutput, serverOutput, overrideOutput] = await Promise.all([
      reg(['query', internetSettingsKey, '/v', 'ProxyEnable']),
      queryOptionalStringValue('ProxyServer'),
      queryOptionalStringValue('ProxyOverride')
    ]);

    return {
      enabled: parseEnabled(enabledOutput),
      server: parseStringValue(serverOutput, 'ProxyServer'),
      override: parseStringValue(overrideOutput, 'ProxyOverride')
    };
  }

  async function queryProxyEnabled(): Promise<boolean> {
    return parseEnabled(await reg(['query', internetSettingsKey, '/v', 'ProxyEnable']));
  }

  async function verifyAppliedProxy(expected: PreviousProxyState): Promise<void> {
    const current = await queryPrevious();
    if (
      current.enabled === expected.enabled &&
      current.server === expected.server &&
      current.override === expected.override
    ) {
      return;
    }
    throw new Error(
      `Failed to verify current-user proxy after enable: ProxyEnable=${current.enabled}, ProxyServer=${JSON.stringify(current.server)}, ProxyOverride=${JSON.stringify(current.override)}`
    );
  }

  async function queryProxyStrings(): Promise<Pick<PreviousProxyState, 'server' | 'override'>> {
    const output = await reg(['query', internetSettingsKey]);
    return {
      server: parseStringValue(output, 'ProxyServer'),
      override: parseStringValue(output, 'ProxyOverride')
    };
  }

  async function setProxyEnabled(enabled: boolean) {
    await reg(['add', internetSettingsKey, '/v', 'ProxyEnable', '/t', 'REG_DWORD', '/d', enabled ? '1' : '0', '/f']);
  }

  async function setProxyServer(server: string) {
    if (!server) {
      await reg(['delete', internetSettingsKey, '/v', 'ProxyServer', '/f']);
      return;
    }

    await reg(['add', internetSettingsKey, '/v', 'ProxyServer', '/t', 'REG_SZ', '/d', server, '/f']);
  }

  async function setProxyOverride(override: string) {
    if (!override) {
      await reg(['delete', internetSettingsKey, '/v', 'ProxyOverride', '/f']);
      return;
    }

    await reg(['add', internetSettingsKey, '/v', 'ProxyOverride', '/t', 'REG_SZ', '/d', override, '/f']);
  }

  async function clearProxyStringsForRepair(): Promise<void> {
    const before = await queryProxyStrings();
    const failures: unknown[] = [];
    const deletions = await Promise.allSettled([
      ...(before.server ? [reg(['delete', internetSettingsKey, '/v', 'ProxyServer', '/f'])] : []),
      ...(before.override ? [reg(['delete', internetSettingsKey, '/v', 'ProxyOverride', '/f'])] : [])
    ]);
    failures.push(...rejectedReasons(deletions));

    try {
      await notifySettingsChanged();
    } catch (error) {
      failures.push(error);
    }

    try {
      const current = await queryProxyStrings();
      if (current.server || current.override) {
        failures.push(
          new Error(
            `Proxy strings remain after repair: ProxyServer=${JSON.stringify(current.server)}, ProxyOverride=${JSON.stringify(current.override)}`
          )
        );
      }
    } catch (error) {
      failures.push(error);
    }

    throwCollectedFailures(failures, 'Failed to clear current-user proxy configuration for repair');
  }

  async function resetWinHttpProxy() {
    const command = { file: 'netsh.exe', args: ['winhttp', 'reset', 'proxy'] };
    if (runElevatedCommand) {
      await runElevatedCommand(command);
      return;
    }
    await runCommand(command);
  }

  async function flushDnsCache(signal?: AbortSignal) {
    signal?.throwIfAborted();
    await runCommand({ file: 'ipconfig.exe', args: ['/flushdns'] });
    signal?.throwIfAborted();
  }

  async function queryMicrosoftStorePackageFamilies(): Promise<string[]> {
    const output = await runCommand({
      file: 'powershell.exe',
      args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', microsoftStoreLoopbackQueryScript]
    });
    return [
      ...new Set(
        output
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(isPackageFamilyName)
      )
    ];
  }

  async function ensureMicrosoftStoreLoopbackExemptions(options: { strict?: boolean; signal?: AbortSignal } = {}) {
    options.signal?.throwIfAborted();
    const failures: string[] = [];
    let installedPackageFamilies: string[];
    try {
      installedPackageFamilies = await queryMicrosoftStorePackageFamilies();
    } catch (error) {
      if (options.strict) throw error;
      return;
    }
    if (installedPackageFamilies.length === 0) return;

    let existing = '';
    try {
      existing = await runCommand({ file: 'CheckNetIsolation.exe', args: ['LoopbackExempt', '-s'] });
    } catch (error) {
      if (options.strict) throw error;
    }

    const normalizedExisting = existing.toLowerCase();
    const missing = installedPackageFamilies.filter(
      (packageFamilyName) => !normalizedExisting.includes(packageFamilyName.toLowerCase())
    );
    if (missing.length === 0) return;

    if (runElevatedCommand && options.strict) {
      const script = [
        "$ErrorActionPreference = 'Stop'",
        `$families = @(${missing.map((name) => `'${name}'`).join(',')})`,
        'foreach ($family in $families) { & CheckNetIsolation.exe LoopbackExempt -a "-n=$family" | Out-Null }'
      ].join('; ');
      await runElevatedCommand(
        {
          file: 'powershell.exe',
          args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script]
        },
        options.signal
      );
      return;
    }

    for (const packageFamilyName of missing) {
      await runCommand({
        file: 'CheckNetIsolation.exe',
        args: ['LoopbackExempt', '-a', `-n="${packageFamilyName}"`]
      }).catch((error) => {
        if (options.strict)
          failures.push(`${packageFamilyName}: ${error instanceof Error ? error.message : String(error)}`);
      });
    }

    if (failures.length > 0) {
      throw new Error(`Store loopback exemption failed: ${failures.join('; ')}`);
    }
  }

  async function runPrivilegedRepair(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (!runElevatedCommand) {
      const results = await Promise.allSettled([
        resetWinHttpProxy(),
        ensureMicrosoftStoreLoopbackExemptions({ strict: true, signal })
      ]);
      throwCollectedFailures(rejectedReasons(results), 'Privileged network repair failed');
      return;
    }

    const installedPackageFamilies = await queryMicrosoftStorePackageFamilies();
    const script = [
      "$ErrorActionPreference = 'Stop'",
      '$failures = [System.Collections.Generic.List[string]]::new()',
      '& netsh.exe winhttp reset proxy | Out-Null',
      'if ($LASTEXITCODE -ne 0) { $failures.Add("netsh winhttp reset proxy failed with exit code $LASTEXITCODE") }',
      `$families = @(${installedPackageFamilies.map((name) => `'${name}'`).join(',')})`,
      'foreach ($family in $families) { & CheckNetIsolation.exe LoopbackExempt -a "-n=$family" | Out-Null; if ($LASTEXITCODE -ne 0) { $failures.Add("CheckNetIsolation LoopbackExempt failed for $family with exit code $LASTEXITCODE") } }',
      '$loopbackOutput = (& CheckNetIsolation.exe LoopbackExempt -s | Out-String)',
      'if ($LASTEXITCODE -ne 0) { $failures.Add("CheckNetIsolation LoopbackExempt verification failed with exit code $LASTEXITCODE") } else { foreach ($family in $families) { if ($loopbackOutput.IndexOf($family, [StringComparison]::OrdinalIgnoreCase) -lt 0) { $failures.Add("Store loopback verification missing package family $family") } } }',
      "if ($failures.Count -gt 0) { throw ($failures -join '; ') }"
    ].join('; ');
    await runElevatedCommand(
      {
        file: 'powershell.exe',
        args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script]
      },
      signal
    );
  }

  async function readOwnershipState(): Promise<ProxyOwnershipState | null> {
    if (!ownershipFilePath) return null;
    const result = await readJsonFile<unknown>(ownershipFilePath, {
      validate: (value) => normalizeOwnershipState(value) !== null
    });
    if (result.status === 'missing') return null;
    if (result.status === 'invalid') {
      throw new RuntimeOperationError(
        'PROXY_RESTORE_REQUIRED',
        'Invalid system proxy ownership state; automatic proxy changes are blocked'
      );
    }
    const ownership = normalizeOwnershipState(result.value);
    if (!ownership) {
      throw new RuntimeOperationError(
        'PROXY_RESTORE_REQUIRED',
        'Invalid system proxy ownership state; automatic proxy changes are blocked'
      );
    }
    return ownership;
  }

  async function writeOwnershipState(state: ProxyOwnershipState): Promise<void> {
    if (!ownershipFilePath) return;
    await writeJsonFileAtomic(ownershipFilePath, state);
  }

  async function clearOwnershipState(): Promise<void> {
    if (!ownershipFilePath) return;
    await removeJsonFile(ownershipFilePath);
  }

  function clearInMemoryOwnership(): void {
    previous = null;
    activeOwnership = null;
    enabledByApp = false;
  }

  async function restoreOwnership(ownership: ProxyOwnershipState): Promise<void> {
    const current = await queryPrevious();
    const appliedFieldNames = (['enabled', 'server', 'override'] as const).filter(
      (field) => ownership.appliedFields[field]
    );
    if (appliedFieldNames.length === 0) {
      await clearOwnershipState();
      clearInMemoryOwnership();
      return;
    }

    const serverWasReplacedByUser =
      ownership.appliedFields.server &&
      current.server !== ownership.applied.server &&
      current.server !== ownership.previous.server;
    const restorableFields = appliedFieldNames.filter(
      (field) => current[field] === ownership.applied[field] && !(field === 'enabled' && serverWasReplacedByUser)
    );
    if (restorableFields.includes('server')) await setProxyServer(ownership.previous.server);
    if (restorableFields.includes('override')) await setProxyOverride(ownership.previous.override);
    if (restorableFields.includes('enabled')) await setProxyEnabled(ownership.previous.enabled);
    await notifySettingsChanged();
    const restored = await queryPrevious();
    const unverifiedFields = restorableFields.filter((field) => restored[field] !== ownership.previous[field]);
    if (unverifiedFields.length > 0) {
      throw new RuntimeOperationError(
        'PROXY_RESTORE_REQUIRED',
        `Failed to verify current-user proxy after restore: ${unverifiedFields.join(', ')}`
      );
    }
    await clearOwnershipState();
    clearInMemoryOwnership();
  }

  async function reconcilePersistedOwnership(): Promise<void> {
    try {
      const ownership = await readOwnershipState();
      if (ownership) await restoreOwnership(ownership);
    } catch (error) {
      throw asProxyRestoreError(error);
    }
  }

  async function disableForRepair(signal?: AbortSignal): Promise<void> {
    if (platform !== 'win32') return;
    signal?.throwIfAborted();
    await setProxyEnabled(false);
    await notifySettingsChanged();
    signal?.throwIfAborted();
    if (await queryProxyEnabled()) {
      throw new Error('Failed to disable current-user proxy for repair: ProxyEnable is still enabled');
    }
    await clearOwnershipState();
    clearInMemoryOwnership();
  }

  async function repairSystemNetwork(signal?: AbortSignal): Promise<void> {
    if (platform !== 'win32') return;
    signal?.throwIfAborted();
    const results = await Promise.allSettled([
      clearProxyStringsForRepair(),
      flushDnsCache(signal),
      runPrivilegedRepair(signal)
    ]);
    throwCollectedFailures(rejectedReasons(results), 'System network repair failed');
  }

  return {
    async enable(signal) {
      if (platform !== 'win32') return;
      signal?.throwIfAborted();
      if (enabledByApp) return;
      const shouldManage = await shouldManageProxy();
      await reconcilePersistedOwnership();
      if (!shouldManage) return;
      previous = await queryPrevious();
      const applied: PreviousProxyState = {
        enabled: true,
        server: getProxyServer(),
        override: proxyOverride
      };
      const ownership: ProxyOwnershipState = {
        version: 2,
        capturedAt: new Date().toISOString(),
        previous,
        applied,
        appliedFields: { server: false, override: false, enabled: false }
      };
      await writeOwnershipState(ownership);
      activeOwnership = ownership;
      enabledByApp = true;
      try {
        ownership.appliedFields.server = true;
        await writeOwnershipState(ownership);
        await setProxyServer(applied.server);
        ownership.appliedFields.override = true;
        await writeOwnershipState(ownership);
        await setProxyOverride(applied.override);
        ownership.appliedFields.enabled = true;
        await writeOwnershipState(ownership);
        await setProxyEnabled(applied.enabled);
        await notifySettingsChanged();
        await verifyAppliedProxy(applied);
        await ensureMicrosoftStoreLoopbackExemptions({ strict: Boolean(runElevatedCommand), signal });
      } catch (error) {
        try {
          await restoreOwnership(ownership);
        } catch (restoreError) {
          const proxyRestoreError = asProxyRestoreError(restoreError);
          throw new AggregateError(
            [error, proxyRestoreError],
            'system proxy enable and proxy ownership recovery failed',
            { cause: restoreError }
          );
        }
        throw error;
      }
    },
    async restore() {
      if (platform !== 'win32') return;
      try {
        if (!enabledByApp) {
          await reconcilePersistedOwnership();
          return;
        }
        const ownership = activeOwnership ?? (await readOwnershipState());
        if (ownership) await restoreOwnership(ownership);
      } catch (error) {
        throw asProxyRestoreError(error);
      }
    },
    disableForRepair,
    flushDnsForRepair: flushDnsCache,
    repairSystemNetwork,
    async repair(signal) {
      await disableForRepair(signal);
      await repairSystemNetwork(signal);
    }
  };
}

function isMissingRegistryValueError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { message?: unknown; stderr?: unknown; stdout?: unknown };
  const detail = [candidate.message, candidate.stderr, candidate.stdout]
    .filter((value): value is string => typeof value === 'string')
    .join('\n');
  return /unable to find the specified registry (?:key or )?value|cannot find the file specified|找不到指定的注册表(?:项或值|值)|系统找不到指定的文件/i.test(
    detail
  );
}

function asProxyRestoreError(error: unknown): RuntimeOperationError {
  if (error instanceof RuntimeOperationError && error.code === 'PROXY_RESTORE_REQUIRED') return error;
  const detail = error instanceof Error ? error.message : String(error);
  return new RuntimeOperationError(
    'PROXY_RESTORE_REQUIRED',
    `Failed to restore current-user proxy ownership safely: ${detail}`,
    { cause: error }
  );
}

function normalizeOwnershipState(value: unknown): ProxyOwnershipState | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Partial<Omit<ProxyOwnershipState, 'version'>> & { version?: number };
  const previous = normalizeProxyState(candidate.previous);
  const applied = normalizeProxyState(candidate.applied);
  if ((candidate.version !== 1 && candidate.version !== 2) || !previous || !applied) return null;
  const fields = candidate.version === 1 ? undefined : normalizeAppliedFields(candidate.appliedFields);
  if (candidate.version === 2 && !fields) return null;
  return {
    version: 2,
    capturedAt: typeof candidate.capturedAt === 'string' ? candidate.capturedAt : '',
    previous,
    applied,
    appliedFields: fields ?? { enabled: true, server: true, override: true }
  };
}

function normalizeAppliedFields(value: unknown): ProxyOwnershipState['appliedFields'] | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const fields = value as Partial<ProxyOwnershipState['appliedFields']>;
  if (
    typeof fields.enabled !== 'boolean' ||
    typeof fields.server !== 'boolean' ||
    typeof fields.override !== 'boolean'
  ) {
    return null;
  }
  return { enabled: fields.enabled, server: fields.server, override: fields.override };
}

function normalizeProxyState(value: unknown): PreviousProxyState | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Partial<PreviousProxyState>;
  if (
    typeof candidate.enabled !== 'boolean' ||
    typeof candidate.server !== 'string' ||
    typeof candidate.override !== 'string'
  ) {
    return null;
  }
  return {
    enabled: candidate.enabled,
    server: candidate.server,
    override: candidate.override
  };
}

function isPackageFamilyName(value: string): boolean {
  return /^[A-Za-z0-9.]+_[A-Za-z0-9]+$/.test(value);
}

function rejectedReasons(results: PromiseSettledResult<unknown>[]): unknown[] {
  return results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []));
}

function throwCollectedFailures(failures: unknown[], message: string): void {
  if (failures.length === 0) return;
  if (failures.length === 1) throw failures[0];
  throw new AggregateError(failures, message);
}
