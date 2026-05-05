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

type AppSettingsNormalizerInput = Omit<Partial<AppSettings>, 'selectedNode' | 'petWindow'> & {
  selectedNode?: string | null;
  petWindow?: PetWindowPosition | null;
};

const settingsFileName = 'settings.json';
const currentSettingsVersion = 1;
const validModes: MihomoMode[] = ['rule', 'global', 'direct'];
const validStrategies: StrategyKey[] = ['manual', 'auto', 'fallback', 'load-balance', 'direct'];
const validRuleProfiles: RuleProfile[] = ['smart', 'global', 'subscription'];

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
      return this.normalize(parsed);
    } catch {
      const defaults = this.createDefaults();
      await this.write(defaults);
      return defaults;
    }
  }

  async update(next: AppSettingsInput): Promise<AppSettings> {
    const current = await this.read();
    const updated = this.normalize({ ...current, ...next });
    await this.write(updated);
    return updated;
  }

  private async write(settings: AppSettings): Promise<void> {
    await mkdir(this.baseDir, { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  }

  private normalize(value: AppSettingsNormalizerInput): AppSettings {
    const legacyRuleProfile =
      typeof value.settingsVersion !== 'number' && value.ruleProfile === 'smart'
        ? 'subscription'
        : value.ruleProfile;

    return {
      settingsVersion: currentSettingsVersion,
      subscriptionUrl: typeof value.subscriptionUrl === 'string' ? value.subscriptionUrl : '',
      controllerSecret:
        typeof value.controllerSecret === 'string' && value.controllerSecret.length >= 16
          ? value.controllerSecret
          : this.createSecret(),
      mode: validModes.includes(value.mode as MihomoMode) ? (value.mode as MihomoMode) : 'rule',
      strategy: validStrategies.includes(value.strategy as StrategyKey)
        ? (value.strategy as StrategyKey)
        : 'auto',
      ruleProfile: validRuleProfiles.includes(legacyRuleProfile as RuleProfile)
        ? (legacyRuleProfile as RuleProfile)
        : 'subscription',
      selectedNode: typeof value.selectedNode === 'string' ? value.selectedNode.trim() : '',
      petWindow: normalizePetWindow(value.petWindow),
      systemProxyEnabled:
        typeof value.systemProxyEnabled === 'boolean' ? value.systemProxyEnabled : true,
      dnsEnhanced: typeof value.dnsEnhanced === 'boolean' ? value.dnsEnhanced : false,
      snifferEnabled: typeof value.snifferEnabled === 'boolean' ? value.snifferEnabled : true,
      tunEnabled:
        typeof value.tunEnabled === 'boolean'
          ? typeof value.strictRouteEnabled === 'boolean'
            ? value.tunEnabled
            : true
          : true,
      strictRouteEnabled:
        typeof value.strictRouteEnabled === 'boolean' ? value.strictRouteEnabled : true,
      allowLan: false
    };
  }

  private createDefaults(): AppSettings {
    return {
      settingsVersion: currentSettingsVersion,
      subscriptionUrl: this.defaultSubscriptionUrl,
      controllerSecret: this.createSecret(),
      mode: 'rule',
      strategy: 'auto',
      ruleProfile: 'subscription',
      selectedNode: '',
      petWindow: undefined,
      systemProxyEnabled: true,
      dnsEnhanced: false,
      snifferEnabled: true,
      tunEnabled: true,
      strictRouteEnabled: true,
      allowLan: false
    };
  }

  private createSecret(): string {
    return randomBytes(16).toString('hex');
  }
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
