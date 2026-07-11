import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import type { MihomoRuntime } from '../lifecycle';
import type { AppSettings } from '../storage/settings';
import type { RemoteControlConfig } from '../../shared/ipc';
import { buildMihomoConfig, isBlockedSelectableNodeName, strategyTargets } from './config';

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
  readRemoteConfig?: () => Promise<RemoteControlConfig | undefined>;
  spawnProcess?: (binaryPath: string, args: string[]) => SpawnedProcess;
  spawnElevatedProcess?: (binaryPath: string, args: string[]) => SpawnedProcess;
  waitForReady?: (secret: string) => Promise<void>;
  onUnexpectedExit?: (reason: string) => void;
};

const selectorName = '节点选择';
const builtInProxyNames = new Set(['COMPATIBLE', 'DIRECT', 'PASS', 'REJECT', 'REJECT-DROP']);
const managedGroupNames = new Set(['节点选择', '自动选择', '故障转移', '负载均衡']);
const preferredDefaultNodeKeywordSets = [
  ['台湾', '08', '家宽'],
  ['台湾', '09', '家宽'],
  ['台湾', '家宽']
];
const subscriptionUserAgent = 'Clash Verge/2.3.2';
const subscriptionCacheFileName = 'subscription-cache.yaml';

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    await new Promise((resolve) => setTimeout(resolve, ms));
    return;
  }
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const finish = () => {
      signal.removeEventListener('abort', abort);
      resolve();
    };
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}

async function waitForController(secret: string, port: number, signal?: AbortSignal): Promise<void> {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    try {
      const response = await fetch(`http://127.0.0.1:${port}/version`, {
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(1000)]) : AbortSignal.timeout(1000),
        headers: {
          Authorization: `Bearer ${secret}`
        }
      });
      if (response.ok) return;
    } catch {
      // The controller is not ready yet.
    }
    await sleep(200, signal);
  }
  throw new Error(`mihomo controller not ready on 127.0.0.1:${port}`);
}

function isControllerNotReadyError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('mihomo controller not ready');
}

