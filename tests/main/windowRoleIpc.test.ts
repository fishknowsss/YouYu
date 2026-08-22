import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  canWindowRoleInvokeIpc,
  ipcChannels,
  toDesktopNoticeSnapshot,
  type AppSnapshot,
  type UserNotice
} from '../../src/shared/ipc';

describe('window-role IPC data boundaries', () => {
  it('projects a desktop notice DTO without main-window private fields', () => {
    const userNotice: UserNotice = {
      revision: 7,
      message: '计划维护',
      tone: 'warning',
      expiresAt: '2026-08-22T00:00:00.000Z',
      updatedAt: '2026-08-21T23:00:00.000Z'
    };
    const snapshot = {
      userNotice,
      subscriptionUrl: 'https://private.example/subscription',
      remoteSubscriptionUrl: 'https://managed.example/subscription',
      trafficIdentity: { userId: 'private-user', deviceId: 'private-device' },
      diagnostics: { lastError: 'private error', logs: ['private log'] },
      runtime: { activeConnections: 1, connections: [{ metadata: { host: 'private.example' } }] }
    } as unknown as AppSnapshot;

    const noticeSnapshot = toDesktopNoticeSnapshot(snapshot);

    expect(noticeSnapshot).toEqual({ userNotice });
    expect(noticeSnapshot).not.toHaveProperty('subscriptionUrl');
    expect(noticeSnapshot).not.toHaveProperty('remoteSubscriptionUrl');
    expect(noticeSnapshot).not.toHaveProperty('trafficIdentity');
    expect(noticeSnapshot).not.toHaveProperty('diagnostics');
    expect(noticeSnapshot).not.toHaveProperty('runtime');
  });

  it('denies full-snapshot IPC to auxiliary windows', () => {
    expect(canWindowRoleInvokeIpc('main', ipcChannels.getSnapshot)).toBe(true);

    expect(canWindowRoleInvokeIpc('notice', ipcChannels.getSnapshot)).toBe(false);
    expect(canWindowRoleInvokeIpc('notice', ipcChannels.getDesktopNoticeSnapshot)).toBe(true);
    expect(canWindowRoleInvokeIpc('notice', ipcChannels.acknowledgeDesktopNotice)).toBe(true);
    expect(canWindowRoleInvokeIpc('notice', ipcChannels.exportDiagnostics)).toBe(false);

    expect(canWindowRoleInvokeIpc('pet', ipcChannels.getSnapshot)).toBe(false);
    expect(canWindowRoleInvokeIpc('pet', ipcChannels.getDesktopNoticeSnapshot)).toBe(false);
    expect(canWindowRoleInvokeIpc('pet', ipcChannels.wavePet)).toBe(true);
    expect(canWindowRoleInvokeIpc('pet', ipcChannels.showMainWindow)).toBe(true);
  });

  it('sends full snapshots only to the main window and narrow updates only to notices', async () => {
    const [indexSource, coordinatorSource] = await Promise.all([
      readFile('src/main/index.ts', 'utf8'),
      readFile('src/main/appWindowCoordinator.ts', 'utf8')
    ]);

    expect(indexSource).toContain('appWindowCoordinator.send(snapshot)');
    expect(coordinatorSource).toContain('mainWindow.webContents.send(ipcChannels.snapshotUpdated, snapshot)');
    expect(coordinatorSource).toContain(
      'noticeWindow.webContents.send(ipcChannels.desktopNoticeUpdated, toDesktopNoticeSnapshot(snapshot))'
    );
    expect(coordinatorSource).not.toContain('BrowserWindow.getAllWindows()');
    expect(coordinatorSource).not.toContain('petWindow.webContents.send');
  });

  it('binds BrowserWindows and invoke handlers to their declared roles', async () => {
    const [indexSource, trustedIpcSource] = await Promise.all([
      readFile('src/main/index.ts', 'utf8'),
      readFile('src/main/trustedIpcMain.ts', 'utf8')
    ]);

    expect(indexSource).toContain('createTrustedIpcMain');
    expect(trustedIpcSource).toContain('canWindowRoleInvokeIpc(role, channel)');
    expect(indexSource).not.toContain('const petIpcChannels');
    expect(indexSource).not.toContain('const noticeIpcChannels');
    expect(indexSource.match(/additionalArguments: \['--youyu-window-role=main'\]/g)).toHaveLength(1);
    expect(indexSource.match(/additionalArguments: \['--youyu-window-role=notice'\]/g)).toHaveLength(1);
    expect(indexSource.match(/additionalArguments: \['--youyu-window-role=pet'\]/g)).toHaveLength(1);
    expect(indexSource).toContain('ipcMain.handle(ipcChannels.getDesktopNoticeSnapshot');
    expect(indexSource).toContain('ipcMain.handle(ipcChannels.acknowledgeDesktopNotice');
  });
});
