import { describe, expect, it } from 'vitest';
import { readRendererStyles } from './helpers/rendererStyles';

describe('renderer typography contract', () => {
  it('uses only the platform system font and supported font weights', async () => {
    const styles = await readRendererStyles();
    const formControls = getCssRule(styles, 'button,\ninput,\nselect,\ntextarea,\na');

    expect(styles).toContain('--font-sans: system-ui, sans-serif;');
    expect(styles).not.toContain('--font-mono');
    expect(styles.match(/font-family:/g)).toHaveLength(1);
    expect(styles).not.toMatch(/font-weight:\s*(?:750|800|850|900|950)\b/);
    expect(formControls).toContain('font: inherit;');
  });

  it('keeps dense action labels away from the 16px Windows CJK rasterization boundary', async () => {
    const styles = await readRendererStyles();
    const root = getCssRule(styles, ':root');
    const headerActions = getCssRule(styles, '.header-actions > button,\n.header-actions > .status-badge');
    const nodeTest = getCssRule(styles, '.node-test');

    expect(root).toContain('--font-size-action: 15px;');
    expect(root).toContain('--line-height-action: 20px;');
    expect(headerActions).toContain('font-size: var(--font-size-action);');
    expect(headerActions).toContain('line-height: var(--line-height-action);');
    expect(nodeTest).toContain('font-size: var(--font-size-action);');
    expect(nodeTest).toContain('line-height: var(--line-height-action);');
    expect(nodeTest).toContain('display: inline-flex;');
    expect(nodeTest).toContain('align-items: center;');
    expect(nodeTest).toContain('justify-content: center;');
    expect(nodeTest).toContain('padding: 0;');
  });

  it('uses readable caption sizing and keeps unit line-height only for decorative sleep glyphs', async () => {
    const styles = await readRendererStyles();
    const decorativeSleepGlyphs = [
      getCssRule(styles, '.pet-side-sleep-z'),
      getCssRule(styles, '.pet-sprite-topSleep::before,\n.pet-sprite-bottomSleep::before')
    ];
    const normalizedStyles = styles.replace(/\r\n/g, '\n');
    const contentTypography = decorativeSleepGlyphs.reduce(
      (source, rule) => source.replace(rule, ''),
      normalizedStyles
    );

    expect(styles).not.toContain('font-size: 11px;');
    expect(contentTypography).not.toContain('line-height: 1;');
  });

  it('keeps test-page labels on explicit readable typography tokens', async () => {
    const styles = await readRendererStyles();
    const testHead = getCssRule(styles, '.route-test-head');
    const testCells = getCssRule(styles, '.test-service-name,\n.test-number,\n.test-ip,\n.test-region,\n.test-chain');
    const serviceName = getCssRule(styles, '.test-service-name');
    const category = getCssRule(styles, '.test-category');
    const status = getCssRule(styles, '.test-status');
    const retry = getCssRule(styles, '.test-retry');

    expect(testHead).toContain('font-size: var(--font-size-caption);');
    expect(testHead).toContain('line-height: var(--line-height-caption);');
    expect(testCells).toContain('font-size: var(--font-size-caption);');
    expect(testCells).toContain('line-height: var(--line-height-caption);');
    expect(serviceName).toContain('font-size: var(--font-size-body-small);');
    expect(serviceName).toContain('line-height: var(--line-height-body-small);');

    for (const rule of [category, status]) {
      expect(rule).toContain('font-size: var(--font-size-caption);');
      expect(rule).toContain('font-weight: var(--font-weight-bold);');
      expect(rule).toContain('line-height: var(--line-height-caption);');
    }
    expect(retry).toContain('font-size: var(--font-size-body-small);');
    expect(retry).toContain('font-weight: var(--font-weight-bold);');
    expect(retry).toContain('line-height: var(--line-height-body-small);');
    expect(retry).toContain('height: 24px;');
    expect(retry).toContain('display: inline-flex;');
    expect(retry).toContain('align-items: center;');
    expect(retry).toContain('justify-content: center;');
    expect(retry).toContain('padding: 0;');
  });
});

function getCssRule(source: string, selector: string): string {
  const normalized = `\n${source.replace(/\r\n/g, '\n')}`;
  const markerStart = normalized.lastIndexOf(`\n${selector} {`);
  expect(markerStart).toBeGreaterThanOrEqual(0);
  const start = markerStart + 1;
  const end = normalized.indexOf('\n}', start);
  expect(end).toBeGreaterThan(start);
  return normalized.slice(start, end + 2);
}
