import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('professional workspace layout contract', () => {
  it('uses the shared header shell on every professional page', async () => {
    const pages = await Promise.all(
      ['Home.tsx', 'NodeSelect.tsx', 'TestPage.tsx', 'Settings.tsx', 'PetPreviewPage.tsx'].map((name) =>
        readFile(`src/renderer/pages/${name}`, 'utf8')
      )
    );

    for (const source of pages) expect(source).toContain('<WorkspaceHeader');
  });

  it('keeps header actions and dashboard headings on shared geometry tokens', async () => {
    const styles = await readFile('src/renderer/styles.css', 'utf8');
    const home = await readFile('src/renderer/pages/Home.tsx', 'utf8');

    expect(styles).toContain('--header-action-height: 40px;');
    expect(styles).toContain('--header-action-width: 112px;');
    expect(styles).toContain('--workspace-content-gap: 12px;');
    expect(getCssRule(styles, '.header-actions > button,\n.header-actions > .status-badge')).toContain(
      'height: var(--header-action-height);'
    );
    expect(getCssRule(styles, '.header-actions > button,\n.header-actions > .status-badge')).toContain(
      'width: var(--header-action-width);'
    );
    expect(getCssRule(styles, '.dashboard-panel')).toContain('grid-template-rows: 18px minmax(0, 1fr);');
    expect(getCssRule(styles, '.dashboard-panel')).toContain('gap: 8px;');
    expect(home.match(/<DashboardPanel/g)).toHaveLength(2);
  });

  it('uses one readable header-button geometry and the sidebar hover surface', async () => {
    const styles = await readFile('src/renderer/styles.css', 'utf8');
    const headerButton = getCssRule(styles, '.header-actions > button');
    const headerSecondary = getCssRule(styles, '.header-actions > .secondary-button');
    const sidebarHover = getCssRule(styles, '.nav-list button:not(.active):hover:not(:disabled)');

    expect(styles).toContain('--interactive-hover: #efe4fb;');
    expect(headerButton).toContain('font-size: 16px;');
    expect(headerSecondary).toContain('color: var(--ink-soft);');
    expect(headerSecondary).toContain('background: var(--interactive-hover);');
    expect(sidebarHover).toContain('background: var(--interactive-hover);');
  });

  it('keeps batch tests primary while subscription refresh stays secondary', async () => {
    const [nodes, testing] = await Promise.all([
      readFile('src/renderer/pages/NodeSelect.tsx', 'utf8'),
      readFile('src/renderer/pages/TestPage.tsx', 'utf8')
    ]);

    expect(nodes).toContain('className="wide-button"');
    expect(nodes).toContain('className="secondary-button"');
    expect(testing).toContain('className="wide-button"');
  });

  it('uses the shared thin border on every pet preview surface', async () => {
    const styles = await readFile('src/renderer/styles.css', 'utf8');

    expect(getCssRule(styles, '.pet-preview-card')).toContain('border: 1px solid var(--line);');
    expect(getCssRule(styles, '.pet-preview-large,\n.pet-preview-detail')).toContain('border: 1px solid var(--line);');
  });

  it('does not duplicate sidebar navigation with node or settings back actions', async () => {
    const [nodes, settings] = await Promise.all([
      readFile('src/renderer/pages/NodeSelect.tsx', 'utf8'),
      readFile('src/renderer/pages/Settings.tsx', 'utf8')
    ]);

    expect(nodes).not.toContain('onBack');
    expect(settings).not.toContain('onBack');
    expect(nodes).not.toContain('>\n              返回\n');
    expect(settings).not.toContain('>\n            返回\n');
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
