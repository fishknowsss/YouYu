export type AppStatus = 'stopped' | 'running' | 'failed';
export type AppBuildChannel = 'standard' | 'in' | 'no';
export type MihomoMode = 'rule' | 'global' | 'direct';
export type StrategyKey = 'manual' | 'auto' | 'fallback' | 'load-balance' | 'direct';
export type RuleProfile = 'ruleset' | 'smart' | 'global' | 'subscription';
export type RemoteControlConfig = {
  version: number;
  enabled: boolean;
  subscriptionUrl?: string;
  ruleProfile?: RuleProfile;
  preferredNode?: string;
  preferredStrategy?: StrategyKey;
  directRules: string[];
  proxyRules: string[];
  anomalyThresholdBytes?: number;
  updatedAt?: string;
};
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
  | 'edgeLeft'
  | 'edgeRight'
  | 'edgeLeftBlink'
  | 'edgeRightBlink'
  | 'edgeLeftSleep'
  | 'edgeRightSleep'
  | 'topSleep'
  | 'bottomSleep'
  | 'bottomDizzy'
  | 'bottomAngry'
  | 'fallRecover'
  | 'annoyed'
  | 'comfortSad'
  | 'rewardObserve';

export type ProxyNode = {
  name: string;
  delay?: number;
  active?: boolean;
  testState?: 'testing' | 'tested' | 'failed';
};

export type NodeMetricStatus = 'untested' | 'testing' | 'measured' | 'failed';
export type NodeAvailabilityTone = 'danger' | 'warning' | 'success';

export type NodeAvailabilitySnapshot = {
  status: NodeMetricStatus;
  totalCount: number;
  availableCount?: number;
  percent?: number;
  tone?: NodeAvailabilityTone;
  checkedAt?: string;
};

export type CurrentNodeHealth = {
  nodeName: string;
  delayStatus: NodeMetricStatus;
  delay?: number;
  delayCheckedAt?: string;
  availability: NodeAvailabilitySnapshot;
};

export type StrategyGroup = {
  key: StrategyKey;
  label: string;
  target: string;
  active: boolean;
  now?: string;
  delay?: number;
};

export type RuntimeConnectionStats = {
  id?: string;
  upload?: number;
  download?: number;
  chains?: string[];
  metadata?: {
    host?: string;
    destinationIP?: string;
    process?: string;
    processPath?: string;
    sourceIP?: string;
    sourcePort?: string;
    destinationPort?: string;
  };
};

