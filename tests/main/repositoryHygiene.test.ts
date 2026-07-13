import { describe, expect, it } from 'vitest';
import { findForbiddenTrackedPaths, keepExistingTrackedPaths } from '../../scripts/validate-repository-hygiene.mjs';

describe('repository hygiene', () => {
  it('rejects local state, generated output, private subscriptions, and agent files', () => {
    const findings = findForbiddenTrackedPaths([
      'cloudflare/youyu-traffic/.wrangler/state/local.sqlite',
      'scripts/__pycache__/assets.cpython-312.pyc',
      'release/YouYu-1.0.0-x64.exe',
      'release-archive/YouYu-1.0.0-x64.exe',
      'resources/default-subscription.in.txt',
      '.env.production',
      'cloudflare/youyu-traffic/.dev.vars',
      '.codex/local-state.json',
      'debug.log'
    ]);

    expect(findings.map((finding) => finding.path)).toEqual([
      'cloudflare/youyu-traffic/.wrangler/state/local.sqlite',
      'scripts/__pycache__/assets.cpython-312.pyc',
      'release/YouYu-1.0.0-x64.exe',
      'release-archive/YouYu-1.0.0-x64.exe',
      'resources/default-subscription.in.txt',
      '.env.production',
      'cloudflare/youyu-traffic/.dev.vars',
      '.codex/local-state.json',
      'debug.log'
    ]);
  });

  it('allows source, docs, the public empty-subscription path, and the bundled Mihomo runtime', () => {
    expect(
      findForbiddenTrackedPaths([
        'src/main/index.ts',
        'docs/release-packaging.md',
        'resources/default-subscription.txt',
        'resources/mihomo/win-x64/mihomo.exe'
      ])
    ).toEqual([]);
  });

  it('does not block validation on tracked files already deleted from the working tree', () => {
    const existing = new Set(['src/main/index.ts']);

    expect(
      keepExistingTrackedPaths(['src/main/index.ts', 'cloudflare/youyu-traffic/.wrangler/state.sqlite'], (path) =>
        existing.has(path)
      )
    ).toEqual(['src/main/index.ts']);
  });
});
