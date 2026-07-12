import { describe, expect, it, vi } from 'vitest';
import { deferUpdateInstallerLaunch } from '../../src/main/updateInstallHandoff';

describe('deferUpdateInstallerLaunch', () => {
  it('waits for the caller to finish its IPC response before starting the installer', () => {
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
