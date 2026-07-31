import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('renderer typography contract', () => {
  it('uses only the platform system font and supported font weights', async () => {
    const styles = await readFile('src/renderer/styles.css', 'utf8');
    const formControls = getCssRule(styles, 'button,\ninput,\nselect,\ntextarea,\na');

    expect(styles).toContain('--font-sans: system-ui, sans-serif;');
    expect(styles).not.toContain('--font-mono');
    expect(styles.match(/font-family:/g)).toHaveLength(1);
    expect(styles).not.toMatch(/font-weight:\s*(?:750|800|850|900|950)\b/);
    expect(formControls).toContain('font: inherit;');
  });

  it('uses readable caption sizing and keeps unit line-height only for decorative sleep glyphs', async () => {
    const styles = await readFile('src/renderer/styles.css', 'utf8');
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
    const styles = await readFile('src/renderer/styles.css', 'utf8');
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

    for (const rule of [category, status, retry]) {
      expect(rule).toContain('font-size: var(--font-size-caption);');
      expect(rule).toContain('font-weight: var(--font-weight-bold);');
      expect(rule).toContain('line-height: var(--line-height-caption);');
    }
    expect(retry).toContain('height: 24px;');
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
