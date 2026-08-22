import { describe, expect, it, vi } from 'vitest';
import { createRegistrationAction } from '../../src/renderer/appRegistrationAction';

type Input = { name: string };

function createInvocation(switchingUser: boolean, run = vi.fn(async () => true)) {
  return {
    switchingUser,
    isMounted: () => true,
    run,
    closeSwitch: vi.fn()
  };
}

describe('createRegistrationAction', () => {
  it('uses registration copy without closing the switch for a first registration', async () => {
    const register = createRegistrationAction<Input>();
    const invocation = createInvocation(false);

    await register({ name: 'alice' }, invocation);

    expect(invocation.run).toHaveBeenCalledWith({ name: 'alice' }, { workingMessage: '登记中', timeoutLabel: '登记' });
    expect(invocation.closeSwitch).not.toHaveBeenCalled();
  });

  it('closes an open user switch only after a successful switch while mounted', async () => {
    const register = createRegistrationAction<Input>();
    const invocation = createInvocation(true);

    await register({ name: 'bob' }, invocation);

    expect(invocation.run).toHaveBeenCalledWith(
      { name: 'bob' },
      { workingMessage: '切换中', timeoutLabel: '切换用户' }
    );
    expect(invocation.closeSwitch).toHaveBeenCalledTimes(1);
  });

  it('suppresses concurrent submissions until the active registration settles', async () => {
    let settle!: (value: boolean) => void;
    const run = vi.fn(() => new Promise<boolean>((resolve) => (settle = resolve)));
    const invocation = createInvocation(false, run);
    const register = createRegistrationAction<Input>();

    const first = register({ name: 'first' }, invocation);
    await register({ name: 'second' }, invocation);
    expect(run).toHaveBeenCalledTimes(1);
    settle(true);
    await first;
    const third = register({ name: 'third' }, invocation);
    expect(run).toHaveBeenCalledTimes(2);
    settle(true);
    await third;
  });
});
