import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('traffic identity runtime handoff', () => {
  it('advances runtime intent and queues a restart after syncing a changed identity', async () => {
    const source = await readFile('src/main/index.ts', 'utf8');
    const registration = source.slice(
      source.indexOf('async function registerTrafficIdentity'),
      source.indexOf('async function cancelProxyStart')
    );
    const changedIdentityBranch = registration.slice(
      registration.indexOf('if (identityChanged)'),
      registration.indexOf("} else if (lifecycle.getStatus() === 'running')")
    );

    expect(registration).toContain('const identityChanged =');
    expect(changedIdentityBranch).toContain('const activeIntentGeneration = runtimeIntent.capture()');
    expect(changedIdentityBranch.indexOf('runtimeIntent.requestStart()')).toBeLessThan(
      changedIdentityBranch.indexOf('await syncRemoteConfig')
    );
    expect(changedIdentityBranch.indexOf('await syncRemoteConfig')).toBeLessThan(
      changedIdentityBranch.indexOf('await restartLifecycleForIntent(newIntentGeneration)')
    );
    expect(changedIdentityBranch).not.toContain("lifecycle.getStatus() === 'running'");
    expect(registration).toContain("} else if (lifecycle.getStatus() === 'running')");
  });

  it('routes the identity handoff restart through the serialized lifecycle controller', async () => {
    const source = await readFile('src/main/index.ts', 'utf8');
    const restart = source.slice(
      source.indexOf('async function restartLifecycleForIntent'),
      source.indexOf('function runtimeActionsForIntent')
    );

    expect(restart).toContain('await lifecycle.restart(signal)');
    expect(restart).toContain('throwIfRuntimeIntentCanceled(intentGeneration)');
  });
});
