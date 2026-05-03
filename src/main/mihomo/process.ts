import { mkdir, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import type { MihomoRuntime } from '../lifecycle';
import type { AppSettings } from '../storage/settings';
import { buildMihomoConfig } from './config';

type SpawnedProcess = {
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  once(event: 'error', listener: (error: Error) => void): unknown;
  stdout?: NodeJS.ReadableStream | null;
  stderr?: NodeJS.ReadableStream | null;
  kill: () => unknown;
  killed: boolean;
};

type MihomoProxyItem = {
  now?: string;
  all?: string[];
};

type MihomoProxiesResponse = {
  proxies?: Record<string, MihomoProxyItem>;
};

type MihomoProvidersResponse = {
  providers?: Record<string, unknown>;
};

export type MihomoRuntimeOptions = {
  binaryPath: string;
  userDataDir: string;
  readSettings: () => Promise<AppSettings>;
  getPorts?: () =>
    | { mixedPort: number; controllerPort: number; dnsPort?: number }
    | Promise<{ mixedPort: number; controllerPort: number; dnsPort?: number }>;
  logLine?: (line: string) => void;
  spawnProcess?: (binaryPath: string, args: string[]) => SpawnedProcess;
  waitForReady?: (secret: string) => Promise<void>;
  onUnexpectedExit?: (reason: string) => void;
};

const selectorName = '节点选择';
const builtInProxyNames = new Set(['COMPATIBLE', 'DIRECT', 'PASS', 'REJECT', 'REJECT-DROP']);
const managedGroupNames = new Set(['节点选择', '自动选择', '故障转移', '负载均衡']);
const noticeNodeKeywords = ['失去支持', '更新你的代理客户端', '官网公告', '代理客户端'];
const preferredDefaultNodeKeywordSets = [
  ['日本', '09', '家宽'],
  ['日本', '08', '家宽'],
  ['日本', '家宽']
];
const subscriptionUserAgent = 'Clash Verge/2.3.2';

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForController(secret: string, port: number): Promise<void> {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/version`, {
        headers: {
          Authorization: `Bearer ${secret}`
        }
      });
      if (response.ok) return;
    } catch {
      // The controller is not ready yet.
    }
    await sleep(200);
  }
  throw new Error(`mihomo controller not ready on 127.0.0.1:${port}`);
}

function isControllerNotReadyError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('mihomo controller not ready');
}

async function requestController(
  port: number,
  secret: string,
  path: string,
  init?: RequestInit
): Promise<Response> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${secret}`,
      ...init?.headers
    }
  });
  if (!response.ok) {
    throw new Error(`mihomo api failed: ${response.status}`);
  }
  return response;
}

async function readProxies(port: number, secret: string): Promise<Record<string, MihomoProxyItem>> {
  const response = await requestController(port, secret, '/proxies');
  const data = (await response.json()) as MihomoProxiesResponse;
  return data.proxies ?? {};
}

function findSelector(proxies: Record<string, MihomoProxyItem>): { name: string; item: MihomoProxyItem } | null {
  const preferred = proxies[selectorName];
  if (preferred?.all?.length) {
    return { name: selectorName, item: preferred };
  }

  const selector = Object.entries(proxies).find(([_name, item]) => {
    return item.all?.some((name) => !builtInProxyNames.has(name));
  });
  return selector ? { name: selector[0], item: selector[1] } : null;
}

function collectUsableNodes(proxies: Record<string, MihomoProxyItem>, names: string[]): string[] {
  const nodes: string[] = [];
  const seen = new Set<string>();
  const visit = (name: string) => {
    if (seen.has(name) || builtInProxyNames.has(name) || isNoticeNodeName(name)) return;
    seen.add(name);

    const item = proxies[name];
    if (item?.all?.length) {
      item.all.forEach(visit);
      return;
    }

    if (!managedGroupNames.has(name)) {
      nodes.push(name);
    }
  };

  names.forEach(visit);
  return nodes;
}

function resolveCurrentNode(proxies: Record<string, MihomoProxyItem>, selector: MihomoProxyItem | undefined): string {
  const current = selector?.now ?? '';
  const nestedCurrent = proxies[current]?.now;
  return nestedCurrent && nestedCurrent !== current ? nestedCurrent : current;
}

function findDirectSelectorForNode(proxies: Record<string, MihomoProxyItem>, fallbackSelector: string, node: string) {
  if (proxies[fallbackSelector]?.all?.includes(node)) {
    return fallbackSelector;
  }

  return Object.entries(proxies).find(([_name, item]) => item.all?.includes(node))?.[0] ?? fallbackSelector;
}

