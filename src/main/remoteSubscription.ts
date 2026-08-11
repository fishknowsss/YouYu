import type { RemoteControlConfig, RuleProfile } from '../shared/ipc';
import type { ActiveRemoteConfigSnapshot } from './remoteConfig';

type RemoteSubscriptionSettings = {
  remoteSubscriptionUrl?: string;
  ruleProfile?: RuleProfile;
};

export function createRemoteSubscriptionCoordinator(deps: {
  readSettings: () => Promise<RemoteSubscriptionSettings>;
  updateRemoteSubscription: (value: string | null) => Promise<unknown>;
  updateRuleProfile: (value: RuleProfile) => Promise<unknown>;
  isSnapshotCurrent: (snapshot: ActiveRemoteConfigSnapshot) => Promise<boolean>;
  getActiveSnapshot: () => Promise<ActiveRemoteConfigSnapshot>;
  onChanged?: (url: string) => void;
}) {
  let queue: Promise<unknown> = Promise.resolve();

  async function write(config?: RemoteControlConfig): Promise<boolean> {
    const nextUrl = config?.enabled ? (config.subscriptionUrl?.trim() ?? '') : '';
    const nextRuleProfile = config?.enabled ? config.ruleProfile : undefined;
    const settings = await deps.readSettings();
    const subscriptionChanged = (settings.remoteSubscriptionUrl ?? '') !== nextUrl;
    const ruleProfileChanged = nextRuleProfile !== undefined && settings.ruleProfile !== nextRuleProfile;
    if (!subscriptionChanged && !ruleProfileChanged) return false;

    if (subscriptionChanged) {
      await deps.updateRemoteSubscription(nextUrl || null);
      deps.onChanged?.(nextUrl);
    }
    if (ruleProfileChanged) await deps.updateRuleProfile(nextRuleProfile);
    return true;
  }

  async function applyCurrent(config?: RemoteControlConfig, snapshot?: ActiveRemoteConfigSnapshot): Promise<boolean> {
    if (snapshot && !(await deps.isSnapshotCurrent(snapshot))) return false;

    let changed = await write(config);
    if (snapshot && !(await deps.isSnapshotCurrent(snapshot))) {
      const current = await deps.getActiveSnapshot();
      changed = (await write(current.config)) || changed;
    }
    return changed;
  }

  return {
    apply(config?: RemoteControlConfig, snapshot?: ActiveRemoteConfigSnapshot): Promise<boolean> {
      const run = queue.then(
        () => applyCurrent(config, snapshot),
        () => applyCurrent(config, snapshot)
      );
      queue = run.catch(() => undefined);
      return run;
    }
  };
}
