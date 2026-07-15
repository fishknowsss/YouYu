import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

function getCssRule(source: string, selector: string): string {
  const start = source.indexOf(`${selector} {`);
  expect(start, `missing CSS rule: ${selector}`).toBeGreaterThanOrEqual(0);
  const end = source.indexOf('\n}', start);
  expect(end, `unterminated CSS rule: ${selector}`).toBeGreaterThan(start);
  return source.slice(start, end + 2);
}

describe('settings footer layout', () => {
  it('uses one six-row rhythm without a flexible spacer between controls and footer', async () => {
    const source = await readFile('src/renderer/styles.css', 'utf8');
    const settingsPanel = getCssRule(source, '.settings-panel');
    const formGrid = getCssRule(source, '.settings-form-grid');
    const controlsGrid = getCssRule(source, '.settings-controls-grid');
    const footer = getCssRule(source, '.settings-footer');

    expect(settingsPanel).toContain('--settings-row-gap: 16px;');
    expect(settingsPanel).toContain('--settings-compact-row-height: 46px;');
    expect(formGrid).toContain('grid-template-rows: var(--settings-row-height) auto auto;');
    expect(formGrid).toContain('row-gap: var(--settings-row-gap);');
    expect(formGrid).not.toContain('minmax(0, 1fr)');
    expect(controlsGrid).toContain(
      'grid-template-rows: repeat(2, var(--settings-row-height)) var(--settings-compact-row-height);'
    );
    expect(controlsGrid).toContain('row-gap: var(--settings-row-gap);');
    expect(footer).toContain('grid-row: 3;');
    expect(footer).toContain('gap: var(--settings-row-gap);');
  });

  it('uses one shared row height for diagnostics and software updates', async () => {
    const source = await readFile('src/renderer/styles.css', 'utf8');
    const settingsPanel = getCssRule(source, '.settings-panel');
    const diagnostics = getCssRule(source, '.settings-diagnostics-bar');
    const update = getCssRule(source, '.update-row');

    expect(settingsPanel).toContain('--settings-footer-row-height: 54px;');
    expect(settingsPanel).not.toContain('--settings-update-row-height');
    expect(diagnostics).toContain('height: var(--settings-footer-row-height);');
    expect(update).toContain('min-height: var(--settings-footer-row-height);');
  });

  it('keeps both footer actions in the same button vocabulary as the settings actions', async () => {
    const source = await readFile('src/renderer/styles.css', 'utf8');
    const footerAction = getCssRule(source, '.settings-footer-action');
    const diagnosticsExport = getCssRule(source, '.settings-diagnostics-export');

    expect(footerAction).toContain('font-size: 18px;');
    expect(footerAction).toContain('font-weight: 700;');
    expect(diagnosticsExport).not.toContain('background: transparent;');
    expect(source).not.toContain('.settings-diagnostics-export:hover:not(:disabled)');
  });
});
