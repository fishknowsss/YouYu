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
