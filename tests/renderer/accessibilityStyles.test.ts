import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const tokensSource = readFileSync(new URL('../../src/renderer/styles/tokens.css', import.meta.url), 'utf8');
const shellSource = readFileSync(new URL('../../src/renderer/styles/shell.css', import.meta.url), 'utf8');
const dashboardSource = readFileSync(new URL('../../src/renderer/styles/dashboard.css', import.meta.url), 'utf8');
const petSource = readFileSync(new URL('../../src/renderer/styles/pet.css', import.meta.url), 'utf8');
const testSource = readFileSync(new URL('../../src/renderer/styles/test.css', import.meta.url), 'utf8');

const namedColors = {
  accent: readToken('--accent'),
  accentStrong: readToken('--accent-strong'),
  accentSoft: readToken('--accent-soft'),
  surface: readToken('--surface'),
  surfaceRaised: readToken('--surface-raised'),
  inkSoft: readToken('--ink-soft'),
  muted: readToken('--muted'),
  success: readToken('--success'),
  warning: readToken('--warning'),
  danger: readToken('--danger'),
  dangerSoft: readToken('--danger-soft')
};

describe('renderer accessibility styles', () => {
  it.each([
    ['accent text on soft accent', namedColors.accent, namedColors.accentSoft],
    ['accent text on surface', namedColors.accent, namedColors.surface],
    ['focus ring on surface', namedColors.accentStrong, namedColors.surface],
    ['success text on success pill', namedColors.success, '#e3f4ee'],
    ['warning text on warning surface', namedColors.warning, '#fffaf0'],
    ['white text on warning action', '#ffffff', namedColors.warning],
    ['danger text on danger pill', namedColors.danger, '#ffe7f0'],
    ['danger text on danger surface', namedColors.danger, namedColors.dangerSoft],
    ['secondary text on raised surface', namedColors.inkSoft, namedColors.surfaceRaised],
    ['muted text on white', namedColors.muted, '#ffffff'],
    ['global category', '#2250b8', '#edf3ff'],
    ['domestic category', '#087858', '#edf8f4'],
    ['AI category', '#7042c6', '#f3edff'],
    ['special category', '#9a4a13', '#fff2e8']
  ])('%s meets WCAG AA text contrast', (_name, foreground, background) => {
    expect(contrastRatio(foreground, background)).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps focus and selected states visible without relying on color alone', () => {
    expect(shellSource).toMatch(/button:focus-visible[\s\S]*outline:\s*3px solid var\(--accent-strong\)/);
    expect(shellSource).toContain('@media (forced-colors: active)');
    expect(shellSource).toContain('outline: 3px solid Highlight');
    expect(dashboardSource).toMatch(/\.node-current-mark\s*\{[\s\S]*border:\s*1px solid currentColor/);
    expect(petSource).toMatch(/\.pet-hit-target:focus-visible\s*\{[\s\S]*outline:\s*4px solid/);
    expect(petSource).not.toMatch(/\.pet-hit-target:focus-visible\s*\{[^}]*outline:\s*none/);
    expect(petSource).toMatch(
      /@media \(forced-colors: active\)[\s\S]*\.pet-hit-target:focus-visible\s*\{[\s\S]*outline:\s*3px solid Highlight/
    );
    expect(petSource).toMatch(/\.pet-preview-card\.active\s*\{[\s\S]*border:\s*2px solid/);
    expect(testSource).toMatch(/\.route-test-row\.active\s*\{[\s\S]*box-shadow:\s*inset 4px/);
  });
});

function readToken(name: string): string {
  const value = tokensSource.match(new RegExp(`${name}:\\s*(#[0-9a-f]{6})`, 'i'))?.[1];
  if (!value) throw new Error(`Missing color token: ${name}`);
  return value;
}

function contrastRatio(foreground: string, background: string): number {
  const brighter = Math.max(relativeLuminance(foreground), relativeLuminance(background));
  const darker = Math.min(relativeLuminance(foreground), relativeLuminance(background));
  return (brighter + 0.05) / (darker + 0.05);
}

function relativeLuminance(color: string): number {
  const values = [1, 3, 5].map((offset) => Number.parseInt(color.slice(offset, offset + 2), 16) / 255);
  const [red, green, blue] = values.map((value) =>
    value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  );
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}
