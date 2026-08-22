type PageActionDependencies<Page, UsageMode> = {
  homePage: Page;
  nodesPage: Page;
  easyMode: UsageMode;
  advancedMode: UsageMode;
  setPage: (page: Page) => void;
  setUsageMode: (mode: UsageMode) => void;
  setMessage: (message: string) => void;
  setRegistrationSwitchOpen: (open: boolean) => void;
};

export function createPageActions<Page, UsageMode>(dependencies: PageActionDependencies<Page, UsageMode>) {
  let advancedUnlockClicks = 0;

  function changeUsageMode(next: UsageMode): void {
    advancedUnlockClicks = 0;
    dependencies.setUsageMode(next);
    if (next === dependencies.easyMode) dependencies.setPage(dependencies.homePage);
  }

  return {
    changeUsageMode,
    handleAdvancedUnlockClick() {
      advancedUnlockClicks += 1;
      if (advancedUnlockClicks >= 7) changeUsageMode(dependencies.advancedMode);
    },
    openNodes: () => dependencies.setPage(dependencies.nodesPage),
    openRegistrationSwitch(beforeOpen?: () => void) {
      dependencies.setMessage('');
      beforeOpen?.();
      dependencies.setRegistrationSwitchOpen(true);
    },
    closeRegistrationSwitch: () => dependencies.setRegistrationSwitchOpen(false)
  };
}
