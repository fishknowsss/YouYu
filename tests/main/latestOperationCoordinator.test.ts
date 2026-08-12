import { describe, expect, it, vi } from 'vitest';
import { LatestOperationCoordinator } from '../../src/main/latestOperationCoordinator';

function createGate() {
  let resolve!: () => void;
  const promise = new Promise<void>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

describe('LatestOperationCoordinator', () => {
  it('coalesces equivalent work while starting a fresh operation after it settles', async () => {
    const coordinator = new LatestOperationCoordinator<string>();
    const firstStarted = createGate();
    const finishFirst = createGate();
    const firstAction = vi.fn(async () => {
      firstStarted.resolve();
      await finishFirst.promise;
      return 'first';
    });
    const joinedAction = vi.fn(async () => 'joined replacement');

    const first = coordinator.coalesce(firstAction);
    await firstStarted.promise;
    const joined = coordinator.coalesce(joinedAction);
    finishFirst.resolve();

    await expect(first).resolves.toBe('first');
    await expect(joined).resolves.toBe('first');
    expect(firstAction).toHaveBeenCalledOnce();
    expect(joinedAction).not.toHaveBeenCalled();

    await expect(coordinator.coalesce(joinedAction)).resolves.toBe('joined replacement');
    expect(joinedAction).toHaveBeenCalledOnce();
  });

  it('waits for the superseded operation to settle before starting its replacement', async () => {
    const coordinator = new LatestOperationCoordinator<string>();
    const firstStarted = createGate();
    const firstCleanup = createGate();
    const events: string[] = [];
    const first = coordinator.replace(async ({ signal }) => {
      events.push('first:start');
      firstStarted.resolve();
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => {
            events.push('first:abort');
            void firstCleanup.promise.then(() => reject(signal.reason));
          },
          { once: true }
        );
      });
      return 'first';
    });
    await firstStarted.promise;

    const secondAction = vi.fn(async () => {
      events.push('second:start');
      return 'second';
    });
    const second = coordinator.replace(secondAction);
    await vi.waitFor(() => expect(events).toEqual(['first:start', 'first:abort']));
    expect(secondAction).not.toHaveBeenCalled();

    firstCleanup.resolve();
    await expect(first).rejects.toThrow('operation replaced');
    await expect(second).resolves.toBe('second');
    expect(events).toEqual(['first:start', 'first:abort', 'second:start']);
  });

  it('keeps cancel-and-snapshot atomic against a rapid replacement', async () => {
    const coordinator = new LatestOperationCoordinator<string>();
    const runningStarted = createGate();
    const running = coordinator.replace(async ({ signal }) => {
      runningStarted.resolve();
      return new Promise<string>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    });
    await runningStarted.promise;

    const snapshotGate = createGate();
    const snapshot = coordinator.cancelThen(async () => {
      await snapshotGate.promise;
      return 'settled snapshot';
    });
    const replacementAction = vi.fn(async () => 'replacement');
    const replacement = coordinator.replace(replacementAction);
    await expect(running).rejects.toThrow('operation replaced');
    await Promise.resolve();
    expect(replacementAction).not.toHaveBeenCalled();

    snapshotGate.resolve();
    await expect(snapshot).resolves.toBe('settled snapshot');
    await expect(replacement).resolves.toBe('replacement');
  });
});
