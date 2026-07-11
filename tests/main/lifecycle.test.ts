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
    expect(calls).toEqual(['mihomo.start', 'proxy.restore', 'mihomo.stop']);
  });

  it('starts mihomo before enabling the system proxy', async () => {
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
    expect(calls).toEqual(['mihomo.start', 'proxy.enable']);
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
    expect(calls).toEqual(['mihomo.start', 'proxy.enable', 'proxy.restore', 'mihomo.stop']);
  });

  it('temporarily disables the proxy while restarting mihomo', async () => {
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

    expect(calls).toEqual([
      'mihomo.start',
      'proxy.enable',
      'proxy.restore',
      'mihomo.stop',
      'mihomo.start',
      'proxy.enable'
    ]);
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

    expect(calls).toEqual(['mihomo.start', 'proxy.enable', 'proxy.restore', 'mihomo.stop']);
  });

  it('marks the lifecycle failed when the mihomo process is no longer alive', async () => {
    let alive = true;
    const onStatusChange = vi.fn();
    const controller = createLifecycleController({
      proxy: {
        enable: vi.fn(async () => undefined),
        restore: vi.fn(async () => undefined),
        repair: vi.fn(async () => undefined)
      },
      mihomo: {
        start: vi.fn(async () => {
          alive = true;
        }),
        stop: vi.fn(async () => {
          alive = false;
        }),
        isRunning: () => alive
      },
      onStatusChange
    });

    await controller.start();
    alive = false;

    expect(controller.getStatus()).toBe('failed');
    expect(onStatusChange).toHaveBeenLastCalledWith('failed');
  });

  it('does not report stopped when cleanup fails', async () => {
    const onStatusChange = vi.fn();
    const controller = createLifecycleController({
      proxy: {
        enable: vi.fn(async () => undefined),
        restore: vi.fn(async () => {
          throw new Error('proxy restore failed');
        }),
        repair: vi.fn(async () => undefined)
      },
      mihomo: {
        start: vi.fn(async () => undefined),
        stop: vi.fn(async () => undefined)
      },
      onStatusChange
    });

    await controller.start();
    await expect(controller.stop()).rejects.toThrow('proxy restore failed');
    expect(controller.getStatus()).toBe('failed');
    expect(onStatusChange).toHaveBeenLastCalledWith('failed');
  });

  it('does not start a replacement runtime when restart cleanup fails', async () => {
    const start = vi.fn(async () => undefined);
    const restore = vi.fn<() => Promise<void>>().mockRejectedValueOnce(new Error('proxy restore failed'));
    const controller = createLifecycleController({
      proxy: { enable: vi.fn(async () => undefined), restore, repair: vi.fn(async () => undefined) },
      mihomo: { start, stop: vi.fn(async () => undefined) }
    });

    await controller.start();
    await expect(controller.restart()).rejects.toThrow('proxy restore failed');
    expect(start).toHaveBeenCalledOnce();
    expect(controller.getStatus()).toBe('failed');
  });
});
