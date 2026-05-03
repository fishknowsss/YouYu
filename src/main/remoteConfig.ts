import type { AppSettings } from './storage/settings';
import { SettingsStore } from './storage/settings';

export type RemoteDefaultNode =
  | {
      keywords?: string[];
      value?: string;
    }
  | string[];

export type RemoteConfig = {
  enabled: boolean;
  subscriptionUrl: string;
  defaultNode?: RemoteDefaultNode;
  version?: number;
};

export type RemoteConfigOptions = {
  url: string;
  settingsStore: SettingsStore;
  fetcher?: typeof fetch;
  timeoutMs?: number;
  logLine?: (line: string) => void;
};

type RemoteConfigPayload = {
  enabled?: unknown;
  subscriptionUrl?: unknown;
  defaultNode?: unknown;
  version?: unknown;
};

export const defaultRemoteConfigUrl = 'https://youyu.fishknowsss.com/config.json';

export async function syncRemoteConfig(options: RemoteConfigOptions): Promise<AppSettings> {
  const current = await options.settingsStore.read();
  const remote = await fetchRemoteConfig(options).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    options.logLine?.(`remote config skipped: ${message}`);
    return null;
  });

  if (!remote) {
    return current;
  }

  if (!remote.enabled) {
    options.logLine?.('remote config disabled');
    return current;
  }

  const next = {
    subscriptionUrl: remote.subscriptionUrl,
    defaultNodeKeywords: extractDefaultNodeKeywords(remote.defaultNode)
  };
  const changed =
    current.subscriptionUrl !== next.subscriptionUrl ||
    current.defaultNodeKeywords.join('\n') !== next.defaultNodeKeywords.join('\n');

  if (!changed) {
    return current;
  }

  options.logLine?.(
    `remote config applied: subscription=${maskUrl(remote.subscriptionUrl)}, default-node=${next.defaultNodeKeywords.join('/') || 'first'}`
  );
  return options.settingsStore.update(next);
}

async function fetchRemoteConfig(options: RemoteConfigOptions): Promise<RemoteConfig | null> {
  const fetcher = options.fetcher ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 8000);
  try {
    const response = await fetcher(options.url, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json'
      },
      cache: 'no-store'
    });
    if (!response.ok) {
      throw new Error(`http ${response.status}`);
    }

    return normalizeRemoteConfig((await response.json()) as RemoteConfigPayload);
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeRemoteConfig(payload: RemoteConfigPayload): RemoteConfig | null {
  if (!payload || typeof payload !== 'object') return null;
  const subscriptionUrl = typeof payload.subscriptionUrl === 'string' ? payload.subscriptionUrl.trim() : '';
  if (!subscriptionUrl || !/^https?:\/\//i.test(subscriptionUrl)) return null;

  return {
    enabled: payload.enabled !== false,
    subscriptionUrl,
    defaultNode: payload.defaultNode as RemoteDefaultNode | undefined,
    version: typeof payload.version === 'number' ? payload.version : undefined
  };
}

function extractDefaultNodeKeywords(defaultNode: RemoteDefaultNode | undefined): string[] {
  if (Array.isArray(defaultNode)) {
    return normalizeKeywords(defaultNode);
  }

  if (!defaultNode || typeof defaultNode !== 'object') {
    return [];
  }

  if (Array.isArray(defaultNode.keywords)) {
    return normalizeKeywords(defaultNode.keywords);
  }

  if (typeof defaultNode.value === 'string') {
    return normalizeKeywords([defaultNode.value]);
  }

  return [];
}

function normalizeKeywords(value: string[]): string[] {
  const keywords: string[] = [];
  for (const item of value) {
    const keyword = item.trim();
    if (keyword && !keywords.includes(keyword)) {
      keywords.push(keyword);
    }
  }
  return keywords.slice(0, 8);
}

function maskUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return 'configured';
  }
}
