import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { readRendererStyles } from './helpers/rendererStyles';

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
    const styles = await readRendererStyles();
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
    const styles = await readRendererStyles();
    const headerButton = getCssRule(styles, '.header-actions > button');
    const headerSecondary = getCssRule(styles, '.header-actions > .secondary-button');
    const sidebarHover = getCssRule(styles, '.nav-list button:not(.active):hover:not(:disabled)');

    expect(styles).toContain('--interactive-hover: #efe4fb;');
    expect(headerButton).toContain('padding: 0 12px;');
    expect(headerSecondary).toContain('color: var(--ink-soft);');
    expect(headerSecondary).toContain('background: var(--interactive-hover);');
    expect(sidebarHover).toContain('background: var(--interactive-hover);');
  });

  it('does not apply the node-test hover surface while the action is disabled', async () => {
    const styles = await readRendererStyles();

    expect(styles).toContain('.node:not(.active) .node-test:hover:not(:disabled)');
    expect(styles).not.toContain('.node:not(.active) .node-test:hover {');
  });

  it('keeps header buttons and status badges on one typography contract', async () => {
    const styles = await readRendererStyles();
    const sharedHeaderAction = getCssRule(styles, '.header-actions > button,\n.header-actions > .status-badge');
    const statusBadge = getCssRule(styles, '.status-badge');

    expect(styles).toContain('--font-size-action: 15px;');
    expect(styles).toContain('--line-height-action: 20px;');
    expect(styles).toContain('--font-weight-bold: 700;');
    expect(sharedHeaderAction).toContain('font-size: var(--font-size-action);');
    expect(sharedHeaderAction).toContain('font-weight: var(--font-weight-bold);');
    expect(sharedHeaderAction).toContain('line-height: var(--line-height-action);');
    expect(statusBadge).not.toMatch(/font-(?:size|weight):/);
  });

  it('announces home runtime status without interrupting the user', async () => {
    const home = await readFile('src/renderer/pages/Home.tsx', 'utf8');

    expect(home).toContain('role="status"');
    expect(home).toContain('aria-live="polite"');
    expect(home).toContain('aria-atomic="true"');
  });

  it('stacks easy-mode notices away from the bottom-left advanced-mode hotspot', async () => {
    const [styles, home] = await Promise.all([readRendererStyles(), readFile('src/renderer/pages/Home.tsx', 'utf8')]);
    const noticeStack = getCssRule(styles, '.easy-notice-stack');
    const errorNotice = getCssRule(styles, '.easy-error-notice');
    const updateNotice = getCssRule(styles, '.easy-update-notice');

    expect(home).toContain('className="easy-notice-stack"');
    expect(noticeStack).toContain('position: fixed;');
    expect(noticeStack).toContain('right: 12px;');
    expect(noticeStack).toContain('bottom: 12px;');
    expect(noticeStack).not.toContain('left:');
    expect(errorNotice).not.toContain('position: fixed;');
    expect(updateNotice).not.toContain('position: fixed;');
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

  it('reserves the Windows thin-scrollbar gutter in the route-test header', async () => {
    const styles = await readRendererStyles();
    const routeTestHead = getCssRule(styles, '.route-test-head');

    expect(styles).toContain('--route-test-scrollbar-gutter: 10px;');
    expect(routeTestHead).toContain('padding: 0 calc(10px + var(--route-test-scrollbar-gutter)) 0 10px;');
  });

  it('uses the shared thin border on every pet preview surface', async () => {
    const styles = await readRendererStyles();

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
  const normalized = `\n${source.replace(/\r\n/g, '\n')}`;
  const markerStart = normalized.indexOf(`\n${selector} {`);
  expect(markerStart).toBeGreaterThanOrEqual(0);
  const start = markerStart + 1;
  const end = normalized.indexOf('\n}', start);
  expect(end).toBeGreaterThan(start);
  return normalized.slice(start, end + 2);
}
