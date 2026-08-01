// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SettingsSelect } from '../../src/renderer/components/SettingsSelect';
import { isEditableShortcutTarget } from '../../src/renderer/hooks/useAdvancedModeShortcut';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('SettingsSelect', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  afterEach(async () => {
    await act(async () => root?.unmount());
    container?.remove();
    root = undefined;
    container = undefined;
  });

  it('renders a custom listbox instead of a native select and commits a clicked option', async () => {
    const onChange = vi.fn();
    await renderSelect(onChange);

    expect(container?.querySelector('select')).toBeNull();
    const trigger = container?.querySelector<HTMLButtonElement>('[aria-haspopup="listbox"]');
    expect(trigger?.getAttribute('aria-expanded')).toBe('false');

    await act(async () => trigger?.click());
    expect(trigger?.getAttribute('aria-expanded')).toBe('true');
    expect(container?.querySelector('[role="listbox"]')).toBeTruthy();
    expect(container?.querySelectorAll('[role="option"]')).toHaveLength(3);

    const option = [...(container?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])].find(
      (item) => item.textContent === '24 小时'
    );
    await act(async () => option?.click());

    expect(onChange).toHaveBeenCalledWith(24);
    expect(trigger?.getAttribute('aria-expanded')).toBe('false');
  });

  it('supports arrow navigation, Enter selection and Escape cancellation', async () => {
    const onChange = vi.fn();
    await renderSelect(onChange);
    const trigger = container?.querySelector<HTMLButtonElement>('[aria-haspopup="listbox"]');

    await act(async () => trigger?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })));
    expect(trigger?.getAttribute('aria-expanded')).toBe('true');
    await act(async () => trigger?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })));
    await act(async () => trigger?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    expect(onChange).toHaveBeenLastCalledWith(24);

    await act(async () => trigger?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })));
    await act(async () => trigger?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(trigger?.getAttribute('aria-expanded')).toBe('false');
  });

  it('keeps combobox navigation out of the global usage-mode shortcut sequence', () => {
    const combobox = document.createElement('button');
    combobox.setAttribute('role', 'combobox');
    const listbox = document.createElement('div');
    listbox.setAttribute('role', 'listbox');
    const option = document.createElement('button');
    listbox.append(option);

    expect(isEditableShortcutTarget(combobox)).toBe(true);
    expect(isEditableShortcutTarget(option)).toBe(true);
    expect(isEditableShortcutTarget(document.createElement('button'))).toBe(false);
  });

  async function renderSelect(onChange: (value: number) => void) {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () =>
      root?.render(
        <SettingsSelect
          label="后台刷新"
          value={12}
          options={[
            { value: 6, label: '6 小时' },
            { value: 12, label: '12 小时' },
            { value: 24, label: '24 小时' }
          ]}
          onChange={onChange}
        />
      )
    );
  }
});
