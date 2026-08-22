import { describe, expect, it, vi } from 'vitest';
import { createOperationRunner } from '../../src/renderer/appOperationRunner';
import { createAppSnapshotStore } from '../../src/renderer/appSnapshotStore';

type Snapshot = { value: string };
type Api = {
  getSnapshot: () => Promise<Snapshot>;
  cancelOperation: (requestId: string) => Promise<boolean>;
  cancelNodeTests: () => Promise<unknown>;
};

function createHarness(api?: Api) {
  const commits: Snapshot[] = [];
  const snapshotStore = createAppSnapshotStore<Snapshot>({ value: 'initial' }, (snapshot) => commits.push(snapshot));
  snapshotStore.mount();
  const busy: boolean[] = [];
  const busyLabels: string[] = [];
  const messages: string[] = [];
  let requestSequence = 0;
  const runner = createOperationRunner<Snapshot, Api>({
    getApi: () => api,
    snapshotStore,
    createRequest: () => ({ requestId: `request-${++requestSequence}` }),
    setBusy: (value) => busy.push(value),
    setBusyLabel: (value) => busyLabels.push(value),
    setMessage: (value) => messages.push(value),
    formatError: (error) => (error instanceof Error ? error.message : String(error)),
    defaultTimeoutMs: 100
  });
  return { runner, snapshotStore, commits, busy, busyLabels, messages };
}

describe('createOperationRunner', () => {
  it('fails closed before mutating busy state when the preload API is unavailable', async () => {
    const { runner, busy, messages } = createHarness();

    await expect(runner.run(async () => ({ value: 'unused' }), 'done')).resolves.toBe(false);

    expect(messages).toEqual(['核心接口未加载']);
    expect(busy).toEqual([]);
  });

  it('commits a successful cancellable operation and clears all tracking state', async () => {
    const api: Api = {
      getSnapshot: vi.fn(),
      cancelOperation: vi.fn(),
      cancelNodeTests: vi.fn()
    };
    const { runner, snapshotStore, commits, busy, busyLabels, messages } = createHarness(api);

    await expect(
      runner.run(
        async (_api, request) => {
          expect(request?.requestId).toBe('request-1');
          return { value: 'next' };
        },
        'done',
        { workingMessage: 'working', cancellable: true }
      )
    ).resolves.toBe(true);

    expect(snapshotStore.getSnapshot()).toEqual({ value: 'next' });
    expect(commits).toEqual([{ value: 'next' }]);
    expect(busy).toEqual([true, false]);
    expect(busyLabels).toEqual(['working', '']);
    expect(messages).toEqual(['', 'done']);
    expect(runner.getTrackingCounts()).toEqual({ tasks: 0, requests: 0, canceledRequests: 0, nodeTests: 0 });
  });

  it('recovers a snapshot and preserves error ownership when an action fails', async () => {
    const api: Api = {
      getSnapshot: vi.fn(async () => ({ value: 'recovered' })),
      cancelOperation: vi.fn(),
      cancelNodeTests: vi.fn()
    };
    const { runner, snapshotStore, messages } = createHarness(api);
    const sink = vi.fn();

    await expect(runner.run(async () => Promise.reject(new Error('failed')), '', { messageSink: sink })).resolves.toBe(
      false
    );

    expect(snapshotStore.getSnapshot()).toEqual({ value: 'recovered' });
    expect(messages).toEqual([]);
    expect(sink.mock.calls).toEqual([[''], ['failed']]);
  });

  it('cancels a timed-out request exactly once before clearing request tracking', async () => {
    const api: Api = {
      getSnapshot: vi.fn(async () => ({ value: 'recovered' })),
      cancelOperation: vi.fn(async () => true),
      cancelNodeTests: vi.fn()
    };
    const { runner } = createHarness(api);

    await expect(
      runner.run(() => new Promise<Snapshot>(() => undefined), '', {
        cancellable: true,
        timeoutMs: 0,
        timeoutLabel: 'slow'
      })
    ).resolves.toBe(false);

    expect(api.cancelOperation).toHaveBeenCalledTimes(1);
    expect(api.cancelOperation).toHaveBeenCalledWith('request-1');
    expect(runner.getTrackingCounts()).toEqual({ tasks: 0, requests: 0, canceledRequests: 0, nodeTests: 0 });
  });

  it('aborts active tasks and performs best-effort request and node-test cleanup on dispose', async () => {
    const api: Api = {
      getSnapshot: vi.fn(),
      cancelOperation: vi.fn(async () => true),
      cancelNodeTests: vi.fn(async () => undefined)
    };
    const { runner } = createHarness(api);
    const controller = new AbortController();
    const request = { requestId: 'external-request' };
    runner.trackTask(controller);
    runner.trackRequest(api, request);
    runner.trackNodeTests(api);

    runner.dispose();
    await vi.waitFor(() => expect(api.cancelOperation).toHaveBeenCalledWith('external-request'));

    expect(controller.signal.aborted).toBe(true);
    expect(api.cancelNodeTests).toHaveBeenCalledTimes(1);
    expect(runner.getTrackingCounts()).toEqual({ tasks: 0, requests: 0, canceledRequests: 1, nodeTests: 0 });
  });
});
