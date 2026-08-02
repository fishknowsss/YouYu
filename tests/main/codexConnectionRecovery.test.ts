import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCodexConnectionRecoveryCoordinator } from '../../src/main/codexConnectionRecovery';
import type { RuntimeConnectionStats } from '../../src/shared/ipc';

const startedAt = new Date(0).toISOString();

afterEach(() => {
  vi.useRealTimers();
});

function codexConnection(overrides: Partial<RuntimeConnectionStats> = {}): RuntimeConnectionStats {
  return {
    id: 'codex-connection',
    start: startedAt,
    upload: 167,
    download: 0,
    metadata: {
      process: 'codex.exe',
      network: 'tcp',
      host: 'chatgpt.com'
    },
    ...overrides
  };
}

function createApi() {
  return {
    closeConnection: vi.fn(async () => undefined),
    flushDnsCache: vi.fn(async () => undefined)
  };
}

describe('createCodexConnectionRecoveryCoordinator', () => {
  it('closes only a repeatedly unresponsive Codex TCP connection after eight seconds and refreshes DNS', async () => {
    const api = createApi();
    let clock = 8_000;
    const coordinator = createCodexConnectionRecoveryCoordinator({ createMihomoApi: () => api, now: () => clock });
    const connection = codexConnection();

    await coordinator.observe([connection]);
    expect(api.closeConnection).not.toHaveBeenCalled();

    clock = 9_000;
    await coordinator.observe([connection]);

    expect(api.closeConnection).toHaveBeenCalledTimes(1);
    expect(api.closeConnection).toHaveBeenCalledWith('codex-connection');
    expect(api.flushDnsCache).toHaveBeenCalledTimes(1);
    expect(api.closeConnection.mock.invocationCallOrder[0]).toBeLessThan(api.flushDnsCache.mock.invocationCallOrder[0]);
  });

  it('does not close responsive, non-Codex, non-OpenAI, UDP, or substantial request connections', async () => {
    const api = createApi();
    let clock = 8_000;
    const coordinator = createCodexConnectionRecoveryCoordinator({ createMihomoApi: () => api, now: () => clock });
    const connections = [
      codexConnection({ id: 'responsive', download: 1 }),
      codexConnection({ id: 'large-request', upload: 8 * 1024 + 1 }),
      codexConnection({ id: 'missing-byte-counts', upload: undefined, download: undefined }),
      codexConnection({ id: 'invalid-upload', upload: Number.NaN }),
      codexConnection({ id: 'invalid-download', download: -1 }),
      codexConnection({
        id: 'other-process',
        metadata: { process: 'ChatGPT.exe', network: 'tcp', host: 'chatgpt.com' }
      }),
      codexConnection({ id: 'other-host', metadata: { process: 'codex.exe', network: 'tcp', host: 'example.com' } }),
      codexConnection({ id: 'udp', metadata: { process: 'codex.exe', network: 'udp', host: 'chatgpt.com' } })
    ];

    await coordinator.observe(connections);
    clock = 9_000;
    await coordinator.observe(connections);

    expect(api.closeConnection).not.toHaveBeenCalled();
    expect(api.flushDnsCache).not.toHaveBeenCalled();
  });

  it('performs one extra recheck at the actual Mihomo start plus eight seconds', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const api = createApi();
    const connection = codexConnection({ start: new Date(0).toISOString() });
    const readConnections = vi.fn(async () => [connection]);
    const coordinator = createCodexConnectionRecoveryCoordinator({ createMihomoApi: () => api, readConnections });

    await coordinator.observe([connection]);
    await vi.advanceTimersByTimeAsync(6_999);
    expect(readConnections).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(readConnections).toHaveBeenCalledTimes(1);
    expect(api.closeConnection).toHaveBeenCalledWith('codex-connection');
    expect(api.flushDnsCache).toHaveBeenCalledTimes(1);
  });

  it('does not add rechecks without a strict candidate and only schedules the first candidate', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const api = createApi();
    const first = codexConnection({ id: 'first' });
    const second = codexConnection({ id: 'second' });
    const readConnections = vi.fn(async () => []);
    const coordinator = createCodexConnectionRecoveryCoordinator({ createMihomoApi: () => api, readConnections });

    await coordinator.observe([
      codexConnection({ metadata: { process: 'ChatGPT.exe', network: 'tcp', host: 'chatgpt.com' } })
    ]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(readConnections).not.toHaveBeenCalled();

    await coordinator.observe([first, second]);
    await vi.advanceTimersByTimeAsync(8_000);
    expect(readConnections).toHaveBeenCalledTimes(1);
    expect(api.closeConnection).not.toHaveBeenCalled();
  });

  it('cancels a pending recheck on reset and ignores a recheck that resolves after reset', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const api = createApi();
    const connection = codexConnection();
    let resolveConnections: ((connections: readonly RuntimeConnectionStats[]) => void) | undefined;
    const readConnections = vi.fn(
      () =>
        new Promise<readonly RuntimeConnectionStats[]>((resolve) => {
          resolveConnections = resolve;
        })
    );
    const coordinator = createCodexConnectionRecoveryCoordinator({ createMihomoApi: () => api, readConnections });

    await coordinator.observe([connection]);
    coordinator.reset();
    await vi.advanceTimersByTimeAsync(8_000);
    expect(readConnections).not.toHaveBeenCalled();

    await coordinator.observe([connection]);
    vi.advanceTimersByTime(8_000);
    await Promise.resolve();
    expect(readConnections).toHaveBeenCalledTimes(1);

    coordinator.reset();
    resolveConnections?.([connection]);
    await Promise.resolve();
    await Promise.resolve();
    expect(api.closeConnection).not.toHaveBeenCalled();
  });

  it('does not schedule a new recheck during the global recovery cooldown', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const api = createApi();
    const first = codexConnection({ id: 'first' });
    const readConnections = vi.fn(async () => [first]);
    const coordinator = createCodexConnectionRecoveryCoordinator({ createMihomoApi: () => api, readConnections });

    await coordinator.observe([first]);
    await vi.advanceTimersByTimeAsync(8_000);
    expect(api.closeConnection).toHaveBeenCalledTimes(1);

    const second = codexConnection({ id: 'second', start: new Date(10_000).toISOString() });
    await vi.advanceTimersByTimeAsync(2_000);
    await coordinator.observe([second]);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(readConnections).toHaveBeenCalledTimes(1);
  });

  it('keeps a global thirty-second recovery cooldown even when a new Codex connection stalls', async () => {
    const api = createApi();
    let clock = 8_000;
    const coordinator = createCodexConnectionRecoveryCoordinator({ createMihomoApi: () => api, now: () => clock });
    const first = codexConnection({ id: 'first' });

    await coordinator.observe([first]);
    clock = 9_000;
    await coordinator.observe([first]);
    expect(api.closeConnection).toHaveBeenCalledTimes(1);

    const second = codexConnection({ id: 'second' });
    clock = 16_000;
    await coordinator.observe([second]);
    clock = 17_000;
    await coordinator.observe([second]);
    expect(api.closeConnection).toHaveBeenCalledTimes(1);

    clock = 39_000;
    await coordinator.observe([second]);
    expect(api.closeConnection).toHaveBeenCalledTimes(2);
    expect(api.closeConnection).toHaveBeenLastCalledWith('second');
  });

  it('clears observations on reset without bypassing the global recovery cooldown', async () => {
    const api = createApi();
    let clock = 8_000;
    const coordinator = createCodexConnectionRecoveryCoordinator({ createMihomoApi: () => api, now: () => clock });
    const first = codexConnection({ id: 'first' });

    await coordinator.observe([first]);
    clock = 9_000;
    await coordinator.observe([first]);
    coordinator.reset();

    const second = codexConnection({ id: 'second' });
    clock = 16_000;
    await coordinator.observe([second]);
    clock = 17_000;
    await coordinator.observe([second]);
    expect(api.closeConnection).toHaveBeenCalledTimes(1);
  });

  it('does not overlap targeted recoveries', async () => {
    let releaseClose: (() => void) | undefined;
    const api = {
      closeConnection: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            releaseClose = resolve;
          })
      ),
      flushDnsCache: vi.fn(async () => undefined)
    };
    let clock = 8_000;
    const coordinator = createCodexConnectionRecoveryCoordinator({ createMihomoApi: () => api, now: () => clock });
    const first = codexConnection({ id: 'first' });
    const second = codexConnection({ id: 'second' });

    await coordinator.observe([first]);
    clock = 9_000;
    const firstRecovery = coordinator.observe([first]);
    await vi.waitFor(() => expect(api.closeConnection).toHaveBeenCalledWith('first'));

    clock = 40_000;
    await coordinator.observe([second]);
    clock = 41_000;
    await coordinator.observe([second]);
    expect(api.closeConnection).toHaveBeenCalledTimes(1);

    releaseClose?.();
    await firstRecovery;
    expect(api.flushDnsCache).toHaveBeenCalledTimes(1);
  });

  it('reports a targeted close failure without flushing DNS', async () => {
    const closeError = new Error('controller unavailable');
    const api = {
      closeConnection: vi.fn(async () => {
        throw closeError;
      }),
      flushDnsCache: vi.fn(async () => undefined)
    };
    const onError = vi.fn(async () => undefined);
    let clock = 8_000;
    const coordinator = createCodexConnectionRecoveryCoordinator({
      createMihomoApi: () => api,
      now: () => clock,
      onError
    });
    const connection = codexConnection();

    await coordinator.observe([connection]);
    clock = 9_000;
    await coordinator.observe([connection]);

    expect(onError).toHaveBeenCalledWith(closeError, connection);
    expect(api.flushDnsCache).not.toHaveBeenCalled();
  });
});
