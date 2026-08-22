import { describe, expect, it, vi } from 'vitest';
import { createAppSnapshotStore } from '../../src/renderer/appSnapshotStore';

describe('AppSnapshotStore', () => {
  it('commits only while mounted and rejects stale generations without changing identity', () => {
    const onCommit = vi.fn();
    const store = createAppSnapshotStore({ value: 'initial' }, onCommit);
    const first = { value: 'first' };

    expect(store.commit(first)).toBe(false);
    store.mount();
    expect(store.commit(first)).toBe(true);
    expect(store.getSnapshot()).toBe(first);
    expect(store.getGeneration()).toBe(1);
    expect(onCommit).toHaveBeenCalledWith(first);

    expect(store.commit({ value: 'stale' }, 0)).toBe(false);
    expect(store.getSnapshot()).toBe(first);
    store.unmount();
    expect(store.commit({ value: 'after-unmount' }, 1)).toBe(false);
  });
});
