import { describe, expect, it, vi } from 'vitest';
import { createUpdateActions } from '../../src/renderer/appUpdateActions';

type Snapshot = { status: string };
type Api = {
  checkForUpdates: () => Promise<Snapshot>;
  installUpdate: () => Promise<Snapshot>;
};

describe('createUpdateActions', () => {
  it('keeps check and both install entry points on the same operation runner contract', async () => {
    const run = vi.fn(
      async (_action: (api: Api) => Promise<Snapshot>, _doneMessage: string, _options: unknown) => true
    );
    const settingsMessages: string[] = [];
    const actions = createUpdateActions<Api, Snapshot>({
      run,
      setSettingsMessage: (message) => settingsMessages.push(message)
    });
    const api: Api = {
      checkForUpdates: vi.fn(async () => ({ status: 'checked' })),
      installUpdate: vi.fn(async () => ({ status: 'installing' }))
    };

    actions.checkForUpdates();
    actions.installUpdate();
    actions.installSettingsUpdate();

    expect(run).toHaveBeenCalledTimes(3);
    expect(run.mock.calls[0]?.slice(1)).toEqual([
      '',
      { workingMessage: '检查中', timeoutLabel: '检查更新', messageSink: actions.setSettingsMessage }
    ]);
    expect(run.mock.calls[1]?.slice(1)).toEqual([
      '',
      { workingMessage: '确认新版中', timeoutLabel: '安装更新', messageSink: undefined }
    ]);
    expect(run.mock.calls[2]?.slice(1)).toEqual([
      '',
      { workingMessage: '确认新版中', timeoutLabel: '安装更新', messageSink: actions.setSettingsMessage }
    ]);

    await run.mock.calls[0]?.[0](api);
    await run.mock.calls[1]?.[0](api);
    expect(api.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(api.installUpdate).toHaveBeenCalledTimes(1);
    expect(settingsMessages).toEqual([]);
  });
});
