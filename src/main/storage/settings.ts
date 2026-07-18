import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { readJsonFile, writeJsonFileAtomic } from './jsonFile';
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
const currentSettingsVersion = 5;
const bundledSelectionMigrationVersion = 3;
const validModes: MihomoMode[] = ['rule', 'global', 'direct'];
const validStrategies: StrategyKey[] = ['manual', 'auto', 'fallback', 'load-balance', 'direct'];
const validRuleProfiles: RuleProfile[] = ['ruleset', 'subscription'];
const defaultSubscriptionRefreshIntervalHours = 12;
const validSubscriptionRefreshIntervalHours = [0, 6, 12, 24];

export class SettingsStore {
  private readonly filePath: string;
  private readonly defaultSubscriptionUrl: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly baseDir: string,
    options: SettingsStoreOptions = {}
  ) {
    this.filePath = join(baseDir, settingsFileName);
    this.defaultSubscriptionUrl = options.defaultSubscriptionUrl?.trim() ?? '';
  }

  async read(): Promise<AppSettings> {
    return this.enqueue(() => this.readCurrent());
  }

  async update(next: AppSettingsInput): Promise<AppSettings> {
    return this.enqueue(async () => {
      const current = await this.readCurrent();
      const updated = this.normalize({
        ...current,
        ...next,
        subscriptionUrl: typeof next.subscriptionUrl === 'string' ? next.subscriptionUrl : current.localSubscriptionUrl
      });
      await this.write(updated);
      return updated;
    });
  }

  private async write(settings: AppSettings): Promise<void> {
    const { localSubscriptionUrl: _localSubscriptionUrl, ...persisted } = settings;
    await writeJsonFileAtomic(this.filePath, { ...persisted, subscriptionUrl: settings.localSubscriptionUrl });
  }

  private async readCurrent(): Promise<AppSettings> {
    const result = await readJsonFile<Partial<AppSettings>>(this.filePath, {
      validate: (value) =>
        Boolean(value) &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        (typeof value.settingsVersion === 'number' ||
          typeof value.subscriptionUrl === 'string' ||
          typeof value.controllerSecret === 'string')
    });
    if (result.status === 'found') {
      const normalized = this.normalize(result.value);
      if (this.shouldRewriteNormalizedSettings(result.value, normalized)) {
        await this.write(normalized);
      }
      return normalized;
    }

    const defaults = this.createDefaults();
    await this.write(defaults);
    return defaults;
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private normalize(value: AppSettingsNormalizerInput): AppSettings {
    const normalizedRuleProfile = normalizeRuleProfile(value.ruleProfile, value.settingsVersion);
    const storedSubscriptionUrl = typeof value.subscriptionUrl === 'string' ? value.subscriptionUrl.trim() : '';
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
      ruleProfile: normalizedRuleProfile,
      selectedNode: resetBundledSelection
        ? ''
        : typeof value.selectedNode === 'string'
          ? value.selectedNode.trim()
          : '',
      petWindow: normalizePetWindow(value.petWindow),
      systemProxyEnabled: true,
      dnsEnhanced: true,
      snifferEnabled: true,
      tunEnabled: typeof value.tunEnabled === 'boolean' ? value.tunEnabled : false,
      strictRouteEnabled: true,
      allowLan: false,
      subscriptionRefreshIntervalHours: normalizeSubscriptionRefreshInterval(value.subscriptionRefreshIntervalHours)
    };
  }

  private shouldRewriteNormalizedSettings(parsed: Partial<AppSettings>, normalized: AppSettings): boolean {
    return (
      parsed.settingsVersion !== normalized.settingsVersion ||
      (typeof parsed.subscriptionUrl === 'string' ? parsed.subscriptionUrl.trim() : '') !==
        normalized.localSubscriptionUrl ||
      normalizeSubscriptionUrl(parsed.remoteSubscriptionUrl) !== normalized.remoteSubscriptionUrl ||
      parsed.controllerSecret !== normalized.controllerSecret ||
      parsed.strategy !== normalized.strategy ||
      parsed.ruleProfile !== normalized.ruleProfile ||
      parsed.systemProxyEnabled !== normalized.systemProxyEnabled ||
      parsed.dnsEnhanced !== normalized.dnsEnhanced ||
      parsed.snifferEnabled !== normalized.snifferEnabled ||
      parsed.strictRouteEnabled !== normalized.strictRouteEnabled ||
      (typeof parsed.selectedNode === 'string' ? parsed.selectedNode.trim() : '') !== normalized.selectedNode
    );
  }

  private shouldResetBundledSelection(value: AppSettingsNormalizerInput, storedSubscriptionUrl: string): boolean {
    if (!this.defaultSubscriptionUrl) return false;

    const settingsVersion = typeof value.settingsVersion === 'number' ? value.settingsVersion : 0;
    const hasCachedManualSelection =
      value.strategy === 'manual' || (typeof value.selectedNode === 'string' && value.selectedNode.trim().length > 0);
    if (!hasCachedManualSelection) return false;

    return settingsVersion < bundledSelectionMigrationVersion || storedSubscriptionUrl !== this.defaultSubscriptionUrl;
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
      ruleProfile: 'ruleset',
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

function normalizeRuleProfile(value: unknown, settingsVersion: unknown): RuleProfile {
  // Before settingsVersion existed, "smart" meant preserving the airport's own
  // routing. Keep that one historical migration, then collapse the later
  // local/global variants into the supported smart ruleset.
  if (typeof settingsVersion !== 'number' && value === 'smart') return 'subscription';
  return validRuleProfiles.includes(value as RuleProfile) ? (value as RuleProfile) : 'ruleset';
}

function normalizeSubscriptionUrl(value: unknown): string | undefined {
  const text = typeof value === 'string' ? value.trim() : '';
  return text ? text : undefined;
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
