import type { ActiveRemoteConfigSnapshot } from './remoteConfig';

export async function syncRequiredBoundRemoteConfig<T>(deps: {
  sync: () => Promise<T>;
  readSnapshot: () => Promise<ActiveRemoteConfigSnapshot>;
}): Promise<T> {
  const result = await deps.sync();
  const snapshot = await deps.readSnapshot();
  if (snapshot.binding && !snapshot.ready) {
    throw new Error('云端配置尚未同步，请联网同步后重试');
  }
  return result;
}
