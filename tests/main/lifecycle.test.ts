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

  it('keeps mihomo alive until proxy restoration has completed', async () => {
    let releaseRestore: (() => void) | undefined;
    const restoreGate = new Promise<void>((resolve) => {
      releaseRestore = resolve;
    });
    const restore = vi.fn(() => restoreGate);
    const stop = vi.fn(async () => undefined);
    const controller = createLifecycleController({
      proxy: {
        enable: vi.fn(async () => undefined),
        restore,
        repair: vi.fn(async () => undefined)
      },
      mihomo: { start: vi.fn(async () => undefined), stop }
    });
    await controller.start();

    const stopping = controller.stop();
    await vi.waitFor(() => expect(restore).toHaveBeenCalledOnce());
    expect(stop).not.toHaveBeenCalled();
    releaseRestore?.();
    await stopping;

    expect(stop).toHaveBeenCalledOnce();
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
    const stop = vi.fn(async () => undefined);
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
        stop
      },
      onStatusChange
    });

    await controller.start();
    await expect(controller.stop()).rejects.toThrow('proxy restore failed');
    expect(controller.getStatus()).toBe('failed');
    expect(onStatusChange).toHaveBeenLastCalledWith('failed');
    expect(stop).not.toHaveBeenCalled();
  });

  it('does not start a replacement runtime when restart cleanup fails', async () => {
    const start = vi.fn(async () => undefined);
    const stop = vi.fn(async () => undefined);
    const restore = vi.fn<() => Promise<void>>().mockRejectedValueOnce(new Error('proxy restore failed'));
    const controller = createLifecycleController({
      proxy: { enable: vi.fn(async () => undefined), restore, repair: vi.fn(async () => undefined) },
      mihomo: { start, stop }
    });

    await controller.start();
    await expect(controller.restart()).rejects.toThrow('proxy restore failed');
    expect(start).toHaveBeenCalledOnce();
    expect(stop).not.toHaveBeenCalled();
    expect(controller.getStatus()).toBe('failed');
  });

  it('blocks queued starts while lifecycle starts are suspended', async () => {
    const start = vi.fn(async () => undefined);
    const enable = vi.fn(async () => undefined);
    const controller = createLifecycleController({
      proxy: { enable, restore: vi.fn(async () => undefined), repair: vi.fn(async () => undefined) },
      mihomo: { start, stop: vi.fn(async () => undefined) }
    });

    controller.suspendStarts();
    await expect(controller.start()).rejects.toThrow('lifecycle starts are suspended');
    expect(start).not.toHaveBeenCalled();
    expect(enable).not.toHaveBeenCalled();

    controller.resumeStarts();
    await controller.start();
    expect(start).toHaveBeenCalledOnce();
    expect(enable).toHaveBeenCalledOnce();
  });

  it('rolls back a start when suspension happens before the proxy is enabled', async () => {
    let releaseStart: (() => void) | undefined;
    let markStartCalled: (() => void) | undefined;
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const startCalled = new Promise<void>((resolve) => {
      markStartCalled = resolve;
    });
    const restore = vi.fn(async () => undefined);
    const stop = vi.fn(async () => undefined);
    const enable = vi.fn(async () => undefined);
    const controller = createLifecycleController({
      proxy: { enable, restore, repair: vi.fn(async () => undefined) },
      mihomo: {
        start: vi.fn(() => {
          markStartCalled?.();
          return startGate;
        }),
        stop
      }
    });

    const starting = controller.start();
    await startCalled;
    controller.suspendStarts();
    releaseStart?.();

    await expect(starting).rejects.toThrow('lifecycle starts are suspended');
    expect(enable).not.toHaveBeenCalled();
    expect(restore).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
  });

  it('makes shutdown terminal and rejects later restart attempts', async () => {
    const start = vi.fn(async () => undefined);
    const restore = vi.fn(async () => undefined);
    const stop = vi.fn(async () => undefined);
    const controller = createLifecycleController({
      proxy: { enable: vi.fn(async () => undefined), restore, repair: vi.fn(async () => undefined) },
      mihomo: { start, stop }
    });

    await controller.start();
    await controller.shutdown();
    controller.resumeStarts();

    await expect(controller.restart()).rejects.toThrow('lifecycle is shutting down');
    expect(start).toHaveBeenCalledOnce();
    expect(restore).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
    expect(controller.getStatus()).toBe('stopped');
  });

  it('stops mihomo after disabling the proxy and before repairing the remaining network state', async () => {
    const calls: string[] = [];
    const controller = createLifecycleController({
      proxy: {
        enable: vi.fn(async () => undefined),
        restore: vi.fn(async () => undefined),
        repair: vi.fn(async () => {
          calls.push('proxy.repair');
        }),
        disableForRepair: vi.fn(async () => {
          calls.push('proxy.disableForRepair');
        }),
        repairSystemNetwork: vi.fn(async () => {
          calls.push('proxy.repairSystemNetwork');
        })
      },
      mihomo: {
        start: vi.fn(async () => undefined),
        stop: vi.fn(async () => {
          calls.push('mihomo.stop');
        })
      },
      onStatusChange(status) {
        calls.push(`status.${status}`);
      }
    });
    await controller.start();
    calls.length = 0;

    await controller.repair();

    expect(calls).toEqual(['proxy.disableForRepair', 'mihomo.stop', 'status.stopped', 'proxy.repairSystemNetwork']);
  });

  it('leaves mihomo running and marks repair failed when the proxy cannot be disabled', async () => {
    const calls: string[] = [];
    const stop = vi.fn(async () => {
      calls.push('mihomo.stop');
    });
    const repairSystemNetwork = vi.fn(async () => {
      calls.push('proxy.repairSystemNetwork');
    });
    const controller = createLifecycleController({
      proxy: {
        enable: vi.fn(async () => undefined),
        restore: vi.fn(async () => undefined),
        repair: vi.fn(async () => undefined),
        disableForRepair: vi.fn(async () => {
          calls.push('proxy.disableForRepair');
          throw new Error('proxy disable failed');
        }),
        repairSystemNetwork
      },
      mihomo: { start: vi.fn(async () => undefined), stop },
      onStatusChange(status) {
        calls.push(`status.${status}`);
      }
    });

    await expect(controller.repair()).rejects.toThrow('proxy disable failed');

    expect(calls).toEqual(['proxy.disableForRepair', 'status.failed']);
    expect(controller.getStatus()).toBe('failed');
    expect(stop).not.toHaveBeenCalled();
    expect(repairSystemNetwork).not.toHaveBeenCalled();
  });

  it('does not continue network repair or start a replacement when mihomo cannot stop', async () => {
    const calls: string[] = [];
    const start = vi.fn(async () => {
      calls.push('mihomo.start');
    });
    const repairSystemNetwork = vi.fn(async () => {
      calls.push('proxy.repairSystemNetwork');
    });
    const controller = createLifecycleController({
      proxy: {
        enable: vi.fn(async () => undefined),
        restore: vi.fn(async () => undefined),
        repair: vi.fn(async () => undefined),
        disableForRepair: vi.fn(async () => {
          calls.push('proxy.disableForRepair');
        }),
        repairSystemNetwork
      },
      mihomo: {
        start,
        stop: vi.fn(async () => {
          calls.push('mihomo.stop');
          throw new Error('mihomo stop failed');
        })
      },
      onStatusChange(status) {
        calls.push(`status.${status}`);
      }
    });

    await expect(controller.repair()).rejects.toThrow('mihomo stop failed');

    expect(calls).toEqual(['proxy.disableForRepair', 'mihomo.stop', 'status.failed']);
    expect(controller.getStatus()).toBe('failed');
    expect(start).not.toHaveBeenCalled();
    expect(repairSystemNetwork).not.toHaveBeenCalled();
  });

  it('keeps the stopped status when the remaining network repair fails', async () => {
    const calls: string[] = [];
    const controller = createLifecycleController({
      proxy: {
        enable: vi.fn(async () => undefined),
        restore: vi.fn(async () => undefined),
        repair: vi.fn(async () => undefined),
        disableForRepair: vi.fn(async () => {
          calls.push('proxy.disableForRepair');
        }),
        repairSystemNetwork: vi.fn(async () => {
          calls.push('proxy.repairSystemNetwork');
          throw new Error('network repair failed');
        })
      },
      mihomo: {
        start: vi.fn(async () => undefined),
        stop: vi.fn(async () => {
          calls.push('mihomo.stop');
        })
      },
      onStatusChange(status) {
        calls.push(`status.${status}`);
      }
    });
    await controller.start();
    calls.length = 0;

    await expect(controller.repair()).rejects.toThrow('network repair failed');

    expect(calls).toEqual(['proxy.disableForRepair', 'mihomo.stop', 'status.stopped', 'proxy.repairSystemNetwork']);
    expect(controller.getStatus()).toBe('stopped');
  });

  it('uses the legacy repair once when only one staged repair method is available', async () => {
    const repair = vi.fn(async () => undefined);
    const repairSystemNetwork = vi.fn(async () => undefined);
    const stop = vi.fn(async () => undefined);
    const controller = createLifecycleController({
      proxy: {
        enable: vi.fn(async () => undefined),
        restore: vi.fn(async () => undefined),
        repair,
        repairSystemNetwork
      },
      mihomo: { start: vi.fn(async () => undefined), stop }
    });

    await controller.repair();

    expect(repair).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
    expect(repairSystemNetwork).not.toHaveBeenCalled();
    expect(controller.getStatus()).toBe('stopped');
  });

  it('allows repair after shutdown cannot restore the proxy', async () => {
    const restore = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('proxy restore failed'))
      .mockResolvedValue(undefined);
    const repair = vi.fn(async () => undefined);
    const controller = createLifecycleController({
      proxy: { enable: vi.fn(async () => undefined), restore, repair },
      mihomo: { start: vi.fn(async () => undefined), stop: vi.fn(async () => undefined) }
    });
    await controller.start();

    await expect(controller.shutdown()).rejects.toThrow('proxy restore failed');
    await expect(controller.repair()).resolves.toBeUndefined();

    expect(repair).toHaveBeenCalledOnce();
    expect(controller.getStatus()).toBe('stopped');
  });
});
