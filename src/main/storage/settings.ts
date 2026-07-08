import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type {
  AppSettingsInput,
  FeatureSettings,
  MihomoMode,
  PetWindowPosition,
  RuleProfile,
  StrategyKey
} from '../../shared/ipc';

export type AppSettings = FeatureSettings & {
  settingsVersion: number;
  subscriptionUrl: string;
  localSubscriptionUrl: string;
  remoteSubscriptionUrl?: string;
  controllerSecret: string;
  mode: MihomoMode;
  strategy: StrategyKey;
  ruleProfile: RuleProfile;
  selectedNode: string;
  petWindow?: PetWindowPosition;
};

type SettingsStoreOptions = {
  defaultSubscriptionUrl?: string;
};

type AppSettingsNormalizerInput = Omit<Partial<AppSettings>, 'selectedNode' | 'petWindow' | 'remoteSubscriptionUrl'> & {
  selectedNode?: string | null;
  petWindow?: PetWindowPosition | null;
  remoteSubscriptionUrl?: string | null;
};

const settingsFileName = 'settings.json';
const currentSettingsVersion = 3;
const validModes: MihomoMode[] = ['rule', 'global', 'direct'];
const validStrategies: StrategyKey[] = ['manual', 'auto', 'fallback', 'load-balance', 'direct'];
const validRuleProfiles: RuleProfile[] = ['smart', 'global', 'subscription'];
const defaultSubscriptionRefreshIntervalHours = 12;
const validSubscriptionRefreshIntervalHours = [0, 6, 12, 24];

export class SettingsStore {
  private readonly filePath: string;
  private readonly defaultSubscriptionUrl: string;

  constructor(private readonly baseDir: string, options: SettingsStoreOptions = {}) {
    this.filePath = join(baseDir, settingsFileName);
    this.defaultSubscriptionUrl = options.defaultSubscriptionUrl?.trim() ?? '';
  }

  async read(): Promise<AppSettings> {
    try {
      const raw = await readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<AppSettings>;
      const normalized = this.normalize(parsed);
      if (this.shouldRewriteNormalizedSettings(parsed, normalized)) {
        await this.write(normalized);
      }
      return normalized;
    } catch {
      const defaults = this.createDefaults();
      await this.write(defaults);
      return defaults;
    }
  }

  async update(next: AppSettingsInput): Promise<AppSettings> {
    const current = await this.read();
    const updated = this.normalize({
      ...current,
      ...next,
      subscriptionUrl:
        typeof next.subscriptionUrl === 'string' ? next.subscriptionUrl : current.localSubscriptionUrl
    });
    await this.write(updated);
    return updated;
  }

  private async write(settings: AppSettings): Promise<void> {
    const { localSubscriptionUrl: _localSubscriptionUrl, ...persisted } = settings;
    await mkdir(this.baseDir, { recursive: true });
    await writeFile(
      this.filePath,
      `${JSON.stringify({ ...persisted, subscriptionUrl: settings.localSubscriptionUrl }, null, 2)}\n`,
      'utf8'
    );
  }

  private normalize(value: AppSettingsNormalizerInput): AppSettings {
    const legacyRuleProfile =
      typeof value.settingsVersion !== 'number' && value.ruleProfile === 'smart'
        ? 'subscription'
        : value.ruleProfile;
    const storedSubscriptionUrl =
      typeof value.subscriptionUrl === 'string' ? value.subscriptionUrl.trim() : '';
    const remoteSubscriptionUrl = normalizeSubscriptionUrl(value.remoteSubscriptionUrl);
    const localSubscriptionUrl = this.defaultSubscriptionUrl || storedSubscriptionUrl;
    const resetBundledSelection = this.shouldResetBundledSelection(value, storedSubscriptionUrl);
    const normalizedStrategy = validStrategies.includes(value.strategy as StrategyKey)
      ? (value.strategy as StrategyKey)
      : 'auto';

    return {
      settingsVersion: currentSettingsVersion,
      subscriptionUrl: remoteSubscriptionUrl || localSubscriptionUrl,
      localSubscriptionUrl,
      remoteSubscriptionUrl,
      controllerSecret:
        typeof value.controllerSecret === 'string' && value.controllerSecret.length >= 16
          ? value.controllerSecret
          : this.createSecret(),
      mode: validModes.includes(value.mode as MihomoMode) ? (value.mode as MihomoMode) : 'rule',
      strategy: resetBundledSelection ? 'auto' : normalizedStrategy,
      ruleProfile: validRuleProfiles.includes(legacyRuleProfile as RuleProfile)
        ? (legacyRuleProfile as RuleProfile)
        : 'subscription',
      selectedNode: resetBundledSelection ? '' : typeof value.selectedNode === 'string' ? value.selectedNode.trim() : '',
      petWindow: normalizePetWindow(value.petWindow),
      systemProxyEnabled:
        typeof value.systemProxyEnabled === 'boolean' ? value.systemProxyEnabled : true,
      dnsEnhanced: normalizeDnsEnhanced(value),
      snifferEnabled: true,
      tunEnabled: typeof value.tunEnabled === 'boolean' ? value.tunEnabled : false,
      strictRouteEnabled:
        typeof value.strictRouteEnabled === 'boolean' ? value.strictRouteEnabled : true,
      allowLan: false,
      subscriptionRefreshIntervalHours: normalizeSubscriptionRefreshInterval(
        value.subscriptionRefreshIntervalHours
      )
    };
  }

