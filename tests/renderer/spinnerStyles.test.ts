import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { readRendererStyles } from './helpers/rendererStyles';

describe('spinner animation styles', () => {
  it.each(['.busy-spinner', '.registration-spinner'])('%s renders the animated ring angle', async (selector) => {
    const styles = await readRendererStyles();
    const start = styles.indexOf(`${selector} {`);
    const end = styles.indexOf('\n}', start);
    const rule = styles.slice(start, end);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(rule).toContain('from var(--ring-angle)');
    expect(rule).toContain('animation: startup-ring-spin');
  });

  it('keeps update-install feedback visibly animated during the silent handoff', async () => {
    const styles = await readRendererStyles();
    const start = styles.indexOf('.update-activity-spinner {');
    const end = styles.indexOf('\n}', start);
    const rule = styles.slice(start, end);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(rule).toContain('color: var(--accent);');
    expect(rule).toContain('from var(--ring-angle)');
    expect(rule).toContain('animation: startup-ring-spin');
  });

  it('owns the shared update spinner and ring animation outside page-specific styles', async () => {
    const [shellStyles, testStyles, petStyles] = await Promise.all([
      readFile('src/renderer/styles/shell.css', 'utf8'),
      readFile('src/renderer/styles/test.css', 'utf8'),
      readFile('src/renderer/styles/pet.css', 'utf8')
    ]);

    expect(shellStyles).toContain('.update-activity-spinner {');
    expect(shellStyles).toContain('@keyframes startup-ring-spin {');
    expect(shellStyles).toContain('@media (prefers-reduced-motion: reduce) {');
    expect(shellStyles).toContain('animation-duration: 0.01ms !important;');
    expect(shellStyles).toContain('animation-iteration-count: 1 !important;');
    expect(testStyles).not.toContain('.update-activity-spinner {');
    expect(testStyles).not.toContain('@media (prefers-reduced-motion: reduce) {');
    expect(petStyles).not.toContain('@keyframes startup-ring-spin {');
  });

  it('keeps update activity attached to the action affordance instead of the left edge of either component', async () => {
    const [settingsStyles, homeStyles] = await Promise.all([
      readFile('src/renderer/styles/settings.css', 'utf8'),
      readFile('src/renderer/styles/home.css', 'utf8')
    ]);

    expect(settingsStyles).toContain('.update-action-group {');
    expect(settingsStyles).toContain('justify-content: flex-end;');
    expect(settingsStyles).toContain('.update-action-group .settings-footer-action {');
    expect(settingsStyles).toContain('.update-row.has-update-activity {');
    expect(settingsStyles).toContain('calc(var(--settings-action-width) + 22px)');
    expect(settingsStyles).not.toContain('.update-row > .update-activity-spinner {');
    expect(homeStyles).toContain('.easy-update-action {');
    expect(homeStyles).toContain('grid-area: action;');
    expect(homeStyles).not.toContain('.easy-update-notice > .update-activity-spinner {');
  });
});
