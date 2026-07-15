import { describe, expect, it, vi } from 'vitest';
import type { DiagnosticIssueKind } from '../../src/shared/ipc';
import {
  getTargetedNetworkRepairActions,
  runTargetedNetworkRepair,
  type TargetedNetworkRepairDependencies
} from '../../src/main/targetedNetworkRepair';

describe('targeted network repair', () => {
  it.each([
    ['system-proxy', ['disable-system-proxy']],
    ['dns', ['flush-dns']],
    ['network', ['flush-dns']],
    ['kernel', ['disable-system-proxy', 'stop-kernel']],
    ['subscription', ['refresh-subscription']],
    ['permission', []],
    ['backend', []],
    ['registration', []],
    ['unknown', []]
  ] satisfies Array<[DiagnosticIssueKind, string[]]>)('maps %s to safe targeted actions', (issueKind, expected) => {
    expect(getTargetedNetworkRepairActions(issueKind)).toEqual(expected);
  });

  it('disables the proxy before stopping a kernel diagnosed as unhealthy', async () => {
    const calls: string[] = [];
    await runTargetedNetworkRepair('kernel', createDependencies(calls));
    expect(calls).toEqual(['disable-system-proxy', 'stop-kernel']);
  });

  it('does not execute a later action after cancellation', async () => {
    const controller = new AbortController();
    const calls: string[] = [];
    const deps = createDependencies(calls, () => controller.abort());

    await expect(runTargetedNetworkRepair('kernel', deps, controller.signal)).rejects.toMatchObject({
      name: 'AbortError'
    });
    expect(calls).toEqual(['disable-system-proxy']);
  });
});

function createDependencies(calls: string[], afterDisable?: () => void): TargetedNetworkRepairDependencies {
  return {
    disableSystemProxy: vi.fn(async () => {
      calls.push('disable-system-proxy');
      afterDisable?.();
    }),
    flushDns: vi.fn(async () => {
      calls.push('flush-dns');
    }),
    stopKernel: vi.fn(async () => {
      calls.push('stop-kernel');
    }),
    refreshSubscription: vi.fn(async () => {
      calls.push('refresh-subscription');
    })
  };
}
