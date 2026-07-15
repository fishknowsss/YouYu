import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { createPetVisibilityController } from '../../src/main/petVisibilityController';
import { createFullscreenSuppressionStabilizer } from '../../src/main/platform/windowsFullscreenProbe';

describe('desktop pet fullscreen visibility policy', () => {
  it('hides immediately on same-monitor fullscreen and restores after two clear samples', () => {
    const changes: boolean[] = [];
    const visibility = createPetVisibilityController({
      initialUserRequestedVisible: true,
      onVisibilityChange: (visible) => changes.push(visible)
    });
    const stabilizer = createFullscreenSuppressionStabilizer((suppressed) =>
      visibility.setFullscreenSuppressed(suppressed)
    );

    stabilizer.update(true);
    expect(visibility.isVisible()).toBe(false);
    stabilizer.update(false);
    expect(visibility.isVisible()).toBe(false);
    stabilizer.update(false);
    expect(visibility.isVisible()).toBe(true);
    expect(changes).toEqual([false, true]);
  });

  it('does not restore a pet that the user hid while fullscreen was active', () => {
    const onVisibilityChange = vi.fn();
    const visibility = createPetVisibilityController({
      initialUserRequestedVisible: true,
      onVisibilityChange
    });

    visibility.setFullscreenSuppressed(true);
    visibility.setUserRequestedVisible(false);
    visibility.setFullscreenSuppressed(false);

    expect(visibility.isUserRequestedVisible()).toBe(false);
    expect(visibility.isVisible()).toBe(false);
    expect(onVisibilityChange).toHaveBeenCalledTimes(1);
    expect(onVisibilityChange).toHaveBeenLastCalledWith(false);
  });

  it('keeps a pet on another monitor visible because the probe reports only the pet monitor', () => {
    const visibility = createPetVisibilityController({
      initialUserRequestedVisible: true,
      onVisibilityChange: vi.fn()
    });
    const stabilizer = createFullscreenSuppressionStabilizer((suppressed) =>
      visibility.setFullscreenSuppressed(suppressed)
    );

    stabilizer.update(false);

    expect(visibility.isVisible()).toBe(true);
  });

  it('cancels an asynchronous helper preparation before a stale window can start a probe', async () => {
    const source = await readFile('src/main/index.ts', 'utf8');
    const start = source.slice(
      source.indexOf('async function startPetFullscreenProbe'),
      source.indexOf('function stopPetFullscreenProbe')
    );
    const stop = source.slice(
      source.indexOf('function stopPetFullscreenProbe'),
      source.indexOf('function restartPetFullscreenProbe')
    );

    expect(start).toContain('const generation = ++petFullscreenProbeGeneration');
    expect(start).toContain('await prepareWindowsFullscreenProbeExecutable');
    expect(start).toContain('generation !== petFullscreenProbeGeneration');
    expect(start).toContain('petWindow !== window');
    expect(start).toContain('window.isDestroyed()');
    expect(start.indexOf('generation !== petFullscreenProbeGeneration')).toBeLessThan(
      start.indexOf('petFullscreenProbe = startWindowsFullscreenProbe')
    );
    expect(stop).toContain('petFullscreenProbeGeneration += 1');
  });
});
