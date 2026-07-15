import type { DiagnosticIssueKind } from '../shared/ipc';

export type TargetedNetworkRepairDependencies = {
  disableSystemProxy: (signal?: AbortSignal) => Promise<void>;
  flushDns: (signal?: AbortSignal) => Promise<void>;
  stopKernel: () => Promise<void>;
  refreshSubscription: (signal?: AbortSignal) => Promise<void>;
};

export type TargetedNetworkRepairAction = 'disable-system-proxy' | 'flush-dns' | 'stop-kernel' | 'refresh-subscription';

export function getTargetedNetworkRepairActions(issueKind: DiagnosticIssueKind): TargetedNetworkRepairAction[] {
  switch (issueKind) {
    case 'system-proxy':
      return ['disable-system-proxy'];
    case 'dns':
    case 'network':
      return ['flush-dns'];
    case 'kernel':
      return ['disable-system-proxy', 'stop-kernel'];
    case 'subscription':
      return ['refresh-subscription'];
    default:
      return [];
  }
}

export async function runTargetedNetworkRepair(
  issueKind: DiagnosticIssueKind,
  deps: TargetedNetworkRepairDependencies,
  signal?: AbortSignal
): Promise<void> {
  for (const action of getTargetedNetworkRepairActions(issueKind)) {
    signal?.throwIfAborted();
    switch (action) {
      case 'disable-system-proxy':
        await deps.disableSystemProxy(signal);
        break;
      case 'flush-dns':
        await deps.flushDns(signal);
        break;
      case 'stop-kernel':
        await deps.stopKernel();
        break;
      case 'refresh-subscription':
        await deps.refreshSubscription(signal);
        break;
    }
  }
}