  private shouldRewriteNormalizedSettings(parsed: Partial<AppSettings>, normalized: AppSettings): boolean {
    return (
      parsed.settingsVersion !== normalized.settingsVersion ||
      (typeof parsed.subscriptionUrl === 'string' ? parsed.subscriptionUrl.trim() : '') !==
        normalized.localSubscriptionUrl ||
      normalizeSubscriptionUrl(parsed.remoteSubscriptionUrl) !== normalized.remoteSubscriptionUrl ||
      parsed.strategy !== normalized.strategy ||
      parsed.snifferEnabled !== normalized.snifferEnabled ||
      (typeof parsed.selectedNode === 'string' ? parsed.selectedNode.trim() : '') !== normalized.selectedNode
    );
  }

  private shouldResetBundledSelection(value: AppSettingsNormalizerInput, storedSubscriptionUrl: string): boolean {
    if (!this.defaultSubscriptionUrl) return false;

    const settingsVersion = typeof value.settingsVersion === 'number' ? value.settingsVersion : 0;
    const hasCachedManualSelection =
      value.strategy === 'manual' || (typeof value.selectedNode === 'string' && value.selectedNode.trim().length > 0);
    if (!hasCachedManualSelection) return false;

    return settingsVersion < currentSettingsVersion || storedSubscriptionUrl !== this.defaultSubscriptionUrl;
  }

  private createDefaults(): AppSettings {
    return {
      settingsVersion: currentSettingsVersion,
      subscriptionUrl: this.defaultSubscriptionUrl,
      localSubscriptionUrl: this.defaultSubscriptionUrl,
      remoteSubscriptionUrl: undefined,
      controllerSecret: this.createSecret(),
      mode: 'rule',
      strategy: 'auto',
      ruleProfile: 'subscription',
      selectedNode: '',
      petWindow: undefined,
      systemProxyEnabled: true,
      dnsEnhanced: true,
      snifferEnabled: true,
      tunEnabled: false,
      strictRouteEnabled: true,
      allowLan: false,
      subscriptionRefreshIntervalHours: defaultSubscriptionRefreshIntervalHours
    };
  }

  private createSecret(): string {
    return randomBytes(16).toString('hex');
  }
}

function normalizeSubscriptionRefreshInterval(value: unknown): number {
  return validSubscriptionRefreshIntervalHours.includes(value as number)
    ? (value as number)
    : defaultSubscriptionRefreshIntervalHours;
}

function normalizeSubscriptionUrl(value: unknown): string | undefined {
  const text = typeof value === 'string' ? value.trim() : '';
  return text ? text : undefined;
}

function normalizeDnsEnhanced(value: AppSettingsNormalizerInput): boolean {
  if (typeof value.settingsVersion === 'number' && value.settingsVersion >= 2) {
    return typeof value.dnsEnhanced === 'boolean' ? value.dnsEnhanced : true;
  }

  return true;
}

function normalizePetWindow(value: unknown): PetWindowPosition | undefined {
  if (!value || typeof value !== 'object') return undefined;

  const candidate = value as Partial<PetWindowPosition>;
  if (!Number.isFinite(candidate.x) || !Number.isFinite(candidate.y)) return undefined;

  return {
    x: Math.round(candidate.x as number),
    y: Math.round(candidate.y as number)
  };
}
