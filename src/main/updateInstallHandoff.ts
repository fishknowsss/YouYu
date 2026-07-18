export const updateInstallerHandoffDelayMs = 2000;

export function deferUpdateInstallerLaunch(options: {
  launch: () => void;
  onError: (error: unknown) => void;
  defer?: (task: () => void) => void;
}): void {
  const defer = options.defer ?? ((task: () => void) => setTimeout(task, updateInstallerHandoffDelayMs));
  defer(() => {
    try {
      options.launch();
    } catch (error) {
      options.onError(error);
    }
  });
}
