import type { SystemProxyAdapter } from '../lifecycle';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { readJsonFile, removeJsonFile, writeJsonFileAtomic } from '../storage/jsonFile';

const execFileAsync = promisify(execFile);
const internetSettingsKey = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
const refreshInternetSettingsScript = `
$signature = '[DllImport("wininet.dll", SetLastError=true)] public static extern bool InternetSetOption(IntPtr hInternet, int dwOption, IntPtr lpBuffer, int dwBufferLength);';
$type = Add-Type -MemberDefinition $signature -Name WinInet -Namespace Native -PassThru;
$type::InternetSetOption([IntPtr]::Zero, 39, [IntPtr]::Zero, 0);
$type::InternetSetOption([IntPtr]::Zero, 37, [IntPtr]::Zero, 0);
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
$names = @(${microsoftStoreLoopbackPackageNames.map((name) => `'${name}'`).join(',')});
foreach ($name in $names) {
  Get-AppxPackage -Name $name -ErrorAction SilentlyContinue |
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

export function createSystemProxyAdapter(options: SystemProxyOptions = {}): SystemProxyAdapter {
  const platform = options.platform ?? process.platform;
  const runCommand = options.runCommand ?? defaultRunCommand;
  const shouldManageProxy = options.shouldManageProxy ?? (async () => true);
  const runElevatedCommand = options.runElevatedCommand;
  const getProxyServer = options.getProxyServer ?? (() => '127.0.0.1:7890');
  const ownershipFilePath = options.stateDirectory ? join(options.stateDirectory, proxyOwnershipFileName) : undefined;
  let previous: PreviousProxyState | null = null;
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

  async function queryPrevious(): Promise<PreviousProxyState> {
    const [enabledOutput, serverOutput, overrideOutput] = await Promise.all([
      reg(['query', internetSettingsKey, '/v', 'ProxyEnable']),
      reg(['query', internetSettingsKey, '/v', 'ProxyServer']).catch(() => ''),
      reg(['query', internetSettingsKey, '/v', 'ProxyOverride']).catch(() => '')
    ]);

    return {
      enabled: parseEnabled(enabledOutput),
      server: parseStringValue(serverOutput, 'ProxyServer'),
      override: parseStringValue(overrideOutput, 'ProxyOverride')
    };
  }

  async function setProxyEnabled(enabled: boolean) {
    await reg(['add', internetSettingsKey, '/v', 'ProxyEnable', '/t', 'REG_DWORD', '/d', enabled ? '1' : '0', '/f']);
  }

  async function setProxyServer(server: string) {
    if (!server) {
      await reg(['delete', internetSettingsKey, '/v', 'ProxyServer', '/f']).catch(() => '');
      return;
    }

    await reg(['add', internetSettingsKey, '/v', 'ProxyServer', '/t', 'REG_SZ', '/d', server, '/f']);
  }

  async function setProxyOverride(override: string) {
    if (!override) {
      await reg(['delete', internetSettingsKey, '/v', 'ProxyOverride', '/f']).catch(() => '');
      return;
    }

    await reg(['add', internetSettingsKey, '/v', 'ProxyOverride', '/t', 'REG_SZ', '/d', override, '/f']);
  }

  async function setProxy(enabled: boolean, server?: string, override?: string) {
    if (server !== undefined) {
      await setProxyServer(server);
    }
    if (override !== undefined) {
      await setProxyOverride(override);
    }

    await setProxyEnabled(enabled);
    await notifySettingsChanged();
  }

  async function resetWinHttpProxy() {
    const command = { file: 'netsh.exe', args: ['winhttp', 'reset', 'proxy'] };
    if (runElevatedCommand) {
      await runElevatedCommand(command);
      return;
    }
    await runCommand(command);
  }

  async function flushDnsCache() {
    await runCommand({ file: 'ipconfig.exe', args: ['/flushdns'] });
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
      await resetWinHttpProxy();
      await ensureMicrosoftStoreLoopbackExemptions({ strict: true });
      return;
    }

    const installedPackageFamilies = await queryMicrosoftStorePackageFamilies().catch(() => []);
    const script = [
      "$ErrorActionPreference = 'Stop'",
      '& netsh.exe winhttp reset proxy | Out-Null',
      `$families = @(${installedPackageFamilies.map((name) => `'${name}'`).join(',')})`,
      'foreach ($family in $families) { & CheckNetIsolation.exe LoopbackExempt -a "-n=$family" | Out-Null }'
    ].join('; ');
    await runElevatedCommand(
      {
        file: 'powershell.exe',
        args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script]
      },
      signal
    );
  }

  async function restorePrevious() {
    if (!previous) {
      await setProxy(false, '', '');
      return;
    }

    if (previous.enabled && !previous.server) {
      await setProxy(false, previous.server, previous.override);
      return;
    }

    await setProxy(previous.enabled, previous.server, previous.override);
  }

  async function readOwnershipState(): Promise<ProxyOwnershipState | null> {
    if (!ownershipFilePath) return null;
    const result = await readJsonFile<unknown>(ownershipFilePath, {
      validate: (value) => normalizeOwnershipState(value) !== null
    });
    if (result.status !== 'found') return null;
    const ownership = normalizeOwnershipState(result.value);
    if (!ownership) {
      await clearOwnershipState();
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

  async function reconcilePersistedOwnership(shouldManage: boolean): Promise<void> {
    const ownership = await readOwnershipState();
    if (!ownership) return;

    const current = await queryPrevious();
    const appliedFieldNames = (['enabled', 'server', 'override'] as const).filter(
      (field) => ownership.appliedFields[field]
    );
    const userChangedManagedState = appliedFieldNames.some(
      (field) => current[field] !== ownership.applied[field] && current[field] !== ownership.previous[field]
    );
    if (appliedFieldNames.length === 0 || userChangedManagedState) {
      await clearOwnershipState();
      return;
    }

    if (ownership.appliedFields.server) await setProxyServer(ownership.previous.server);
    if (ownership.appliedFields.override) await setProxyOverride(ownership.previous.override);
    if (ownership.appliedFields.enabled) await setProxyEnabled(ownership.previous.enabled);
    await notifySettingsChanged();
    await clearOwnershipState();
    previous = null;
    enabledByApp = false;

    if (!shouldManage) return;
  }

  return {
    async enable(signal) {
      if (platform !== 'win32') return;
      signal?.throwIfAborted();
      if (enabledByApp) return;
      const shouldManage = await shouldManageProxy();
      await reconcilePersistedOwnership(shouldManage);
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
        await ensureMicrosoftStoreLoopbackExemptions({ strict: Boolean(runElevatedCommand), signal });
      } catch (error) {
        const restored = await restorePrevious().then(
          () => true,
          () => false
        );
        if (restored) {
          await clearOwnershipState().catch(() => undefined);
        }
        previous = null;
        enabledByApp = false;
        throw error;
      }
    },
    async restore() {
      if (platform !== 'win32') return;
      if (!enabledByApp) {
        await reconcilePersistedOwnership(false);
        return;
      }
      await restorePrevious();
      await clearOwnershipState();
      previous = null;
      enabledByApp = false;
    },
    async repair(signal) {
      if (platform !== 'win32') return;
      signal?.throwIfAborted();
      const results = await Promise.allSettled([setProxy(false, '', ''), flushDnsCache(), runPrivilegedRepair(signal)]);
      if (results[0]?.status === 'fulfilled') {
        await clearOwnershipState();
      }
      previous = null;
      enabledByApp = false;

      const failure = results.find((result) => result.status === 'rejected');
      if (failure?.status === 'rejected') {
        throw failure.reason;
      }
    }
  };
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
