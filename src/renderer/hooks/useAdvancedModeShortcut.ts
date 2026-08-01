import { useEffect, useRef } from 'react';
import type { UsageMode } from '../components/AppShell';

const advancedSequence = [
  'ArrowUp',
  'ArrowUp',
  'ArrowDown',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'ArrowLeft',
  'ArrowRight',
  'KeyB',
  'KeyA'
];

export function useAdvancedModeShortcut(usageMode: UsageMode, onUsageModeChange: (mode: UsageMode) => void): void {
  const usageModeRef = useRef(usageMode);
  const onUsageModeChangeRef = useRef(onUsageModeChange);

  useEffect(() => {
    usageModeRef.current = usageMode;
    onUsageModeChangeRef.current = onUsageModeChange;
  }, [onUsageModeChange, usageMode]);

  useEffect(() => {
    let sequenceIndex = 0;

    function handleKeyDown(event: KeyboardEvent) {
      if (isEditableShortcutTarget(event.target)) return;

      const expectedKey = advancedSequence[sequenceIndex];
      if (event.code === expectedKey) {
        sequenceIndex += 1;
        if (sequenceIndex === advancedSequence.length) {
          onUsageModeChangeRef.current(usageModeRef.current === 'advanced' ? 'easy' : 'advanced');
          sequenceIndex = 0;
        }
        return;
      }

      sequenceIndex = event.code === advancedSequence[0] ? 1 : 0;
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);
}

export function isEditableShortcutTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLSelectElement ||
    target instanceof HTMLTextAreaElement ||
    (target instanceof HTMLElement &&
      (target.isContentEditable || Boolean(target.closest('[role="combobox"], [role="listbox"]'))))
  );
}
