import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { developmentRendererCsp, productionRendererCsp, resolveRendererCsp } from '../../scripts/renderer-csp';
import { findUnpinnedGitHubActions } from '../../scripts/validate-repository-hygiene.mjs';

describe('build security boundaries', () => {
  it('keeps development loopback transports out of the production renderer CSP', async () => {
    const html = await readFile('index.html', 'utf8');
    const electronVite = await readFile('electron.vite.config.ts', 'utf8');
    const browserVite = await readFile('vite.config.ts', 'utf8');

    expect(productionRendererCsp).toContain("connect-src 'self'");
    expect(productionRendererCsp).not.toMatch(/localhost|127\.0\.0\.1|ws:/);
    expect(developmentRendererCsp).toContain('http://127.0.0.1:*');
    expect(developmentRendererCsp).toContain('ws://127.0.0.1:*');
    expect(resolveRendererCsp('build')).toBe(productionRendererCsp);
    expect(resolveRendererCsp('serve')).toBe(developmentRendererCsp);
    expect(html).toContain('__YOUYU_RENDERER_CSP__');
    expect(electronVite).toContain('createRendererCspPlugin()');
    expect(browserVite).toContain('createRendererCspPlugin()');
  });

  it('rejects mutable GitHub Action tags while allowing full commit SHAs and local actions', () => {
    expect(
      findUnpinnedGitHubActions([
        {
          path: '.github/workflows/validate.yml',
          source: [
            'steps:',
            '  - uses: actions/checkout@v6',
            '  - uses: actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38 # v6.5.0',
            '  - uses: ./github/actions/local'
          ].join('\n')
        }
      ])
    ).toEqual([
      {
        path: '.github/workflows/validate.yml',
        line: 2,
        action: 'actions/checkout@v6'
      }
    ]);
  });

  it('keeps Windows timestamp and publisher settings inside the supported signtool schema', async () => {
    const builder = await readFile('electron-builder.yml', 'utf8');
    const runner = await readFile('scripts/run-electron-builder.mjs', 'utf8');

    expect(builder).toContain('  signtoolOptions:\n    timeStampServer:');
    expect(builder).toContain('    rfc3161TimeStampServer:');
    expect(builder).not.toMatch(/^ {2}(?:timeStampServer|rfc3161TimeStampServer):/m);
    expect(runner).toContain('-c.win.signtoolOptions.publisherName=');
    expect(runner).not.toContain('-c.win.publisherName=');
  });
});
