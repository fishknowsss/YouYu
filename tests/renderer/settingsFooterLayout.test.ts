import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { readRendererStyles } from './helpers/rendererStyles';

function getCssRule(source: string, selector: string): string {
  const start = source.indexOf(`${selector} {`);
  expect(start, `missing CSS rule: ${selector}`).toBeGreaterThanOrEqual(0);
  const end = source.indexOf('\n}', start);
  expect(end, `unterminated CSS rule: ${selector}`).toBeGreaterThan(start);
  return source.slice(start, end + 2);
}

describe('settings footer layout', () => {
  it('uses one six-row rhythm without a flexible spacer between controls and footer', async () => {
    const source = await readRendererStyles();
    const markup = await readFile('src/renderer/pages/Settings.tsx', 'utf8');
    const settingsPanel = getCssRule(source, '.settings-panel');
    const formGrid = getCssRule(source, '.settings-form-grid');

    const row = getCssRule(source, '.settings-row');

    expect(settingsPanel).toContain('--settings-row-gap: 8px;');
    expect(settingsPanel).toContain('padding: 16px;');
    expect(settingsPanel).not.toContain('--settings-compact-row-height');
    expect(formGrid).toContain('grid-template-columns: minmax(300px, 1fr) 204px var(--settings-action-width);');
    expect(formGrid).toContain('grid-template-rows: repeat(6, var(--settings-row-height));');
    expect(formGrid).toContain('row-gap: var(--settings-row-gap);');
    expect(formGrid).toContain('column-gap: 16px;');
    expect(formGrid).toContain('align-content: center;');
    expect(row).toContain('grid-template-columns: subgrid;');
    expect(markup.match(/className="settings-row/g)).toHaveLength(6);
    expect(source).not.toContain('.settings-controls-grid {');
    expect(source).not.toContain('.settings-footer {');
    expect(markup).not.toContain('className="settings-controls-grid"');
    expect(markup).not.toContain('className="settings-footer"');
  });

  it('uses one shared row height for diagnostics and software updates', async () => {
    const source = await readRendererStyles();
    const settingsPanel = getCssRule(source, '.settings-panel');
    const diagnostics = getCssRule(source, '.settings-diagnostics-bar');
    const update = getCssRule(source, '.update-row');

    expect(settingsPanel).toContain('--settings-footer-row-height: 54px;');
    expect(settingsPanel).not.toContain('--settings-update-row-height');
    expect(diagnostics).toContain('height: var(--settings-footer-row-height);');
    expect(update).toContain('min-height: var(--settings-footer-row-height);');
  });

  it('keeps both footer actions in the same button vocabulary as the settings actions', async () => {
    const source = await readRendererStyles();
    const footerAction = getCssRule(source, '.settings-footer-action');
    const diagnosticsExport = getCssRule(source, '.settings-diagnostics-export');

    expect(footerAction).toContain('font-size: 18px;');
    expect(footerAction).toContain('font-weight: 700;');
    expect(diagnosticsExport).not.toContain('background: transparent;');
    expect(source).not.toContain('.settings-diagnostics-export:hover:not(:disabled)');
  });
});
