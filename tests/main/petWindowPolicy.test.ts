import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { applyPetWindowTaskbarPolicy } from '../../src/main/petWindowPolicy';

describe('desktop pet Windows taskbar policy', () => {
  it('creates a keyboard-focusable tool window and reapplies taskbar exclusion after showing it', async () => {
    const source = await readFile('src/main/index.ts', 'utf8');
    const createPetWindow = source.slice(
      source.indexOf('async function createPetWindow'),
      source.indexOf('function secureRendererNavigation')
    );
    const readyToShow = createPetWindow.slice(createPetWindow.indexOf("win.once('ready-to-show'"));
    const visibility = source.slice(
      source.indexOf('function applyPetWindowVisibility'),
      source.indexOf('function startPetFullscreenProbe')
    );

    expect(createPetWindow).toContain("type: 'toolbar'");
    expect(createPetWindow).toContain('focusable: true');
    expect(createPetWindow).toContain('skipTaskbar: true');
    expect(createPetWindow.match(/applyPetWindowTaskbarPolicy\(win\)/g)).toHaveLength(2);
    expect(readyToShow).toContain('applyPetWindowVisibility()');
    expect(readyToShow).toContain('applyPetWindowTaskbarPolicy(win)');
    expect(visibility.indexOf('petWindow.showInactive()')).toBeGreaterThanOrEqual(0);
    expect(visibility.indexOf('applyPetWindowTaskbarPolicy(petWindow)')).toBeGreaterThan(
      visibility.indexOf('petWindow.showInactive()')
    );
  });

  it('keeps the pet keyboard-focusable while excluding it from the taskbar', () => {
    const calls: string[] = [];

    applyPetWindowTaskbarPolicy({
      setFocusable: (focusable: boolean) => calls.push(`focusable:${String(focusable)}`),
      setSkipTaskbar: (skip: boolean) => calls.push(`skip:${String(skip)}`)
    } as never);

    expect(calls).toEqual(['focusable:true', 'skip:true']);
  });

  it('keeps the desktop notice keyboard-focusable without putting it on the taskbar', async () => {
    const source = await readFile('src/main/index.ts', 'utf8');
    const createNoticeWindow = source.slice(
      source.indexOf('async function createNoticeWindow'),
      source.indexOf('async function createPetWindow')
    );

    expect(createNoticeWindow).toContain('focusable: true');
    expect(createNoticeWindow).toContain('win.setFocusable(true)');
    expect(createNoticeWindow).toContain('skipTaskbar: true');
  });
});
