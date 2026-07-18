import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('professional workspace layout contract', () => {
  it('uses the shared header shell on every professional page', async () => {
    const pages = await Promise.all(
      ['Home.tsx', 'NodeSelect.tsx', 'TestPage.tsx', 'Settings.tsx'].map((name) =>
        readFile(`src/renderer/pages/${name}`, 'utf8')
      )
    );

    for (const source of pages) expect(source).toContain('<WorkspaceHeader');
  });

  it('keeps header actions and dashboard headings on shared geometry tokens', async () => {
    const styles = await readFile('src/renderer/styles.css', 'utf8');
    const home = await readFile('src/renderer/pages/Home.tsx', 'utf8');

    expect(styles).toContain('--header-action-height: 40px;');
    expect(styles).toContain('--workspace-content-gap: 12px;');
    expect(getCssRule(styles, '.header-actions > button,\n.header-actions > .status-badge')).toContain(
      'height: var(--header-action-height);'
    );
    expect(getCssRule(styles, '.dashboard-panel')).toContain('grid-template-rows: 18px minmax(0, 1fr);');
    expect(getCssRule(styles, '.dashboard-panel')).toContain('gap: 8px;');
    expect(home.match(/<DashboardPanel/g)).toHaveLength(2);
  });
});

function getCssRule(source: string, selector: string): string {
  const normalized = source.replace(/\r\n/g, '\n');
  const start = normalized.indexOf(`${selector} {`);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = normalized.indexOf('\n}', start);
  expect(end).toBeGreaterThan(start);
  return normalized.slice(start, end + 2);
}
