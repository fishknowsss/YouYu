import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { AppSettingsInput, FeatureSettings, MihomoMode, RuleProfile, StrategyKey } from '../../shared/ipc';

export type AppSettings = FeatureSettings & {
  subscriptionUrl: string;
  controllerSecret: string;
  mode: MihomoMode;
  strategy: StrategyKey;
  ruleProfile: RuleProfile;
  defaultNodeKeywords: string[];
};

type SettingsStoreOptions = {
  defaultSubscriptionUrl?: string;
};

export type AppSettingsUpdate = AppSettingsInput & {
  defaultNodeKeywords?: string[];
};

const settingsFileName = 'settings.json';
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

  async update(next: AppSettingsUpdate): Promise<AppSettings> {
    const current = await this.read();
    const updated = this.normalize({ ...current, ...next });
    await this.write(updated);
    return updated;
  }

  private async write(settings: AppSettings): Promise<void> {
    await mkdir(this.baseDir, { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  }

  private normalize(value: Partial<AppSettings>): AppSettings {
    return {
      subscriptionUrl: typeof value.subscriptionUrl === 'string' ? value.subscriptionUrl : '',
      controllerSecret:
        typeof value.controllerSecret === 'string' && value.controllerSecret.length >= 16
          ? value.controllerSecret
          : this.createSecret(),
      mode: validModes.includes(value.mode as MihomoMode) ? (value.mode as MihomoMode) : 'rule',
      strategy: validStrategies.includes(value.strategy as StrategyKey)
        ? (value.strategy as StrategyKey)
        : 'auto',
      ruleProfile: validRuleProfiles.includes(value.ruleProfile as RuleProfile)
        ? (value.ruleProfile as RuleProfile)
        : 'smart',
      defaultNodeKeywords: normalizeKeywords(value.defaultNodeKeywords),
      systemProxyEnabled:
        typeof value.systemProxyEnabled === 'boolean' ? value.systemProxyEnabled : true,
      dnsEnhanced: typeof value.dnsEnhanced === 'boolean' ? value.dnsEnhanced : true,
      snifferEnabled: typeof value.snifferEnabled === 'boolean' ? value.snifferEnabled : true,
      tunEnabled: typeof value.tunEnabled === 'boolean' ? value.tunEnabled : false,
      allowLan: typeof value.allowLan === 'boolean' ? value.allowLan : false
    };
  }

  private createDefaults(): AppSettings {
    return {
      subscriptionUrl: this.defaultSubscriptionUrl,
      controllerSecret: this.createSecret(),
      mode: 'rule',
      strategy: 'auto',
      ruleProfile: 'smart',
      defaultNodeKeywords: [],
      systemProxyEnabled: true,
      dnsEnhanced: true,
      snifferEnabled: true,
      tunEnabled: false,
      allowLan: false
    };
  }

  private createSecret(): string {
    return randomBytes(16).toString('hex');
  }
}

function normalizeKeywords(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  const keywords: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const keyword = item.trim();
    if (keyword && !keywords.includes(keyword)) {
      keywords.push(keyword);
    }
  }
  return keywords.slice(0, 8);
}
