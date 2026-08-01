import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { MihomoRuntime } from '../lifecycle';
import type { ActiveRemoteConfigSnapshot } from '../remoteConfig';
import type { AppSettings } from '../storage/settings';
import type { RemoteControlConfig } from '../../shared/ipc';
import { EXTERNAL_RESPONSE_BODY_LIMITS, readFetchTextBounded } from '../http/boundedBody';
import { selectMihomoProcessSpawner, spawnWindowsJobProcess } from '../platform/windowsJobProcess';
import { buildMihomoConfig, isBlockedSelectableNodeName, strategyTargets } from './config';

type SpawnedProcess = {
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  once(event: 'error', listener: (error: Error) => void): unknown;
  stdout?: NodeJS.ReadableStream | null;
  stderr?: NodeJS.ReadableStream | null;
  kill: () => unknown;
  killed: boolean;
};

type SpawnedProcessExit =
  { kind: 'exit'; code: number | null; signal: NodeJS.Signals | null } | { kind: 'error'; error: Error };

type TrackedProcess = {
  process: SpawnedProcess;
  exited: boolean;
  exitPromise: Promise<SpawnedProcessExit>;
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
  readRemoteConfigSnapshot?: () => Promise<ActiveRemoteConfigSnapshot>;
  isRemoteConfigSnapshotCurrent?: (snapshot: ActiveRemoteConfigSnapshot) => Promise<boolean>;
  spawnProcess?: (binaryPath: string, args: string[]) => SpawnedProcess;
  spawnValidationProcess?: (binaryPath: string, args: string[]) => SpawnedProcess;
  spawnElevatedProcess?: (binaryPath: string, args: string[]) => SpawnedProcess;
  configValidationTimeoutMs?: number;
  renameFile?: (source: string, target: string) => Promise<void>;
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
const subscriptionCacheFilePrefix = 'subscription-cache';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function createLineStreamBuffer(onLine: (line: string) => void) {
  let pending = '';
  const emit = (value: string) => {
    const line = value.trim();
    if (line) onLine(line);
  };
  return {
    push(chunk: unknown) {
      pending += String(chunk);
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? '';
      lines.forEach(emit);
    },
    flush() {
      emit(pending);
      pending = '';
    }
  };
}

function isUsableSubscriptionCandidate(text: string): boolean {
  const value = text.trim();
  const hasForbiddenControlCharacter = [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return (
      codePoint === 0x7f ||
      (codePoint >= 0x80 && codePoint <= 0x9f) ||
      (codePoint < 0x20 && codePoint !== 0x09 && codePoint !== 0x0a && codePoint !== 0x0d)
    );
  });
  if (!value || hasForbiddenControlCharacter) return false;
  if (/^(?:<!doctype\s+html\b|<html\b|<head\b|<body\b)/i.test(value)) return false;

  try {
    const parsed = parseYaml(value);
    if (!isRecord(parsed)) return false;
    const proxies = Array.isArray(parsed.proxies) ? parsed.proxies : [];
    const hasUsableInlineNode = proxies.some((proxy) => {
      if (!isRecord(proxy)) return false;
      const name = typeof proxy.name === 'string' ? proxy.name.trim() : '';
      const type = typeof proxy.type === 'string' ? proxy.type.trim() : '';
      return Boolean(name && type) && !isBlockedSelectableNodeName(name);
    });
    const providers = parsed['proxy-providers'];
    const hasUsableProvider =
      isRecord(providers) &&
      Object.values(providers).some(
        (provider) => isRecord(provider) && typeof provider.url === 'string' && Boolean(provider.url.trim())
      );
    const hasProviderRouting = Array.isArray(parsed.rules) || Array.isArray(parsed['proxy-groups']);
    return hasUsableInlineNode || (hasUsableProvider && hasProviderRouting);
  } catch {
    return false;
  }
}

