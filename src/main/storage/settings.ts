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
  selectedNode: string;
};

type SettingsStoreOptions = {
  defaultSubscriptionUrl?: string;
};

type AppSettingsNormalizerInput = Omit<Partial<AppSettings>, 'selectedNode'> & {
  selectedNode?: string | null;
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
      selectedNode: typeof value.selectedNode === 'string' ? value.selectedNode.trim() : '',
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
      selectedNode: '',
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
