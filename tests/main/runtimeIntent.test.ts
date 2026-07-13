import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { createRuntimeIntentController } from '../../src/main/runtimeIntent';

describe('createRuntimeIntentController', () => {
  it('invalidates background recovery work when stop is requested', () => {
    const intent = createRuntimeIntentController();
    const generation = intent.requestStart();

    expect(intent.isCurrent(generation)).toBe(true);
    intent.cancel();

    expect(intent.capture()).toBeUndefined();
    expect(intent.isCurrent(generation)).toBe(false);
  });

  it('lets a newer start supersede stale in-flight start work', () => {
    const intent = createRuntimeIntentController();
    const stale = intent.requestStart();
    const current = intent.requestStart();

    expect(intent.isCurrent(stale)).toBe(false);
    expect(intent.isCurrent(current)).toBe(true);
    expect(intent.capture()).toBe(current);
  });

  it('does not create a user start intent until the registration guard passes', async () => {
    const source = await readFile('src/main/index.ts', 'utf8');
    const startProxy = source.slice(
      source.indexOf('async function startProxy'),
      source.indexOf('async function selectBestAutoNode')
    );

    expect(startProxy.indexOf('await requireTrafficIdentity()')).toBeLessThan(
      startProxy.indexOf('requestedIntentGeneration ?? runtimeIntent.requestStart()')
    );
  });
});