export type RuntimeStats = {
  activeConnections: number;
  uploadTotal: number;
  downloadTotal: number;
  connections?: RuntimeConnectionStats[];
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

export type TrafficNodeUsageSummary = {
  name: string;
  upload: number;
  download: number;
  durationMs: number;
  lastUsedAt?: string;
};

export type TrafficNodeUsageStats = {
  mostUsed?: TrafficNodeUsageSummary;
  longestUsed?: TrafficNodeUsageSummary;
};

export type PersistentTrafficStats = {
  totalUpload: number;
  totalDownload: number;
  todayUpload: number;
  todayDownload: number;
  pendingUpload: number;
  pendingDownload: number;
  totalSource?: 'local' | 'server';
  serverSyncedAt?: string;
  nodeUsage: TrafficNodeUsageStats;
  lastUpdatedAt?: string;
  lastReportedAt?: string;
  reportStatus: 'idle' | 'synced' | 'pending' | 'failed' | 'not-configured';
  reportError?: string;
};

export type ConnectivityServiceKey =
  | 'steam'
  | 'steamNetwork'
  | 'steamCloud'
  | 'chatgpt'
  | 'claude'
  | 'gemini'
  | 'flow'
  | 'pixverse'
  | 'github'
  | 'microsoftStore'
  | 'discord'
  | 'turnstile'
  | 'recaptcha'
  | 'hcaptcha'
  | 'google'
  | 'cloudflare';

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

export type AppUpdateStatus =
  'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'not-available' | 'failed';

export type AppUpdateSnapshot = {
  currentVersion: string;
  buildChannel: AppBuildChannel;
  updateChannel: string;
  status: AppUpdateStatus;
  availableVersion?: string;
  downloadedVersion?: string;
  percent?: number;
  checkedAt?: string;
  message?: string;
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
  remoteSubscriptionUrl?: string | null;
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

export type OperationRequest = {
  requestId: string;
};

export type AppSnapshot = {
  status: AppStatus;
  currentNode: string;
  nodes: ProxyNode[];
  nodeHealth: CurrentNodeHealth;
  strategies: StrategyGroup[];
  mode: MihomoMode;
  strategy: StrategyKey;
  ruleProfile: RuleProfile;
  features: FeatureSettings;
  runtime: RuntimeStats;
  traffic: PersistentTrafficStats;
  trafficIdentity?: TrafficIdentity;
  subscriptionUrl: string;
  remoteSubscriptionUrl?: string;
  subscriptionRevision?: number;
  update: AppUpdateSnapshot;
  diagnostics: AppDiagnostics;
};

export type YouYuApi = {
  getSnapshot: () => Promise<AppSnapshot>;
  onSnapshotUpdated: (listener: (snapshot: AppSnapshot) => void) => () => void;
  onPetStateUpdated: (listener: (state: DesktopPetState) => void) => () => void;
  wavePet: () => Promise<void>;
  startPetDrag: () => Promise<void>;
  stopPetDrag: (moved?: boolean) => Promise<DesktopPetState | undefined>;
  setPetMousePassthrough: (passthrough: boolean) => Promise<void>;
  showMainWindow: () => Promise<void>;
  start: (request?: OperationRequest) => Promise<AppSnapshot>;
  stop: (request?: OperationRequest) => Promise<AppSnapshot>;
  repair: (request?: OperationRequest) => Promise<AppSnapshot>;
  selectNode: (name: string) => Promise<AppSnapshot>;
  selectBestAutoNode: (request?: OperationRequest) => Promise<AppSnapshot>;
  selectStrategy: (strategy: StrategyKey) => Promise<AppSnapshot>;
  setMode: (mode: MihomoMode) => Promise<AppSnapshot>;
  testNode: (name: string) => Promise<AppSnapshot>;
  testAllNodes: () => Promise<AppSnapshot>;
  cancelNodeTests: () => Promise<AppSnapshot>;
  testConnectivity: (key: ConnectivityServiceKey) => Promise<ConnectivityResult>;
  testAllConnectivity: () => Promise<ConnectivityResult[]>;
  closeConnections: () => Promise<AppSnapshot>;
  updateSubscription: (request?: OperationRequest) => Promise<AppSnapshot>;
  saveSettings: (settings: AppSettingsInput, request?: OperationRequest) => Promise<AppSnapshot>;
  registerTrafficIdentity: (input: TrafficRegistrationInput) => Promise<AppSnapshot>;
  syncRemoteConfig: (request?: OperationRequest) => Promise<AppSnapshot>;
  cancelOperation: (requestId: string) => Promise<boolean>;
  checkForUpdates: () => Promise<AppSnapshot>;
  installUpdate: () => Promise<AppSnapshot>;
};

export const ipcChannels = {
  getSnapshot: 'youyu:get-snapshot',
  snapshotUpdated: 'youyu:snapshot-updated',
  petStateUpdated: 'youyu:pet-state-updated',
  wavePet: 'youyu:wave-pet',
  startPetDrag: 'youyu:start-pet-drag',
  stopPetDrag: 'youyu:stop-pet-drag',
  setPetMousePassthrough: 'youyu:set-pet-mouse-passthrough',
  showMainWindow: 'youyu:show-main-window',
  start: 'youyu:start',
  stop: 'youyu:stop',
  repair: 'youyu:repair',
  selectNode: 'youyu:select-node',
  selectBestAutoNode: 'youyu:select-best-auto-node',
  selectStrategy: 'youyu:select-strategy',
  setMode: 'youyu:set-mode',
  testNode: 'youyu:test-node',
  testAllNodes: 'youyu:test-all-nodes',
  cancelNodeTests: 'youyu:cancel-node-tests',
  testConnectivity: 'youyu:test-connectivity',
  testAllConnectivity: 'youyu:test-all-connectivity',
  closeConnections: 'youyu:close-connections',
  updateSubscription: 'youyu:update-subscription',
  saveSettings: 'youyu:save-settings',
  registerTrafficIdentity: 'youyu:register-traffic-identity',
  syncRemoteConfig: 'youyu:sync-remote-config',
  cancelOperation: 'youyu:cancel-operation',
  checkForUpdates: 'youyu:check-for-updates',
  installUpdate: 'youyu:install-update'
} as const;
