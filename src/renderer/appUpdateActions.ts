type UpdateApi<Snapshot> = {
  checkForUpdates: () => Promise<Snapshot>;
  installUpdate: () => Promise<Snapshot>;
};

type UpdateActionOptions = {
  workingMessage: string;
  timeoutLabel: string;
  messageSink?: (value: string) => void;
};

type UpdateActionsDependencies<Api, Snapshot> = {
  run: (action: (api: Api) => Promise<Snapshot>, doneMessage: string, options: UpdateActionOptions) => Promise<boolean>;
  setSettingsMessage: (value: string) => void;
};

export function createUpdateActions<Api extends UpdateApi<Snapshot>, Snapshot>(
  dependencies: UpdateActionsDependencies<Api, Snapshot>
) {
  const handleInstallUpdate = (messageSink?: (value: string) => void) =>
    void dependencies.run((api) => api.installUpdate(), '', {
      workingMessage: '确认新版中',
      timeoutLabel: '安装更新',
      messageSink
    });

  return {
    setSettingsMessage: dependencies.setSettingsMessage,
    checkForUpdates: () =>
      void dependencies.run((api) => api.checkForUpdates(), '', {
        workingMessage: '检查中',
        timeoutLabel: '检查更新',
        messageSink: dependencies.setSettingsMessage
      }),
    installUpdate: () => handleInstallUpdate(),
    installSettingsUpdate: () => handleInstallUpdate(dependencies.setSettingsMessage)
  };
}
