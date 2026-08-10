import { describe, expect, it, vi } from 'vitest';
import { createUpdateDownloadHealthMonitor, evaluateUpdateDownloadHealth } from '../../src/main/updateDownloadHealth';

describe('update download health', () => {
  it('switches a sustained unusably slow direct CDN route only when a local proxy is available', () => {
    const sample = {
      route: 'direct' as const,
      proxyAvailable: true,
      elapsedMs: 20_000,
      idleMs: 0,
      observedBytes: 40 * 1024 * 20,
      transferredBytes: 1024 * 1024,
      totalBytes: 100 * 1024 * 1024
    };

    expect(evaluateUpdateDownloadHealth(sample)).toBe('slow-direct-route');
    expect(evaluateUpdateDownloadHealth({ ...sample, proxyAvailable: false })).toBeUndefined();
    expect(evaluateUpdateDownloadHealth({ ...sample, route: 'local-proxy' })).toBeUndefined();
  });

  it('keeps a usable route and a completed download', () => {
    const sample = {
      route: 'direct' as const,
      proxyAvailable: true,
      elapsedMs: 20_000,
      idleMs: 0,
      observedBytes: 8 * 1024 * 1024,
      transferredBytes: 8 * 1024 * 1024,
      totalBytes: 100 * 1024 * 1024
    };

    expect(evaluateUpdateDownloadHealth(sample)).toBeUndefined();
    expect(
      evaluateUpdateDownloadHealth({
        ...sample,
        idleMs: 60_000,
        transferredBytes: sample.totalBytes
      })
    ).toBeUndefined();
  });

  it('cancels a stalled direct attempt and removes its listener on disposal', () => {
    let progressListener: ((value: unknown) => void) | undefined;
    let poll: (() => void) | undefined;
    let currentTime = 0;
    const cancel = vi.fn();
    const onUnhealthy = vi.fn();
    const removeListener = vi.fn();
    const monitor = createUpdateDownloadHealthMonitor({
      source: {
        on: (_event, listener) => {
          progressListener = listener;
        },
        removeListener
      },
      route: 'direct',
      getProxyUrl: () => 'http://127.0.0.1:17890',
      cancel,
      onUnhealthy,
      now: () => currentTime,
      setInterval: (callback) => {
        poll = callback;
        return { unref: vi.fn() } as unknown as ReturnType<typeof setInterval>;
      },
      clearInterval: vi.fn()
    });

    progressListener?.({ transferred: 0, total: 100 * 1024 * 1024 });
    currentTime = 45_000;
    poll?.();

    expect(cancel).toHaveBeenCalledOnce();
    expect(onUnhealthy).toHaveBeenCalledWith('stalled-direct-route');
    expect(monitor.getReason()).toBe('stalled-direct-route');

    monitor.dispose();
    expect(removeListener).toHaveBeenCalledWith('download-progress', progressListener);
  });
});