function subscriptionCacheFileName(url: string): string {
  const urlHash = createHash('sha256').update(url).digest('hex');
  return `${subscriptionCacheFilePrefix}-${urlHash}.yaml`;
}

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
    if (/^(?:text\/html|application\/xhtml\+xml)\b/i.test(response.headers.get('content-type')?.trim() ?? '')) {
      await response.body?.cancel().catch(() => undefined);
      return undefined;
    }
    return await readFetchTextBounded(response, {
      maxBytes: EXTERNAL_RESPONSE_BODY_LIMITS.subscription,
      scope: 'subscription',
      signal: controller.signal
    });
  } catch {
    operationSignal?.throwIfAborted();
    return undefined;
  } finally {
    clearTimeout(timeout);
    operationSignal?.removeEventListener('abort', abort);
  }
}

async function readFileIfPresent(filePath: string): Promise<Buffer | undefined> {
  try {
    return await readFile(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export function createMihomoRuntime(options: MihomoRuntimeOptions): MihomoRuntime {
  let child: TrackedProcess | null = null;
  const stoppingChildren = new Set<TrackedProcess>();

  const spawnNativeProcess = (binaryPath: string, args: string[]) =>
    spawn(binaryPath, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
  const spawnDefaultProcess = selectMihomoProcessSpawner<SpawnedProcess, SpawnedProcess>({
    spawnDirect: spawnNativeProcess,
    spawnWindowsJob: spawnWindowsJobProcess
  });
  const spawnNormalProcess = options.spawnProcess ?? spawnDefaultProcess;
  const renameFile = options.renameFile ?? rename;

  async function writeSyncedCandidate(filePath: string, content: string | Uint8Array): Promise<void> {
    const handle = await open(filePath, 'wx');
    try {
      await handle.writeFile(content, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async function validateConfigCandidate(candidatePath: string, workDir: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const spawnValidationProcess = options.spawnValidationProcess ?? spawnDefaultProcess;
    const validation = spawnValidationProcess(options.binaryPath, ['-t', '-d', workDir, '-f', candidatePath]);
    validation.stdout?.resume();
    validation.stderr?.resume();
    const timeoutMs = Math.max(1, Math.floor(options.configValidationTimeoutMs ?? 10_000));

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let termination: { error: unknown } | undefined;
      let timeout: NodeJS.Timeout | undefined;
      let terminationTimeout: NodeJS.Timeout | undefined;
      const cleanup = () => {
        if (timeout) clearTimeout(timeout);
        if (terminationTimeout) clearTimeout(terminationTimeout);
        signal?.removeEventListener('abort', abort);
      };
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error === undefined) resolve();
        else reject(error);
      };
      const stopAndFail = (error: unknown) => {
        if (settled || termination) return;
        termination = { error };
        if (timeout) clearTimeout(timeout);
        try {
          if (!validation.killed) validation.kill();
        } catch {
          finish(error);
          return;
        }
        if (!settled) {
          terminationTimeout = setTimeout(() => finish(error), 2_000);
        }
      };
      const abort = () => stopAndFail(signal?.reason ?? new Error('operation canceled'));
      timeout = setTimeout(
        () => stopAndFail(new Error(`mihomo config validation timed out after ${timeoutMs}ms`)),
        timeoutMs
      );

      signal?.addEventListener('abort', abort, { once: true });
      validation.once('error', (error) => finish(termination?.error ?? error));
      validation.once('exit', (code, exitSignal) => {
        if (termination) {
          finish(termination.error);
          return;
        }
        if (code === 0) {
          finish();
          return;
        }
        const reason = code == null ? `signal ${exitSignal ?? 'unknown'}` : `exit code ${code.toString()}`;
        finish(new Error(`mihomo config validation failed: ${reason}`));
      });
      if (signal?.aborted) abort();
    });
  }

  async function clearGeoDataFiles(workDir: string) {
    await Promise.allSettled(
      ['Country.mmdb', 'geoip.dat', 'geosite.dat', 'GeoLite2-ASN.mmdb'].map((file) =>
        rm(join(workDir, file), { force: true })
      )
    );
  }

  async function assertRemoteConfigSnapshotCurrent(
    snapshot: ActiveRemoteConfigSnapshot | undefined,
    signal?: AbortSignal
  ): Promise<void> {
    signal?.throwIfAborted();
    if (!snapshot || !options.isRemoteConfigSnapshotCurrent) return;
    if (!(await options.isRemoteConfigSnapshotCurrent(snapshot))) {
      throw new Error('remote config changed during mihomo start');
    }
    signal?.throwIfAborted();
  }

  async function writeConfig(signal?: AbortSignal) {
    signal?.throwIfAborted();
    const settings = await options.readSettings();
    let remoteConfigSnapshot: ActiveRemoteConfigSnapshot | undefined;
    let remoteConfig: RemoteControlConfig | undefined;
    try {
      if (options.readRemoteConfigSnapshot) {
        remoteConfigSnapshot = await options.readRemoteConfigSnapshot();
        remoteConfig = remoteConfigSnapshot.config;
      } else {
        remoteConfig = await options.readRemoteConfig?.();
      }
    } catch (error) {
      options.logLine?.(`remote config skipped: ${error instanceof Error ? error.message : String(error)}`);
    }
    const subscriptionUrl =
      remoteConfig?.enabled && remoteConfig.subscriptionUrl
        ? remoteConfig.subscriptionUrl
        : settings.localSubscriptionUrl;
    if (!subscriptionUrl) {
      throw new Error('missing subscription url');
    }

    const workDir = join(options.userDataDir, 'mihomo');
    const configPath = join(workDir, 'config.yaml');
    const ports = (await options.getPorts?.()) ?? { mixedPort: 7890, controllerPort: 9090 };
    const subscriptionCachePath = join(workDir, subscriptionCacheFileName(subscriptionUrl));
    await mkdir(workDir, { recursive: true });
    const previousSubscriptionCache = await readFileIfPresent(subscriptionCachePath);
    await assertRemoteConfigSnapshotCurrent(remoteConfigSnapshot, signal);
    const fetchedSubscriptionConfigText = await fetchSubscriptionConfigText(subscriptionUrl, signal);
    signal?.throwIfAborted();
    await assertRemoteConfigSnapshotCurrent(remoteConfigSnapshot, signal);
    const acceptedSubscriptionConfigText =
      fetchedSubscriptionConfigText && isUsableSubscriptionCandidate(fetchedSubscriptionConfigText)
        ? fetchedSubscriptionConfigText
        : undefined;
    if (fetchedSubscriptionConfigText && !acceptedSubscriptionConfigText) {
      options.logLine?.('mihomo subscription candidate rejected by content preflight');
    }
    const cachedSubscriptionConfigText = previousSubscriptionCache?.toString('utf8').trim() || undefined;
    const acceptedCachedSubscriptionConfigText =
      cachedSubscriptionConfigText && isUsableSubscriptionCandidate(cachedSubscriptionConfigText)
        ? cachedSubscriptionConfigText
        : undefined;
    if (acceptedCachedSubscriptionConfigText && !acceptedSubscriptionConfigText) {
      options.logLine?.('mihomo using cached subscription config');
    } else if (cachedSubscriptionConfigText && !acceptedCachedSubscriptionConfigText) {
      options.logLine?.('mihomo cached subscription rejected by content preflight');
    }
    const buildCandidateConfig = (subscriptionConfigText?: string) =>
      buildMihomoConfig({
        subscriptionUrl,
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
        mixedPort: ports.mixedPort,
        controllerPort: ports.controllerPort,
        dnsPort: ports.dnsPort
      });
    let candidateConfigText = buildCandidateConfig(
      acceptedSubscriptionConfigText ?? acceptedCachedSubscriptionConfigText
    );
    let subscriptionCacheToPromote = acceptedSubscriptionConfigText;
    const candidateId = `${process.pid}-${randomUUID()}`;
    const candidateConfigPath = `${configPath}.candidate-${candidateId}`;
    const validationWorkDir = join(workDir, `.validation-${candidateId}`);
    const candidateCachePath = acceptedSubscriptionConfigText
      ? `${subscriptionCachePath}.candidate-${candidateId}`
      : undefined;
    const rollbackCachePath = `${subscriptionCachePath}.rollback-${candidateId}`;
    try {
      await mkdir(validationWorkDir);
      await writeSyncedCandidate(candidateConfigPath, candidateConfigText);
      try {
        await validateConfigCandidate(candidateConfigPath, validationWorkDir, signal);
      } catch (error) {
        signal?.throwIfAborted();
        const canRetryCachedSubscription =
          Boolean(acceptedSubscriptionConfigText) &&
          Boolean(acceptedCachedSubscriptionConfigText) &&
          acceptedSubscriptionConfigText?.trim() !== acceptedCachedSubscriptionConfigText?.trim();
        if (!canRetryCachedSubscription) throw error;

        options.logLine?.(
          `mihomo fetched subscription candidate failed validation, retrying cached subscription: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
        await rm(candidateConfigPath, { force: true });
        await rm(validationWorkDir, { recursive: true, force: true });
        await mkdir(validationWorkDir);
        candidateConfigText = buildCandidateConfig(acceptedCachedSubscriptionConfigText);
        await writeSyncedCandidate(candidateConfigPath, candidateConfigText);
        try {
          await validateConfigCandidate(candidateConfigPath, validationWorkDir, signal);
        } catch (fallbackError) {
          signal?.throwIfAborted();
          throw new AggregateError(
            [error, fallbackError],
            'mihomo fetched and cached subscription candidates both failed validation',
            { cause: fallbackError }
          );
        }
        subscriptionCacheToPromote = undefined;
      }
      if (candidateCachePath && subscriptionCacheToPromote) {
        await writeSyncedCandidate(candidateCachePath, subscriptionCacheToPromote.trim());
      }
      await assertRemoteConfigSnapshotCurrent(remoteConfigSnapshot, signal);
      let cachePromoted = false;
      if (candidateCachePath && subscriptionCacheToPromote) {
        await renameFile(candidateCachePath, subscriptionCachePath);
        cachePromoted = true;
      }
      try {
        signal?.throwIfAborted();
        await assertRemoteConfigSnapshotCurrent(remoteConfigSnapshot, signal);
        await renameFile(candidateConfigPath, configPath);
      } catch (promotionError) {
        if (cachePromoted) {
          try {
            if (previousSubscriptionCache === undefined) {
              await rm(subscriptionCachePath, { force: true });
            } else {
              await writeSyncedCandidate(rollbackCachePath, previousSubscriptionCache);
              await renameFile(rollbackCachePath, subscriptionCachePath);
            }
          } catch (rollbackError) {
            throw new AggregateError(
              [promotionError, rollbackError],
              'mihomo config promotion failed and subscription cache rollback also failed',
              { cause: rollbackError }
            );
          }
        }
        throw promotionError;
      }
      await clearGeoDataFiles(workDir);
    } finally {
      await Promise.all([
        rm(candidateConfigPath, { force: true }).catch(() => undefined),
        candidateCachePath ? rm(candidateCachePath, { force: true }).catch(() => undefined) : Promise.resolve(),
        rm(rollbackCachePath, { force: true }).catch(() => undefined),
        rm(validationWorkDir, { recursive: true, force: true }).catch(() => undefined)
      ]);
    }

    return { workDir, configPath, settings, ports, remoteConfigSnapshot };
  }

  async function stopCurrentChild(current = child) {
    if (!current) return;

    stoppingChildren.add(current);
    let timeout: NodeJS.Timeout | undefined;
    try {
      if (!current.exited && !current.process.killed) {
        current.process.kill();
      }
      const outcome = await Promise.race([
        current.exitPromise,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error('mihomo process did not exit after cancellation')), 10_000);
        })
      ]);
      if (outcome.kind === 'error') throw outcome.error;
    } finally {
      if (timeout) clearTimeout(timeout);
      stoppingChildren.delete(current);
    }

    if (child === current && current.exited) {
      child = null;
    }
  }

  return {
    isRunning() {
      return Boolean(child && !child.exited);
    },
    async start(signal) {
      if (child) {
        if (!child.exited && !child.process.killed) return;
        if (child.exited) {
          child = null;
        } else {
          throw new Error('previous mihomo process has not exited');
        }
      }

      const maxAttempts = options.waitForReady ? 1 : 3;
      let lastError: unknown;

      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        signal?.throwIfAborted();
        const { workDir, configPath, settings, ports, remoteConfigSnapshot } = await writeConfig(signal);
        const startupNode = settings.selectedNode;
        const startupStrategy = settings.strategy;
        options.logLine?.(
          `mihomo starting: mixed-port=${ports.mixedPort}, controller=${ports.controllerPort}, dns=${ports.dnsPort ?? 1053}`
        );
        const spawnProcess = settings.tunEnabled
          ? (options.spawnElevatedProcess ?? spawnNormalProcess)
          : spawnNormalProcess;

        await assertRemoteConfigSnapshotCurrent(remoteConfigSnapshot, signal);
        const spawned = spawnProcess(options.binaryPath, ['-d', workDir, '-f', configPath]);
        let resolveExit: (outcome: SpawnedProcessExit) => void = () => undefined;
        const current: TrackedProcess = {
          process: spawned,
          exited: false,
          exitPromise: new Promise<SpawnedProcessExit>((resolve) => {
            resolveExit = resolve;
          })
        };
        let exitSettled = false;
        let ready = false;
        const settleExit = (outcome: SpawnedProcessExit) => {
          if (exitSettled) return;
          exitSettled = true;
          current.exited = true;
          if (child === current) {
            child = null;
          }
          resolveExit(outcome);
        };
        const recentOutput: string[] = [];
        const rememberOutput = (line: string) => {
          recentOutput.push(line);
          if (recentOutput.length > 8) {
            recentOutput.splice(0, recentOutput.length - 8);
          }
        };
        const recordOutput = (line: string) => {
          rememberOutput(line);
          options.logLine?.(`[mihomo] ${line}`);
        };
        const stdoutBuffer = createLineStreamBuffer(recordOutput);
        const stderrBuffer = createLineStreamBuffer(recordOutput);
        const flushOutput = () => {
          stdoutBuffer.flush();
          stderrBuffer.flush();
        };
        const formatStartupFailure = (reason: string) => {
          const detail = recentOutput.length > 0 ? `; recent mihomo output: ${recentOutput.join(' | ')}` : '';
          return new Error(`mihomo exited before controller was ready: ${reason}${detail}`);
        };
        child = current;
        spawned.once('error', (error) => {
          flushOutput();
          options.logLine?.(`mihomo process error: ${error.message}`);
          settleExit({ kind: 'error', error });
        });
        spawned.once('exit', (code, exitSignal) => {
          flushOutput();
          const reason = code == null ? `signal ${exitSignal ?? 'unknown'}` : `exit code ${code.toString()}`;
          const expectedStop = stoppingChildren.has(current);
          if (ready) {
            if (!expectedStop) {
              options.logLine?.(`mihomo exited after ready: ${reason}`);
              options.onUnexpectedExit?.(reason);
            }
          } else if (!expectedStop) {
            options.logLine?.(`mihomo exited before ready: ${reason}`);
          }
          settleExit({ kind: 'exit', code, signal: exitSignal });
        });
        const abortCurrent = () => spawned.kill();
        signal?.addEventListener('abort', abortCurrent, { once: true });
        spawned.stdout?.on('data', (chunk) => stdoutBuffer.push(chunk));
        spawned.stdout?.on('end', () => stdoutBuffer.flush());
        spawned.stderr?.on('data', (chunk) => stderrBuffer.push(chunk));
        spawned.stderr?.on('end', () => stderrBuffer.flush());

        const earlyFailure: Promise<never> = current.exitPromise.then((outcome) => {
          if (outcome.kind === 'error') {
            throw outcome.error;
          }

          const reason =
            outcome.code == null ? `signal ${outcome.signal ?? 'unknown'}` : `exit code ${outcome.code.toString()}`;
          if (!ready) {
            throw formatStartupFailure(reason);
          }
          return new Promise<never>(() => undefined);
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
          await assertRemoteConfigSnapshotCurrent(remoteConfigSnapshot, signal);
          ready = true;
          options.logLine?.('mihomo controller ready');
          return;
        } catch (error) {
          lastError = error;
          await stopCurrentChild(current);
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
