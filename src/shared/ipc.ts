export type AppStatus = 'stopped' | 'running' | 'failed';
export type MihomoMode = 'rule' | 'global' | 'direct';
export type StrategyKey = 'manual' | 'auto' | 'fallback' | 'load-balance' | 'direct';
export type RuleProfile = 'smart' | 'global' | 'subscription';

export type ProxyNode = {
  name: string;
  delay?: number;
  active?: boolean;
};

export type StrategyGroup = {
  key: StrategyKey;
  label: string;
  target: string;
  active: boolean;
  now?: string;
  delay?: number;
};

export type RuntimeStats = {
  activeConnections: number;
  uploadTotal: number;
  downloadTotal: number;
};

export type AppDiagnostics = {
  lastError?: string;
  logs: string[];
};

export type FeatureSettings = {
  systemProxyEnabled: boolean;
  dnsEnhanced: boolean;
  snifferEnabled: boolean;
  tunEnabled: boolean;
  allowLan: boolean;
};

export type AppSettingsInput = Partial<FeatureSettings> & {
  subscriptionUrl?: string;
  mode?: MihomoMode;
  strategy?: StrategyKey;
  ruleProfile?: RuleProfile;
};

export type AppSnapshot = {
  status: AppStatus;
  currentNode: string;
  nodes: ProxyNode[];
  strategies: StrategyGroup[];
  mode: MihomoMode;
  strategy: StrategyKey;
  ruleProfile: RuleProfile;
  features: FeatureSettings;
  runtime: RuntimeStats;
  subscriptionUrl: string;
  diagnostics: AppDiagnostics;
};

export type YouYuApi = {
  getSnapshot: () => Promise<AppSnapshot>;
  start: () => Promise<AppSnapshot>;
  stop: () => Promise<AppSnapshot>;
  repair: () => Promise<AppSnapshot>;
  selectNode: (name: string) => Promise<AppSnapshot>;
  selectStrategy: (strategy: StrategyKey) => Promise<AppSnapshot>;
  setMode: (mode: MihomoMode) => Promise<AppSnapshot>;
  testNode: (name: string) => Promise<AppSnapshot>;
  testAllNodes: () => Promise<AppSnapshot>;
  closeConnections: () => Promise<AppSnapshot>;
  updateSubscription: () => Promise<AppSnapshot>;
  saveSettings: (settings: AppSettingsInput) => Promise<AppSnapshot>;
};

export const ipcChannels = {
  getSnapshot: 'youyu:get-snapshot',
  start: 'youyu:start',
  stop: 'youyu:stop',
  repair: 'youyu:repair',
  selectNode: 'youyu:select-node',
  selectStrategy: 'youyu:select-strategy',
  setMode: 'youyu:set-mode',
  testNode: 'youyu:test-node',
  testAllNodes: 'youyu:test-all-nodes',
  closeConnections: 'youyu:close-connections',
  updateSubscription: 'youyu:update-subscription',
  saveSettings: 'youyu:save-settings'
} as const;
