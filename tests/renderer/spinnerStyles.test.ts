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

  it('gives the easy connection status distinct active, success, shutdown, off, and failure motion states', async () => {
    const [homeStyles, petStyles, homeSource] = await Promise.all([
      readFile('src/renderer/styles/home.css', 'utf8'),
      readFile('src/renderer/styles/pet.css', 'utf8'),
      readFile('src/renderer/pages/Home.tsx', 'utf8')
    ]);

    expect(homeSource).toContain('<EasyConnectionFeedback phase={connectionPhase} />');
    expect(homeSource).not.toContain('startup-ring');
    expect(homeStyles).toContain('.easy-connection-feedback.is-starting .easy-status-ring {');
    expect(homeStyles).toContain('animation: easy-status-orbit 880ms linear infinite;');
    expect(homeStyles).toContain('.easy-connection-feedback.is-running .easy-status-check {');
    expect(homeStyles).toContain('animation: easy-status-check-in 300ms cubic-bezier(0.16, 1, 0.3, 1) 140ms both;');
    expect(homeStyles).toContain('.easy-connection-feedback.is-stopping .easy-status-ring {');
    expect(homeStyles).toContain('animation: easy-status-orbit-reverse 720ms linear infinite;');
    expect(homeStyles).toContain('.easy-connection-feedback.is-stopped .easy-status-core {');
    expect(homeStyles).toContain('animation: easy-status-power-down 360ms cubic-bezier(0.4, 0, 1, 1) both;');
    expect(homeStyles).toContain('.easy-connection-feedback.is-failed .easy-status-alert,');
    expect(petStyles).not.toContain('.startup-ring {');
  });

  it('positions easy connection feedback independently from the unchanged power-button geometry', async () => {
    const homeStyles = await readFile('src/renderer/styles/home.css', 'utf8');
    const buttonStart = homeStyles.indexOf('.easy-power-button {');
    const buttonEnd = homeStyles.indexOf('\n}', buttonStart);
    const buttonRule = homeStyles.slice(buttonStart, buttonEnd);
    const feedbackStart = homeStyles.indexOf('.easy-connection-feedback {');
    const feedbackEnd = homeStyles.indexOf('\n}', feedbackStart);
    const feedbackRule = homeStyles.slice(feedbackStart, feedbackEnd);

    expect(buttonRule).toContain('width: 204px;');
    expect(buttonRule).toContain('height: 226px;');
    expect(feedbackStart).toBeGreaterThanOrEqual(0);
    expect(feedbackRule).toContain('position: absolute;');
    expect(feedbackRule).toContain('pointer-events: none;');
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