function sortDefaultCandidates(nodes: string[]): string[] {
  const preferred: string[] = [];
  for (const keywords of preferredDefaultNodeKeywordSets) {
    const matched = nodes.filter((node) => keywords.every((keyword) => node.includes(keyword)));
    for (const node of matched) {
      if (!preferred.includes(node)) preferred.push(node);
    }
  }

  return [...preferred, ...nodes.filter((node) => !preferred.includes(node))];
}

function pickDefaultNode(nodes: string[]): string | undefined {
  return sortDefaultCandidates(nodes)[0];
}

function isNoticeNodeName(name: string): boolean {
  return noticeNodeKeywords.some((keyword) => name.includes(keyword));
}

async function selectNode(port: number, secret: string, group: string, node: string): Promise<void> {
  await requestController(port, secret, `/proxies/${encodeURIComponent(group)}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ name: node })
  });
}

async function refreshProviders(port: number, secret: string): Promise<void> {
  let providerNames = ['airport'];
  try {
    const response = await requestController(port, secret, '/providers/proxies');
    const data = (await response.json()) as MihomoProvidersResponse;
    const names = Object.keys(data.providers ?? {}).filter((name) => name !== 'default');
    if (names.length > 0) {
      providerNames = names;
    }
  } catch {
    providerNames = ['airport'];
  }

  await Promise.allSettled(
    providerNames.map((name) =>
      requestController(port, secret, `/providers/proxies/${encodeURIComponent(name)}`, {
        method: 'PUT'
      })
    )
  );
}

async function waitForUsableProxies(
  secret: string,
  port: number,
  logLine?: (line: string) => void
): Promise<void> {
  const deadline = Date.now() + 25000;
  let refreshed = false;
  let lastSummary = 'no proxy data';

  while (Date.now() < deadline) {
    const proxies = await readProxies(port, secret);
    const selector = findSelector(proxies);
    const nodes = collectUsableNodes(proxies, selector?.item.all ?? []);
    const currentNode = resolveCurrentNode(proxies, selector?.item);
    lastSummary = `selector=${selector?.name ?? 'missing'}, current=${currentNode || 'missing'}, nodes=${nodes.length}`;

    if (nodes.length > 0) {
      const target = pickDefaultNode(nodes);
      if (target && (!currentNode || builtInProxyNames.has(currentNode) || currentNode !== target)) {
        const group = findDirectSelectorForNode(proxies, selector?.name ?? selectorName, target);
        await selectNode(port, secret, group, target);
        logLine?.(`mihomo selected default node: ${target}`);
      }
      return;
    }

    if (!refreshed) {
      refreshed = true;
      logLine?.('mihomo provider has no usable nodes yet, refreshing subscription');
      await refreshProviders(port, secret);
    }

    await sleep(1000);
  }

  throw new Error(`mihomo has no usable subscription nodes after startup: ${lastSummary}`);
}

async function fetchSubscriptionConfigText(url: string): Promise<string | undefined> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': subscriptionUserAgent
      }
    });
    if (!response.ok) {
      return undefined;
    }
    return await response.text();
  } catch {
    return undefined;
  } finally {
    clearTimeout(timeout);
  }
}

export function createMihomoRuntime(options: MihomoRuntimeOptions): MihomoRuntime {
  let child: SpawnedProcess | null = null;
  let stopping = false;

  async function clearGeoDataFiles(workDir: string) {
    await Promise.allSettled(
      ['Country.mmdb', 'geoip.dat', 'geosite.dat', 'GeoLite2-ASN.mmdb'].map((file) =>
        rm(join(workDir, file), { force: true })
      )
    );
  }

  async function writeConfig() {
    const settings = await options.readSettings();
    if (!settings.subscriptionUrl) {
      throw new Error('missing subscription url');
    }

    const workDir = join(options.userDataDir, 'mihomo');
    const configPath = join(workDir, 'config.yaml');
    const ports = (await options.getPorts?.()) ?? { mixedPort: 7890, controllerPort: 9090 };
    const subscriptionConfigText = await fetchSubscriptionConfigText(settings.subscriptionUrl);
    await mkdir(workDir, { recursive: true });
    await clearGeoDataFiles(workDir);
    await writeFile(
      configPath,
      buildMihomoConfig({
        subscriptionUrl: settings.subscriptionUrl,
        secret: settings.controllerSecret,
        mode: settings.mode,
        strategy: settings.strategy,
        ruleProfile: settings.ruleProfile,
        systemProxyEnabled: settings.systemProxyEnabled,
        dnsEnhanced: settings.dnsEnhanced,
        snifferEnabled: settings.snifferEnabled,
        tunEnabled: settings.tunEnabled,
        allowLan: settings.allowLan,
        subscriptionConfigText,
        mixedPort: ports.mixedPort,
        controllerPort: ports.controllerPort,
        dnsPort: ports.dnsPort
      }),
      'utf8'
    );

    return { workDir, configPath, settings, ports };
  }

  async function stopCurrentChild() {
    const current = child;
    if (current && !current.killed) {
      stopping = true;
      await new Promise<void>((resolve) => {
        let settled = false;
        const done = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(done, 2500);
        current.once('exit', done);
        current.once('error', done);
        current.kill();
      });
      stopping = false;
    }
    child = null;
  }

  return {
    isRunning() {
      return Boolean(child && !child.killed);
    },
    async start() {
      if (child && !child.killed) {
        return;
      }

      const maxAttempts = options.waitForReady ? 1 : 3;
      let lastError: unknown;

      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        const { workDir, configPath, settings, ports } = await writeConfig();
        options.logLine?.(
          `mihomo starting: mixed-port=${ports.mixedPort}, controller=${ports.controllerPort}, dns=${ports.dnsPort ?? 1053}`
        );
        const spawnProcess =
          options.spawnProcess ??
          ((binaryPath: string, args: string[]) =>
            spawn(binaryPath, args, {
              windowsHide: true,
              stdio: ['ignore', 'pipe', 'pipe']
            }));

        const current = spawnProcess(options.binaryPath, ['-d', workDir, '-f', configPath]);
        child = current;
        const recentOutput: string[] = [];
        const rememberOutput = (line: string) => {
          recentOutput.push(line);
          if (recentOutput.length > 8) {
            recentOutput.splice(0, recentOutput.length - 8);
          }
        };
        const formatStartupFailure = (reason: string) => {
          const detail = recentOutput.length > 0 ? `; recent mihomo output: ${recentOutput.join(' | ')}` : '';
          return new Error(`mihomo exited before controller was ready: ${reason}${detail}`);
        };
        current.stdout?.on('data', (chunk) => {
          String(chunk)
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean)
            .forEach((line) => {
              rememberOutput(line);
              options.logLine?.(`[mihomo] ${line}`);
            });
        });
        current.stderr?.on('data', (chunk) => {
          String(chunk)
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean)
            .forEach((line) => {
              rememberOutput(line);
              options.logLine?.(`[mihomo] ${line}`);
            });
        });

        let ready = false;
        const earlyFailure = new Promise<never>((_resolve, reject) => {
          current.once('error', (error) => {
            if (child === current) {
              child = null;
            }
            options.logLine?.(`mihomo process error: ${error.message}`);
            reject(error);
          });
          current.once('exit', (code, signal) => {
            if (child === current) {
              child = null;
            }
            if (!ready) {
              const reason =
                code == null ? `signal ${signal ?? 'unknown'}` : `exit code ${code.toString()}`;
              options.logLine?.(`mihomo exited before ready: ${reason}`);
              reject(formatStartupFailure(reason));
              return;
            }

            const reason = code == null ? `signal ${signal ?? 'unknown'}` : `exit code ${code.toString()}`;
            options.logLine?.(`mihomo exited after ready: ${reason}`);
            if (!stopping) {
              options.onUnexpectedExit?.(reason);
            }
          });
        });

        try {
          await Promise.race([
            options.waitForReady
              ? options.waitForReady(settings.controllerSecret)
              : (async () => {
                  await waitForController(settings.controllerSecret, ports.controllerPort);
                  await waitForUsableProxies(settings.controllerSecret, ports.controllerPort, options.logLine);
                })(),
            earlyFailure
          ]);
          ready = true;
          options.logLine?.('mihomo controller ready');
          return;
        } catch (error) {
          lastError = error;
          await stopCurrentChild();
          if (!isControllerNotReadyError(error) || attempt === maxAttempts) {
            throw error;
          }
          options.logLine?.(`mihomo controller timeout, retrying with fresh ports (${attempt + 1}/${maxAttempts})`);
        }
      }

      throw lastError;
    },
    async stop() {
      await stopCurrentChild();
    }
  };
}
