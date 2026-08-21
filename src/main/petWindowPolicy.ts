import type { BrowserWindow } from 'electron';

type PetWindowTaskbarTarget = Pick<BrowserWindow, 'setFocusable' | 'setSkipTaskbar'>;

export function applyPetWindowTaskbarPolicy(window: PetWindowTaskbarTarget): void {
  window.setFocusable(true);
  window.setSkipTaskbar(true);
}
