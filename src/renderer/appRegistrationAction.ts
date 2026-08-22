export type RegistrationRunOptions = {
  workingMessage: string;
  timeoutLabel: string;
};

type RegistrationActionInvocation<Input> = {
  switchingUser: boolean;
  isMounted: () => boolean;
  run: (input: Input, options: RegistrationRunOptions) => Promise<boolean>;
  closeSwitch: () => void;
};

export function createRegistrationAction<Input>() {
  let inFlight = false;

  return async (input: Input, invocation: RegistrationActionInvocation<Input>): Promise<void> => {
    if (inFlight) return;
    inFlight = true;
    try {
      const success = await invocation.run(input, {
        workingMessage: invocation.switchingUser ? '切换中' : '登记中',
        timeoutLabel: invocation.switchingUser ? '切换用户' : '登记'
      });
      if (success && invocation.switchingUser && invocation.isMounted()) invocation.closeSwitch();
    } finally {
      inFlight = false;
    }
  };
}
