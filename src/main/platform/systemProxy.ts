import type { SystemProxyAdapter } from '../lifecycle';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

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

type Command = {
  file: string;
  args: string[];
};

export type SystemProxyOptions = {
  platform?: NodeJS.Platform;
  runCommand?: (command: Command) => Promise<string>;
  shouldManageProxy?: () => Promise<boolean>;
  getProxyServer?: () => string;
};

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

async function defaultRunCommand(command: Command): Promise<string> {
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
  const getProxyServer = options.getProxyServer ?? (() => '127.0.0.1:7890');
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
    await reg([
      'add',
      internetSettingsKey,
      '/v',
      'ProxyEnable',
      '/t',
      'REG_DWORD',
      '/d',
      enabled ? '1' : '0',
      '/f'
    ]);
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
    await runCommand({ file: 'netsh.exe', args: ['winhttp', 'reset', 'proxy'] });
  }

  async function flushDnsCache() {
    await runCommand({ file: 'ipconfig.exe', args: ['/flushdns'] });
  }

  async function queryMicrosoftStorePackageFamilies(): Promise<string[]> {
    const output = await runCommand({
      file: 'powershell.exe',
      args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', microsoftStoreLoopbackQueryScript]
    });
    return [...new Set(output.split(/\r?\n/).map((line) => line.trim()).filter(isPackageFamilyName))];
  }

  async function ensureMicrosoftStoreLoopbackExemptions(options: { strict?: boolean } = {}) {
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
    for (const packageFamilyName of installedPackageFamilies) {
      if (normalizedExisting.includes(packageFamilyName.toLowerCase())) {
        continue;
      }

      await runCommand({
        file: 'CheckNetIsolation.exe',
        args: ['LoopbackExempt', '-a', `-n="${packageFamilyName}"`]
      }).catch((error) => {
        if (options.strict) {
          failures.push(`${packageFamilyName}: ${error instanceof Error ? error.message : String(error)}`);
        }
      });
    }

    if (failures.length > 0) {
      throw new Error(`Store loopback exemption failed: ${failures.join('; ')}`);
    }
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

  return {
    async enable() {
      if (platform !== 'win32') return;
      if (!(await shouldManageProxy())) return;
      if (enabledByApp) return;
      previous = await queryPrevious();
      enabledByApp = true;
      try {
        await setProxy(true, getProxyServer(), proxyOverride);
        await ensureMicrosoftStoreLoopbackExemptions();
      } catch (error) {
        await restorePrevious().catch(() => undefined);
        previous = null;
        enabledByApp = false;
        throw error;
      }
    },
    async restore() {
      if (platform !== 'win32') return;
      if (!enabledByApp) return;
      await restorePrevious();
      previous = null;
      enabledByApp = false;
    },
    async repair() {
      if (platform !== 'win32') return;
      const results = await Promise.allSettled([
        setProxy(false, '', ''),
        resetWinHttpProxy(),
        flushDnsCache(),
        ensureMicrosoftStoreLoopbackExemptions({ strict: true })
      ]);
      previous = null;
      enabledByApp = false;

      const failure = results.find((result) => result.status === 'rejected');
      if (failure?.status === 'rejected') {
        throw failure.reason;
      }
    }
  };
}

function isPackageFamilyName(value: string): boolean {
  return /^[A-Za-z0-9.]+_[A-Za-z0-9]+$/.test(value);
}
