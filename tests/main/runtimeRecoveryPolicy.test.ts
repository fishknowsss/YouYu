import { describe, expect, it, vi } from 'vitest';
import {
  RuntimeOperationError,
  classifyRuntimeFailure,
  runRuntimeOperationWithSafeRetry
} from '../../src/main/runtimeRecoveryPolicy';

describe('runtime recovery policy', () => {
  it('retries a clearly transient core failure only once', async () => {
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new RuntimeOperationError('CORE_NOT_READY', 'controller is not ready'))
      .mockResolvedValueOnce('running');

    await expect(runRuntimeOperationWithSafeRetry(operation)).resolves.toBe('running');
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('recognizes the current mihomo controller timeout as a transient core failure', async () => {
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('mihomo controller not ready on 127.0.0.1:9090'))
      .mockResolvedValueOnce('running');

    await expect(runRuntimeOperationWithSafeRetry(operation)).resolves.toBe('running');
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('recognizes a port bind conflict reported by mihomo as transient', async () => {
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(
        new Error(
          'mihomo exited before controller was ready: exit code 1; recent mihomo output: bind: address already in use'
        )
      )
      .mockResolvedValueOnce('running');

    await expect(runRuntimeOperationWithSafeRetry(operation)).resolves.toBe('running');
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['missing subscription url', 'SUBSCRIPTION_INVALID'],
    ['mihomo has no usable subscription nodes after startup: provider empty', 'SUBSCRIPTION_INVALID'],
    ['remote config changed during mihomo start', 'REMOTE_REVISION_STALE'],
    ['YAMLParseError: bad indentation in config.yaml', 'CONFIG_INVALID'],
    ['operation canceled', 'OPERATION_ABORTED'],
    ['operation replaced', 'OPERATION_ABORTED'],
    ['需要管理员权限才能继续', 'ELEVATION_CANCELED'],
    ['等待管理员授权超时', 'ELEVATION_CANCELED'],
    ['Failed to verify current-user proxy after enable', 'PROXY_APPLY_FAILED'],
    ['System network repair failed: netsh failed', 'SYSTEM_NETWORK_REPAIR_FAILED']
  ] as const)('classifies non-retryable runtime failure %s', (message, code) => {
    expect(classifyRuntimeFailure(new Error(message))).toMatchObject({ code, retryable: false });
  });

  it('treats lifecycle rollback failure as a blocking proxy-restore failure', () => {
    const failure = new AggregateError(
      [new RuntimeOperationError('CORE_NOT_READY', 'controller is not ready'), new Error('reg query failed')],
      'lifecycle start and proxy rollback failed'
    );

    expect(classifyRuntimeFailure(failure)).toMatchObject({ code: 'PROXY_RESTORE_REQUIRED', retryable: false });
  });

  it('never performs a third attempt when the safe retry also fails', async () => {
    const operation = vi.fn(async () => {
      throw new RuntimeOperationError('PORT_CONFLICT', 'address already in use');
    });

    await expect(runRuntimeOperationWithSafeRetry(operation)).rejects.toThrow('address already in use');
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('does not retry when the caller cancels the failed operation', async () => {
    const controller = new AbortController();
    const operation = vi.fn(async () => {
      controller.abort(new Error('operation canceled'));
      throw new RuntimeOperationError('CORE_NOT_READY', 'controller is not ready');
    });

    await expect(runRuntimeOperationWithSafeRetry(operation, { signal: controller.signal })).rejects.toThrow(
      'operation canceled'
    );
    expect(operation).toHaveBeenCalledOnce();
  });
});
