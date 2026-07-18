import { afterEach, describe, expect, it, vi } from 'vitest';
import { deferUpdateInstallerLaunch, updateInstallerHandoffDelayMs } from '../../src/main/updateInstallHandoff';

afterEach(() => vi.useRealTimers());

describe('deferUpdateInstallerLaunch', () => {
  it('keeps the installing message visible before starting the installer', async () => {
    vi.useFakeTimers();
    const launch = vi.fn();

    deferUpdateInstallerLaunch({ launch, onError: vi.fn() });

    await vi.advanceTimersByTimeAsync(updateInstallerHandoffDelayMs - 1);
    expect(launch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(launch).toHaveBeenCalledOnce();
  });

  it('supports an injected scheduler for deterministic handoff tests', () => {
    const scheduled: Array<() => void> = [];
    const launch = vi.fn();

    deferUpdateInstallerLaunch({ launch, onError: vi.fn(), defer: (task) => scheduled.push(task) });

    expect(launch).not.toHaveBeenCalled();
    expect(scheduled).toHaveLength(1);
    scheduled[0]();
    expect(launch).toHaveBeenCalledOnce();
  });

  it('keeps the app recoverable when starting the installer throws', () => {
    const onError = vi.fn();

    deferUpdateInstallerLaunch({
      launch: () => {
        throw new Error('spawn failed');
      },
      onError,
      defer: (task) => task()
    });

    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'spawn failed' }));
  });
});
