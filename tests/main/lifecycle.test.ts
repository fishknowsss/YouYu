import { describe, expect, it, vi } from 'vitest';
import { createLifecycleController } from '../../src/main/lifecycle';

describe('createLifecycleController', () => {
  it('rolls back system proxy when mihomo fails to start', async () => {
    const calls: string[] = [];
    const controller = createLifecycleController({
      proxy: {
        enable: vi.fn(async () => {
          calls.push('proxy.enable');
        }),
        restore: vi.fn(async () => {
          calls.push('proxy.restore');
        }),
        repair: vi.fn(async () => {
          calls.push('proxy.repair');
        })
      },
      mihomo: {
        start: vi.fn(async () => {
          calls.push('mihomo.start');
          throw new Error('boot failed');
        }),
        stop: vi.fn(async () => {
          calls.push('mihomo.stop');
        })
      }
    });

    await expect(controller.start()).rejects.toThrow('boot failed');
    expect(calls).toEqual(['proxy.enable', 'mihomo.start', 'proxy.restore', 'mihomo.stop']);
  });

  it('restores system proxy before stopping mihomo', async () => {
    const calls: string[] = [];
    const controller = createLifecycleController({
      proxy: {
        enable: vi.fn(async () => {
          calls.push('proxy.enable');
        }),
        restore: vi.fn(async () => {
          calls.push('proxy.restore');
        }),
        repair: vi.fn(async () => {
          calls.push('proxy.repair');
        })
      },
      mihomo: {
        start: vi.fn(async () => {
          calls.push('mihomo.start');
        }),
        stop: vi.fn(async () => {
          calls.push('mihomo.stop');
        })
      }
    });

    await controller.start();
    await controller.stop();
    expect(calls).toEqual(['proxy.enable', 'mihomo.start', 'proxy.restore', 'mihomo.stop']);
  });

  it('restarts mihomo without disabling the proxy when already running', async () => {
    const calls: string[] = [];
    const controller = createLifecycleController({
      proxy: {
        enable: vi.fn(async () => {
          calls.push('proxy.enable');
        }),
        restore: vi.fn(async () => {
          calls.push('proxy.restore');
        }),
        repair: vi.fn(async () => {
          calls.push('proxy.repair');
        })
      },
      mihomo: {
        start: vi.fn(async () => {
          calls.push('mihomo.start');
        }),
        stop: vi.fn(async () => {
          calls.push('mihomo.stop');
        })
      }
    });

    await controller.start();
    await controller.restart();

    expect(calls).toEqual(['proxy.enable', 'mihomo.start', 'mihomo.stop', 'mihomo.start']);
  });

  it('does not enable the proxy again when start is called while running', async () => {
    const calls: string[] = [];
    const controller = createLifecycleController({
      proxy: {
        enable: vi.fn(async () => {
          calls.push('proxy.enable');
        }),
        restore: vi.fn(async () => {
          calls.push('proxy.restore');
        }),
        repair: vi.fn(async () => {
          calls.push('proxy.repair');
        })
      },
      mihomo: {
        start: vi.fn(async () => {
          calls.push('mihomo.start');
        }),
        stop: vi.fn(async () => {
          calls.push('mihomo.stop');
        })
      }
    });

    await controller.start();
    await controller.start();
    await controller.stop();

    expect(calls).toEqual(['proxy.enable', 'mihomo.start', 'proxy.restore', 'mihomo.stop']);
  });
});