async function requestController(port: number, secret: string, path: string, init?: RequestInit): Promise<Response> {
  const timeoutSignal = AbortSignal.timeout(5000);
  const signal = init?.signal ? AbortSignal.any([init.signal, timeoutSignal]) : timeoutSignal;
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    ...init,
    signal,
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
    if (seen.has(name) || builtInProxyNames.has(name)) return;
    seen.add(name);

    const item = proxies[name];
    if (item?.all?.length) {
      item.all.forEach(visit);
      return;
    }

    if (!managedGroupNames.has(name) && !isBlockedSelectableNodeName(name)) {
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

function resolveSelectionSteps(
  proxies: Record<string, MihomoProxyItem>,
  fallbackSelector: string,
  node: string
): Array<{ group: string; name: string }> {
  return resolveSelectionStepsForGroup(proxies, fallbackSelector, node) ?? [{ group: fallbackSelector, name: node }];
}

function resolveSelectionStepsForGroup(
  proxies: Record<string, MihomoProxyItem>,
  group: string,
  node: string
): Array<{ group: string; name: string }> | null {
  const topLevel = proxies[group]?.all ?? [];
  if (topLevel.includes(node)) {
    return [{ group, name: node }];
  }

  const nested = Object.entries(proxies).find(([_name, item]) => item.all?.includes(node));
  if (!nested) {
    return null;
  }

  const [nestedGroup] = nested;
  const steps = [{ group: nestedGroup, name: node }];
  if (nestedGroup !== group && topLevel.includes(nestedGroup)) {
    steps.push({ group, name: nestedGroup });
  }
  return steps;
}

function collectSyncedSelectionSteps(
  proxies: Record<string, MihomoProxyItem>,
  target: string,
  primarySteps: Array<{ group: string; name: string }>
): Array<{ group: string; name: string; required: boolean }> {
  const stepsByGroup = new Map<string, { group: string; name: string; required: boolean }>();
  for (const step of primarySteps) {
    stepsByGroup.set(step.group, { ...step, required: true });
  }

  for (const [group, item] of Object.entries(proxies)) {
    if (!item.all?.length || builtInProxyNames.has(group)) {
      continue;
    }

    const steps = resolveSelectionStepsForGroup(proxies, group, target);
    for (const step of steps ?? []) {
      const existing = stepsByGroup.get(step.group);
      if (existing?.required) {
        continue;
      }
      stepsByGroup.set(step.group, { ...step, required: false });
    }
  }

  return [...stepsByGroup.values()];
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

function pickStartupNode(nodes: string[], selectedNode: string): string | undefined {
  const saved = selectedNode.trim();
  if (saved && nodes.includes(saved)) {
    return saved;
  }

  return pickDefaultNode(nodes);
}

function pickUsableNodeForGroup(proxies: Record<string, MihomoProxyItem>, group: string): string | undefined {
  const groupNodes = collectUsableNodes(proxies, proxies[group]?.all ?? []);
  return pickDefaultNode(groupNodes);
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
  selectedNode: string,
  strategy: AppSettings['strategy'],
  logLine?: (line: string) => void,
  signal?: AbortSignal
): Promise<void> {
  const deadline = Date.now() + 25000;
  let refreshed = false;
  let lastSummary = 'no proxy data';

  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    const proxies = await readProxies(port, secret);
    const selector = findSelector(proxies);
    const nodes = collectUsableNodes(proxies, selector?.item.all ?? []);
    const currentNode = resolveCurrentNode(proxies, selector?.item);
    lastSummary = `selector=${selector?.name ?? 'missing'}, current=${currentNode || 'missing'}, nodes=${nodes.length}`;

    if (nodes.length > 0) {
      const strategyTarget = strategy === 'manual' ? undefined : strategyTargets[strategy];
      const target =
        strategyTarget && selector?.item.all?.includes(strategyTarget)
          ? strategyTarget
          : pickStartupNode(nodes, selectedNode);
      if (target && (!currentNode || builtInProxyNames.has(currentNode) || currentNode !== target)) {
        const primarySteps = resolveSelectionSteps(proxies, selector?.name ?? selectorName, target);
        const steps = collectSyncedSelectionSteps(proxies, target, primarySteps);
        for (const step of steps) {
          const task = selectNode(port, secret, step.group, step.name);
          if (step.required) {
            await task;
          } else {
            await task.catch(() => undefined);
          }
        }
        if (strategyTarget && target === strategyTarget) {
          const usableStrategyNode = pickUsableNodeForGroup(proxies, strategyTarget);
          if (usableStrategyNode) {
            await selectNode(port, secret, strategyTarget, usableStrategyNode);
          }
        }
        logLine?.(
          strategyTarget && target === strategyTarget
            ? `mihomo selected strategy: ${target}`
            : selectedNode.trim() && target === selectedNode.trim()
              ? `mihomo restored selected node: ${target}`
              : `mihomo selected default node: ${target}`
        );
      }
      return;
    }

    if (!refreshed) {
      refreshed = true;
      logLine?.('mihomo provider has no usable nodes yet, refreshing subscription');
      await refreshProviders(port, secret);
    }

    await sleep(1000, signal);
  }

  throw new Error(`mihomo has no usable subscription nodes after startup: ${lastSummary}`);
}

async function fetchSubscriptionConfigText(url: string, operationSignal?: AbortSignal): Promise<string | undefined> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  const abort = () => controller.abort(operationSignal?.reason);
  operationSignal?.addEventListener('abort', abort, { once: true });
  try {
    operationSignal?.throwIfAborted();
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
    operationSignal?.throwIfAborted();
    return undefined;
  } finally {
    clearTimeout(timeout);
    operationSignal?.removeEventListener('abort', abort);
  }
}

async function readCachedSubscriptionConfigText(
  cachePath: string,
  logLine?: (line: string) => void
): Promise<string | undefined> {
  try {
    const cached = (await readFile(cachePath, 'utf8')).trim();
    if (!cached) return undefined;
    logLine?.('mihomo using cached subscription config');
    return cached;
  } catch {
    return undefined;
  }
}

async function cacheSubscriptionConfigText(
  cachePath: string,
  text: string | undefined,
  logLine?: (line: string) => void
): Promise<void> {
  const value = text?.trim();
  if (!value) return;

  try {
    await writeFile(cachePath, value, 'utf8');
  } catch (error) {
    logLine?.(`mihomo subscription cache write failed: ${error instanceof Error ? error.message : String(error)}`);
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

  async function writeConfig(signal?: AbortSignal) {
    signal?.throwIfAborted();
    const settings = await options.readSettings();
    if (!settings.subscriptionUrl) {
      throw new Error('missing subscription url');
    }

    const workDir = join(options.userDataDir, 'mihomo');
    const configPath = join(workDir, 'config.yaml');
    const ports = (await options.getPorts?.()) ?? { mixedPort: 7890, controllerPort: 9090 };
    const subscriptionCachePath = join(workDir, subscriptionCacheFileName);
    await mkdir(workDir, { recursive: true });
    const fetchedSubscriptionConfigText = await fetchSubscriptionConfigText(settings.subscriptionUrl, signal);
    signal?.throwIfAborted();
    await cacheSubscriptionConfigText(subscriptionCachePath, fetchedSubscriptionConfigText, options.logLine);
    const subscriptionConfigText =
      fetchedSubscriptionConfigText ?? (await readCachedSubscriptionConfigText(subscriptionCachePath, options.logLine));
    const remoteConfig = await options.readRemoteConfig?.().catch((error) => {
      options.logLine?.(`remote config skipped: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    });
    await clearGeoDataFiles(workDir);
    await writeFile(
      configPath,
      buildMihomoConfig({
        subscriptionUrl: settings.subscriptionUrl,
        secret: settings.controllerSecret,
        mode: settings.mode,
        strategy: settings.strategy,
        ruleProfile: remoteConfig?.ruleProfile ?? settings.ruleProfile,
        systemProxyEnabled: settings.systemProxyEnabled,
        dnsEnhanced: settings.dnsEnhanced,
        snifferEnabled: settings.snifferEnabled,
        tunEnabled: settings.tunEnabled,
        strictRouteEnabled: settings.strictRouteEnabled,
        allowLan: settings.allowLan,
        subscriptionConfigText,
        remoteConfig,
        mixedPort: ports.mixedPort,
        controllerPort: ports.controllerPort,
        dnsPort: ports.dnsPort
      }),
      'utf8'
    );

    return { workDir, configPath, settings, ports, remoteConfig };
  }

  async function stopCurrentChild() {
    const current = child;
    if (current && !current.killed) {
      stopping = true;
      try {
        await new Promise<void>((resolve, reject) => {
          let settled = false;
          const done = (error?: Error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (error) reject(error);
            else resolve();
          };
          const timer = setTimeout(() => done(new Error('mihomo process did not exit after cancellation')), 10_000);
          current.once('exit', () => done());
          current.once('error', (error) => done(error));
          current.kill();
        });
      } finally {
        stopping = false;
      }
    }
    if (!current || child !== current || current.killed) {
      child = null;
    }
  }

  return {
    isRunning() {
      return Boolean(child && !child.killed);
    },
    async start(signal) {
      if (child) {
        if (!child.killed) return;
        throw new Error('previous mihomo process has not exited');
      }

      const maxAttempts = options.waitForReady ? 1 : 3;
      let lastError: unknown;

      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        signal?.throwIfAborted();
        const { workDir, configPath, settings, ports, remoteConfig } = await writeConfig(signal);
        const startupNode = remoteConfig?.preferredNode ?? settings.selectedNode;
        const startupStrategy = remoteConfig?.preferredNode
          ? 'manual'
          : (remoteConfig?.preferredStrategy ?? settings.strategy);
        options.logLine?.(
          `mihomo starting: mixed-port=${ports.mixedPort}, controller=${ports.controllerPort}, dns=${ports.dnsPort ?? 1053}`
        );
        const spawnProcess =
          (settings.tunEnabled ? options.spawnElevatedProcess : options.spawnProcess) ??
          ((binaryPath: string, args: string[]) =>
            spawn(binaryPath, args, {
              windowsHide: true,
              stdio: ['ignore', 'pipe', 'pipe']
            }));

        const current = spawnProcess(options.binaryPath, ['-d', workDir, '-f', configPath]);
        child = current;
        const abortCurrent = () => current.kill();
        signal?.addEventListener('abort', abortCurrent, { once: true });
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
              const reason = code == null ? `signal ${signal ?? 'unknown'}` : `exit code ${code.toString()}`;
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

        let abortStartup: () => void = () => undefined;
        try {
          const aborted = new Promise<never>((_resolve, reject) => {
            abortStartup = () => reject(signal?.reason);
            signal?.addEventListener('abort', abortStartup, { once: true });
          });
          await Promise.race([
            options.waitForReady
              ? options.waitForReady(settings.controllerSecret)
              : (async () => {
                  await waitForController(settings.controllerSecret, ports.controllerPort, signal);
                  await waitForUsableProxies(
                    settings.controllerSecret,
                    ports.controllerPort,
                    startupNode,
                    startupStrategy,
                    options.logLine,
                    signal
                  );
                })(),
            earlyFailure,
            aborted
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
        } finally {
          signal?.removeEventListener('abort', abortCurrent);
          signal?.removeEventListener('abort', abortStartup);
        }
      }

      throw lastError;
    },
    async stop() {
      await stopCurrentChild();
    }
  };
}
