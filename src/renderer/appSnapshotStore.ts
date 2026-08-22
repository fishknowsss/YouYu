export type AppSnapshotStore<Snapshot> = {
  mount: () => void;
  unmount: () => void;
  isMounted: () => boolean;
  getSnapshot: () => Snapshot;
  getGeneration: () => number;
  commit: (next: Snapshot, expectedGeneration?: number) => boolean;
};

export function createAppSnapshotStore<Snapshot>(
  initialSnapshot: Snapshot,
  onCommit: (snapshot: Snapshot) => void
): AppSnapshotStore<Snapshot> {
  let snapshot = initialSnapshot;
  let generation = 0;
  let mounted = false;

  function commit(next: Snapshot, expectedGeneration?: number): boolean {
    if (!mounted) return false;
    if (expectedGeneration !== undefined && generation !== expectedGeneration) return false;
    generation += 1;
    snapshot = next;
    onCommit(next);
    return true;
  }

  return {
    mount() {
      mounted = true;
    },
    unmount() {
      mounted = false;
    },
    isMounted: () => mounted,
    getSnapshot: () => snapshot,
    getGeneration: () => generation,
    commit
  };
}
