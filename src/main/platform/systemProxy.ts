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

async function defaultRunCommand(command: Command): Promise<string> {
  const { stdout } = await execFileAsync(command.file, command.args, {
    windowsHide: true
  });
  return stdout;
}

function parseEnabled(output: string): boolean {
  return /0x1\b/i.test(output);
}

function parseServer(output: string): string {
  const match = output.match(/ProxyServer\s+REG_SZ\s+(.+)/i);
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
    const [enabledOutput, serverOutput] = await Promise.all([
      reg(['query', internetSettingsKey, '/v', 'ProxyEnable']),
      reg(['query', internetSettingsKey, '/v', 'ProxyServer']).catch(() => '')
    ]);

    return {
      enabled: parseEnabled(enabledOutput),
      server: parseServer(serverOutput)
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
    await reg(['add', internetSettingsKey, '/v', 'ProxyServer', '/t', 'REG_SZ', '/d', server, '/f']);
  }

  async function setProxy(enabled: boolean, server?: string) {
    if (enabled && server !== undefined) {
      await setProxyServer(server);
    }

    await setProxyEnabled(enabled);

    if (!enabled && server !== undefined) {
      await setProxyServer(server);
    }
    await notifySettingsChanged();
  }

  async function restorePrevious() {
    if (!previous) {
      await setProxy(false);
      return;
    }

    if (previous.enabled && !previous.server) {
      await setProxy(false);
      return;
    }

    await setProxy(previous.enabled, previous.server || undefined);
  }

  return {
    async enable() {
      if (platform !== 'win32') return;
      if (!(await shouldManageProxy())) return;
      if (enabledByApp) return;
      previous = await queryPrevious();
      enabledByApp = true;
      try {
        await setProxy(true, getProxyServer());
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
      await setProxy(false);
      previous = null;
      enabledByApp = false;
    }
  };
}
