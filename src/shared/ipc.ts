export type AppStatus = 'stopped' | 'running' | 'failed';
export type MihomoMode = 'rule' | 'global' | 'direct';
export type StrategyKey = 'manual' | 'auto' | 'fallback' | 'load-balance' | 'direct';
export type RuleProfile = 'smart' | 'global' | 'subscription';
export type PetWindowPosition = {
  x: number;
  y: number;
};
export type DesktopPetState =
  | 'idle'
  | 'walkRight'
  | 'walkLeft'
  | 'wave'
  | 'jump'
  | 'liftHold'
  | 'drag'
  | 'sleepWake'
  | 'focusWait'
  | 'happy'
  | 'edgePeek'
  | 'edgeLeft'
  | 'edgeRight'
  | 'fallRecover'
  | 'annoyed'
  | 'comfortSad'
  | 'rewardObserve';

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

export type TrafficIdentity = {
  userId: string;
  deviceId: string;
  name: string;
  deviceName?: string;
  registeredAt: string;
  lastReportedAt?: string;
  verificationStatus?: 'verified' | 'pending';
};

export type PersistentTrafficStats = {
  totalUpload: number;
  totalDownload: number;
  todayUpload: number;
  todayDownload: number;
  pendingUpload: number;
  pendingDownload: number;
  lastUpdatedAt?: string;
  lastReportedAt?: string;
  reportStatus: 'idle' | 'synced' | 'pending' | 'failed' | 'not-configured';
  reportError?: string;
};

export type ConnectivityServiceKey =
  | 'steam'
  | 'steamNetwork'
  | 'chatgpt'
  | 'claude'
  | 'gemini'
  | 'flow'
  | 'runway'
  | 'tencent'
  | 'google'
  | 'cloudflare'
  | 'ehentai';

export type ConnectivityStatus = 'untested' | 'available' | 'blocked' | 'timeout' | 'failed';
export type ConnectivityReachability = 'ok' | 'guarded' | 'blocked' | 'unknown';
export type ConnectivityCategory = 'domestic' | 'global' | 'ai' | 'special';

export type ConnectivityTimings = {
  connectMs?: number;
  tlsMs?: number;
  firstByteMs?: number;
  totalMs?: number;
};

export type ConnectivityResult = {
  key: ConnectivityServiceKey;
  name: string;
  url: string;
  category?: ConnectivityCategory;
  status: ConnectivityStatus;
  statusText: string;
  reachability?: ConnectivityReachability;
  checkedAt?: string;
  httpCode?: number;
  finalUrl?: string;
  region?: string;
  ip?: string;
  colo?: string;
  timings: ConnectivityTimings;
  rule?: string;
  rulePayload?: string;
  chains?: string[];
  error?: string;
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
  strictRouteEnabled: boolean;
  allowLan: boolean;
  subscriptionRefreshIntervalHours: number;
};

export type AppSettingsInput = Partial<FeatureSettings> & {
  subscriptionUrl?: string;
  mode?: MihomoMode;
  strategy?: StrategyKey;
  ruleProfile?: RuleProfile;
  selectedNode?: string | null;
  petWindow?: PetWindowPosition | null;
};

export type TrafficRegistrationInput = {
  name: string;
  passphrase: string;
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
  traffic: PersistentTrafficStats;
  trafficIdentity?: TrafficIdentity;
  subscriptionUrl: string;
  diagnostics: AppDiagnostics;
};

export type YouYuApi = {
  getSnapshot: () => Promise<AppSnapshot>;
  onSnapshotUpdated: (listener: (snapshot: AppSnapshot) => void) => () => void;
  onPetStateUpdated: (listener: (state: DesktopPetState) => void) => () => void;
  wavePet: () => Promise<void>;
  startPetDrag: () => Promise<void>;
  stopPetDrag: (moved?: boolean) => Promise<DesktopPetState | undefined>;
  showMainWindow: () => Promise<void>;
  start: () => Promise<AppSnapshot>;
  stop: () => Promise<AppSnapshot>;
  repair: () => Promise<AppSnapshot>;
  selectNode: (name: string) => Promise<AppSnapshot>;
  selectStrategy: (strategy: StrategyKey) => Promise<AppSnapshot>;
  setMode: (mode: MihomoMode) => Promise<AppSnapshot>;
  testNode: (name: string) => Promise<AppSnapshot>;
  testAllNodes: () => Promise<AppSnapshot>;
  testConnectivity: (key: ConnectivityServiceKey) => Promise<ConnectivityResult>;
  testAllConnectivity: () => Promise<ConnectivityResult[]>;
  closeConnections: () => Promise<AppSnapshot>;
  updateSubscription: () => Promise<AppSnapshot>;
  saveSettings: (settings: AppSettingsInput) => Promise<AppSnapshot>;
  registerTrafficIdentity: (input: TrafficRegistrationInput) => Promise<AppSnapshot>;
};

export const ipcChannels = {
  getSnapshot: 'youyu:get-snapshot',
  snapshotUpdated: 'youyu:snapshot-updated',
  petStateUpdated: 'youyu:pet-state-updated',
  wavePet: 'youyu:wave-pet',
  startPetDrag: 'youyu:start-pet-drag',
  stopPetDrag: 'youyu:stop-pet-drag',
  showMainWindow: 'youyu:show-main-window',
  start: 'youyu:start',
  stop: 'youyu:stop',
  repair: 'youyu:repair',
  selectNode: 'youyu:select-node',
  selectStrategy: 'youyu:select-strategy',
  setMode: 'youyu:set-mode',
  testNode: 'youyu:test-node',
  testAllNodes: 'youyu:test-all-nodes',
  testConnectivity: 'youyu:test-connectivity',
  testAllConnectivity: 'youyu:test-all-connectivity',
  closeConnections: 'youyu:close-connections',
  updateSubscription: 'youyu:update-subscription',
  saveSettings: 'youyu:save-settings',
  registerTrafficIdentity: 'youyu:register-traffic-identity'
} as const;
