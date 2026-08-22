import type { ActiveRemoteConfigSnapshot } from './remoteConfig';
import type { MihomoApiClient } from './mihomo/api';
import { strategyLabels, strategyTargets } from './mihomo/config';
import type { AppSettings } from './storage/settings';
import type {
  AppSnapshot,
  AppStatus,
  AppUpdateSnapshot,
  CurrentNodeHealth,
  DiagnosticIssueKind,
  PersistentTrafficStats,
  StrategyGroup,
  UserNotice
} from '../shared/ipc';

type SnapshotMihomoApi = Pick<MihomoApiClient, 'listNodes' | 'listStrategies' | 'getRuntimeStats' | 'getCurrentNode'>;

type AppSnapshotDynamicState = {
  nodeSelectionNotice: AppSnapshot['nodeSelectionNotice'];
  subscriptionRevision: number;
  update: AppUpdateSnapshot;
  lastError?: string;
  logs: string[];
  logCount: number;
  logCapacity: number;
  droppedLogCount: number;
};

type AppSnapshotReaderDependencies = {
  readSettings: () => Promise<AppSettings>;
  getRuntimeStatus: () => AppStatus;
  getControllerPort: () => number;
  createMihomoApi: (options: { secret: string; controllerPort: number }) => SnapshotMihomoApi;
  readTrafficSnapshot: () => Promise<{
    identity?: AppSnapshot['trafficIdentity'];
    stats: PersistentTrafficStats;
  }>;
  readUserNotice: () => Promise<UserNotice | undefined>;
  readRemoteConfigSnapshot: () => Promise<ActiveRemoteConfigSnapshot>;
  readNodeHealth: (nodeName: string, running: boolean, settings: AppSettings) => Promise<CurrentNodeHealth>;
  readDynamicState: () => AppSnapshotDynamicState;
  classifyDiagnosticIssue: (error: string | undefined) => DiagnosticIssueKind | undefined;
};

export function createDefaultStrategies(active: string): StrategyGroup[] {
  return (Object.entries(strategyTargets) as Array<[Exclude<keyof typeof strategyTargets, 'manual'>, string]>).map(
    ([key, target]) => ({
      key,
      label: strategyLabels[key],
      target,
      active: active === key,
      now: undefined,
      delay: undefined
    })
  );
}

export function createAppSnapshotReader(dependencies: AppSnapshotReaderDependencies) {
  return {
    async read(): Promise<AppSnapshot> {
      const settings = await dependencies.readSettings();
      const mihomoApi = dependencies.createMihomoApi({
        secret: settings.controllerSecret,
        controllerPort: dependencies.getControllerPort()
      });
      const running = dependencies.getRuntimeStatus() === 'running';
      const [nodes, strategies, runtime, currentNode] = running
        ? await Promise.all([
            mihomoApi.listNodes().catch(() => []),
            mihomoApi.listStrategies().catch(() => createDefaultStrategies(settings.strategy)),
            mihomoApi.getRuntimeStats().catch(() => ({ activeConnections: 0, uploadTotal: 0, downloadTotal: 0 })),
            mihomoApi.getCurrentNode().catch(() => strategyTargets.auto)
          ])
        : [
            [],
            createDefaultStrategies(settings.strategy),
            { activeConnections: 0, uploadTotal: 0, downloadTotal: 0 },
            strategyTargets[settings.strategy === 'manual' ? 'auto' : settings.strategy]
          ];
      const activeStrategy = strategies.find((strategy) => strategy.active)?.key ?? settings.strategy;
      const [trafficSnapshot, userNotice, remoteConfigSnapshot] = await Promise.all([
        dependencies.readTrafficSnapshot(),
        dependencies.readUserNotice(),
        dependencies.readRemoteConfigSnapshot()
      ]);
      const nodeHealth = await dependencies.readNodeHealth(currentNode, running, settings);
      const state = dependencies.readDynamicState();

      return {
        status: dependencies.getRuntimeStatus(),
        currentNode,
        nodes,
        nodeHealth,
        strategies,
        mode: settings.mode,
        strategy: activeStrategy,
        ruleProfile: remoteConfigSnapshot.config?.ruleProfile ?? settings.ruleProfile,
        configSource: remoteConfigSnapshot.config?.configSource ?? 'local',
        canEditManagedConfig: remoteConfigSnapshot.canEditManagedConfig,
        remoteConfigReady: remoteConfigSnapshot.ready,
        configUpdatedAt: remoteConfigSnapshot.config?.updatedAt,
        features: {
          systemProxyEnabled: settings.systemProxyEnabled,
          dnsEnhanced: settings.dnsEnhanced,
          snifferEnabled: settings.snifferEnabled,
          tunEnabled: settings.tunEnabled,
          strictRouteEnabled: settings.strictRouteEnabled,
          allowLan: settings.allowLan,
          subscriptionRefreshIntervalHours: settings.subscriptionRefreshIntervalHours
        },
        runtime,
        traffic: trafficSnapshot.stats,
        trafficIdentity: trafficSnapshot.identity,
        userNotice,
        nodeSelectionNotice: state.nodeSelectionNotice,
        subscriptionUrl: settings.subscriptionUrl,
        remoteSubscriptionUrl: settings.remoteSubscriptionUrl,
        subscriptionRevision: state.subscriptionRevision,
        update: state.update,
        diagnostics: {
          lastError: state.lastError,
          logs: state.logs,
          logCount: state.logCount,
          logCapacity: state.logCapacity,
          droppedLogCount: state.droppedLogCount,
          issueKind: dependencies.classifyDiagnosticIssue(state.lastError)
        }
      };
    }
  };
}
