import type { Rectangle } from 'electron';
import { ipcChannels, toDesktopNoticeSnapshot, type AppSnapshot } from '../shared/ipc';
import { resolvePetNoticePlacement } from './noticePlacement';

type AppWindowRef = {
  isDestroyed: () => boolean;
  isVisible: () => boolean;
  getBounds: () => Rectangle;
  setBounds: (bounds: Rectangle, animate?: boolean) => void;
  showInactive: () => void;
  hide: () => void;
  webContents: {
    send: (channel: string, payload: unknown) => void;
    isLoading: () => boolean;
  };
};

type AppWindowCoordinatorDependencies = {
  getMainWindow: () => AppWindowRef | null | undefined;
  getNoticeWindow: () => AppWindowRef | null | undefined;
  getPetWindow: () => AppWindowRef | null | undefined;
  createNoticeWindow: () => Promise<AppWindowRef | undefined>;
  isPetFeatureEnabled: () => boolean;
  isPetFullscreenSuppressed: () => boolean;
  isCleanupStarted: () => boolean;
  isQuitting: () => boolean;
  screen: {
    getDisplayMatching: (bounds: Rectangle) => { workArea: Rectangle };
    getPrimaryDisplay: () => { workArea: Rectangle };
  };
  noticeWindowSize: Pick<Rectangle, 'width' | 'height'>;
  onNoticeExpired: () => Promise<void>;
  onError: (context: 'synchronization' | 'expiry', error: unknown) => void;
};

export function createAppWindowCoordinator(dependencies: AppWindowCoordinatorDependencies) {
  let latestNoticeSnapshot: AppSnapshot | undefined;
  let layoutTimer: ReturnType<typeof setTimeout> | undefined;
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  let scheduledExpiryAt: string | undefined;

  function send(snapshot: AppSnapshot): void {
    const mainWindow = dependencies.getMainWindow();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(ipcChannels.snapshotUpdated, snapshot);
    }
    const noticeWindow = dependencies.getNoticeWindow();
    if (noticeWindow && !noticeWindow.isDestroyed()) {
      noticeWindow.webContents.send(ipcChannels.desktopNoticeUpdated, toDesktopNoticeSnapshot(snapshot));
    }
    schedule(snapshot);
  }

  function schedule(snapshot?: AppSnapshot): void {
    if (snapshot) latestNoticeSnapshot = snapshot;
    if (layoutTimer) return;
    layoutTimer = setTimeout(() => {
      layoutTimer = undefined;
      void sync().catch((error) => dependencies.onError('synchronization', error));
    }, 0);
    layoutTimer.unref?.();
  }

  function clearExpiryTimer(): void {
    if (expiryTimer) {
      clearTimeout(expiryTimer);
      expiryTimer = undefined;
    }
    scheduledExpiryAt = undefined;
  }

  function scheduleExpiry(notice: AppSnapshot['userNotice']): void {
    if (!notice) {
      clearExpiryTimer();
      return;
    }
    if (scheduledExpiryAt === notice.expiresAt) return;
    clearExpiryTimer();
    const expiresAt = Date.parse(notice.expiresAt);
    const delay = expiresAt - Date.now();
    if (!Number.isFinite(delay)) return;
    scheduledExpiryAt = notice.expiresAt;
    expiryTimer = setTimeout(
      () => {
        expiryTimer = undefined;
        scheduledExpiryAt = undefined;
        void dependencies.onNoticeExpired().catch((error) => dependencies.onError('expiry', error));
      },
      Math.max(0, delay)
    );
    expiryTimer.unref?.();
  }

  function hasActiveUserNotice(snapshot: AppSnapshot | undefined): boolean {
    const expiresAt = snapshot?.userNotice ? Date.parse(snapshot.userNotice.expiresAt) : Number.NaN;
    return Number.isFinite(expiresAt) && expiresAt > Date.now();
  }

  function getNoticeWindowBounds(): Rectangle | undefined {
    if (dependencies.isPetFeatureEnabled() && dependencies.isPetFullscreenSuppressed()) return undefined;

    const petWindow = dependencies.getPetWindow();
    if (dependencies.isPetFeatureEnabled() && petWindow && !petWindow.isDestroyed() && petWindow.isVisible()) {
      const petBounds = petWindow.getBounds();
      const workArea = dependencies.screen.getDisplayMatching(petBounds).workArea;
      return resolvePetNoticePlacement(petBounds, workArea, dependencies.noticeWindowSize);
    }

    const workArea = dependencies.screen.getPrimaryDisplay().workArea;
    return {
      ...dependencies.noticeWindowSize,
      x: workArea.x + workArea.width - dependencies.noticeWindowSize.width - 16,
      y: workArea.y + workArea.height - dependencies.noticeWindowSize.height - 16
    };
  }

  function hide(): void {
    const noticeWindow = dependencies.getNoticeWindow();
    if (!noticeWindow || noticeWindow.isDestroyed()) return;
    noticeWindow.hide();
  }

  async function sync(): Promise<void> {
    const snapshot = latestNoticeSnapshot;
    scheduleExpiry(snapshot?.userNotice);
    if (!hasActiveUserNotice(snapshot) || dependencies.isCleanupStarted() || dependencies.isQuitting()) {
      hide();
      return;
    }

    const bounds = getNoticeWindowBounds();
    if (!bounds) {
      hide();
      return;
    }

    const noticeWindow = await dependencies.createNoticeWindow();
    if (!noticeWindow || noticeWindow.isDestroyed()) return;
    noticeWindow.setBounds(bounds, false);
    if (!noticeWindow.webContents.isLoading() && !noticeWindow.isVisible()) {
      noticeWindow.showInactive();
    }
  }

  function dispose(): void {
    if (layoutTimer) {
      clearTimeout(layoutTimer);
      layoutTimer = undefined;
    }
    clearExpiryTimer();
    hide();
  }

  return {
    send,
    schedule,
    sync,
    hide,
    dispose
  };
}
