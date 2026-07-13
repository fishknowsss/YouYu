import type { RemoteControlConfig } from '../shared/ipc';
import type { ActiveRemoteConfigSnapshot } from './remoteConfig';

type RemoteSubscriptionSettings = {
  remoteSubscriptionUrl?: string;
};

export function createRemoteSubscriptionCoordinator(deps: {
  readSettings: () => Promise<RemoteSubscriptionSettings>;
  updateRemoteSubscription: (value: string | null) => Promise<unknown>;
  isSnapshotCurrent: (snapshot: ActiveRemoteConfigSnapshot) => Promise<boolean>;
  getActiveSnapshot: () => Promise<ActiveRemoteConfigSnapshot>;
  onChanged?: (url: string) => void;
}) {
  let queue: Promise<unknown> = Promise.resolve();

  async function write(config?: RemoteControlConfig): Promise<boolean> {
    const nextUrl = config?.enabled ? (config.subscriptionUrl?.trim() ?? '') : '';
    const settings = await deps.readSettings();
    if ((settings.remoteSubscriptionUrl ?? '') === nextUrl) return false;

    await deps.updateRemoteSubscription(nextUrl || null);
    deps.onChanged?.(nextUrl);
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
