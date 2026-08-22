import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAppWindowCoordinator } from '../../src/main/appWindowCoordinator';
import type { AppSnapshot } from '../../src/shared/ipc';

afterEach(() => {
  vi.useRealTimers();
});

function windowRef(options: { visible?: boolean; loading?: boolean; bounds?: Electron.Rectangle } = {}) {
  return {
    isDestroyed: vi.fn(() => false),
    isVisible: vi.fn(() => options.visible ?? false),
    isLoading: vi.fn(() => options.loading ?? false),
    getBounds: vi.fn(() => options.bounds ?? { x: 100, y: 100, width: 190, height: 212 }),
    setBounds: vi.fn(),
    showInactive: vi.fn(),
    hide: vi.fn(),
    webContents: {
      send: vi.fn(),
      isLoading: vi.fn(() => options.loading ?? false)
    }
  };
}

function snapshot(expiresAt = '2026-08-22T02:00:00.000Z') {
  return {
    userNotice: {
      revision: 7,
      message: '计划维护',
      tone: 'warning',
      expiresAt,
      updatedAt: '2026-08-22T01:00:00.000Z'
    },
    subscriptionUrl: 'https://private.example/subscription'
  } as AppSnapshot;
}

describe('createAppWindowCoordinator', () => {
  it('keeps full snapshots in the main window and sends only the notice DTO to the notice window', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-22T01:30:00.000Z'));
    const main = windowRef();
    const notice = windowRef();
    const pet = windowRef({ visible: true });
    const coordinator = createAppWindowCoordinator({
      getMainWindow: () => main,
      getNoticeWindow: () => notice,
      getPetWindow: () => pet,
      createNoticeWindow: vi.fn(async () => notice),
      isPetFeatureEnabled: () => true,
      isPetFullscreenSuppressed: () => false,
      isCleanupStarted: () => false,
      isQuitting: () => false,
      screen: {
        getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }),
        getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1040 } })
      },
      noticeWindowSize: { width: 336, height: 188 },
      onNoticeExpired: vi.fn(async () => undefined),
      onError: vi.fn()
    });
    const next = snapshot();

    coordinator.send(next);

    expect(main.webContents.send).toHaveBeenCalledWith('youyu:snapshot-updated', next);
    expect(notice.webContents.send).toHaveBeenCalledWith('youyu:desktop-notice-updated', {
      userNotice: next.userNotice
    });
    expect(notice.webContents.send.mock.calls[0]?.[1]).not.toHaveProperty('subscriptionUrl');
    expect(pet.webContents.send).not.toHaveBeenCalled();
  });

  it('coalesces layout work, positions active notices, and disposes pending timers without changing visibility rules', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-22T01:30:00.000Z'));
    const notice = windowRef();
    const pet = windowRef({ visible: true, bounds: { x: 1600, y: 700, width: 190, height: 212 } });
    const createNoticeWindow = vi.fn(async () => notice);
    const onNoticeExpired = vi.fn(async () => undefined);
    const coordinator = createAppWindowCoordinator({
      getMainWindow: () => undefined,
      getNoticeWindow: () => notice,
      getPetWindow: () => pet,
      createNoticeWindow,
      isPetFeatureEnabled: () => true,
      isPetFullscreenSuppressed: () => false,
      isCleanupStarted: () => false,
      isQuitting: () => false,
      screen: {
        getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }),
        getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1040 } })
      },
      noticeWindowSize: { width: 336, height: 188 },
      onNoticeExpired,
      onError: vi.fn()
    });

    coordinator.schedule(snapshot());
    coordinator.schedule();
    await vi.advanceTimersByTimeAsync(0);

    expect(createNoticeWindow).toHaveBeenCalledOnce();
    expect(notice.setBounds).toHaveBeenCalledOnce();
    expect(notice.showInactive).toHaveBeenCalledOnce();

    coordinator.dispose();
    await vi.advanceTimersByTimeAsync(31 * 60 * 1000);

    expect(notice.hide).toHaveBeenCalledOnce();
    expect(onNoticeExpired).not.toHaveBeenCalled();
  });
});
