import { describe, expect, it } from 'vitest';
import { readRendererStyles } from './helpers/rendererStyles';

describe('test page shell alignment', () => {
  it('inherits the same workspace width, header track, and content gap as the other professional pages', async () => {
    const source = await readRendererStyles();

    expect(source).not.toContain('.test-workspace {');
  });

  it('keeps semantic table headers and data rows on the same eight-column grid', async () => {
    const source = await readRendererStyles();
    const sharedGrid = getCssRule(source, '.route-test-head-row,\n.route-test-row');

    expect(sharedGrid).toContain('display: grid;');
    expect(sharedGrid).toContain('grid-template-columns:');
    expect(sharedGrid).toContain('48px;');
    expect(source).not.toContain('.route-test-head,\n.route-test-row {');
  });

  it('does not apply the retry hover surface while the action is disabled', async () => {
    const source = await readRendererStyles();

    expect(source).toContain('.test-retry:hover:not(:disabled)');
    expect(source).not.toContain('.test-retry:hover {');
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
