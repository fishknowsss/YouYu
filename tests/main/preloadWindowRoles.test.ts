import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ipcChannels } from '../../src/shared/ipc';

const electron = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn(),
  invoke: vi.fn(),
  on: vi.fn(),
  off: vi.fn()
}));

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: electron.exposeInMainWorld },
  ipcRenderer: { invoke: electron.invoke, on: electron.on, off: electron.off }
}));

let createWindowApi: typeof import('../../src/preload/index').createWindowApi;
const originalArgv = process.argv;

describe('role-scoped preload APIs', () => {
  beforeAll(async () => {
    process.argv = [...originalArgv, '--youyu-window-role=main'];
    ({ createWindowApi } = await import('../../src/preload/index'));
  });

  afterAll(() => {
    process.argv = originalArgv;
  });

  beforeEach(() => {
    electron.invoke.mockReset();
    electron.on.mockReset();
    electron.off.mockReset();
  });

  it('exposes only notice data methods to the notice window', () => {
    const api = createWindowApi('notice') as Record<string, unknown>;

    expect(Object.keys(api).sort()).toEqual(['acknowledgeUserNotice', 'getSnapshot', 'onSnapshotUpdated']);
    expect(api).not.toHaveProperty('exportDiagnostics');
    expect(api).not.toHaveProperty('testConnectivity');
    expect(api).not.toHaveProperty('onPetStateUpdated');

    (api.getSnapshot as () => void)();
    expect(electron.invoke).toHaveBeenLastCalledWith(ipcChannels.getDesktopNoticeSnapshot);

    const listener = vi.fn();
    (api.onSnapshotUpdated as (callback: typeof listener) => void)(listener);
    expect(electron.on).toHaveBeenLastCalledWith(ipcChannels.desktopNoticeUpdated, expect.any(Function));

    (api.acknowledgeUserNotice as (revision: number) => void)(9);
    expect(electron.invoke).toHaveBeenLastCalledWith(ipcChannels.acknowledgeDesktopNotice, 9);
  });

  it('exposes no snapshot methods or channels to the pet window', () => {
    const api = createWindowApi('pet') as Record<string, unknown>;

    expect(Object.keys(api).sort()).toEqual(
      ['onPetStateUpdated', 'setPetMousePassthrough', 'showMainWindow', 'startPetDrag', 'stopPetDrag', 'wavePet'].sort()
    );
    expect(api).not.toHaveProperty('getSnapshot');
    expect(api).not.toHaveProperty('onSnapshotUpdated');
    expect(api).not.toHaveProperty('acknowledgeUserNotice');
  });
});
