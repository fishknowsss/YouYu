import { describe, expect, it } from 'vitest';
import { IpcArgumentError, parseIpcArguments } from '../../src/main/ipcSchemas';
import { ipcChannels } from '../../src/shared/ipc';

describe('IPC argument schemas', () => {
  it('accepts and normalizes supported arguments', () => {
    expect(parseIpcArguments(ipcChannels.selectNode, ['  Node A  '])).toEqual(['Node A']);
    expect(parseIpcArguments(ipcChannels.stopPetDrag, [undefined])).toEqual([undefined]);
    expect(parseIpcArguments(ipcChannels.start, [{ requestId: 'request-123' }])).toEqual([
      { requestId: 'request-123' }
    ]);
    expect(
      parseIpcArguments(ipcChannels.saveSettings, [
        {
          mode: 'rule',
          strategy: 'auto',
          ruleProfile: 'ruleset',
          subscriptionRefreshIntervalHours: 12,
          remoteSubscriptionUrl: null,
          petWindow: { x: 10.4, y: -20.6 }
        },
        { requestId: 'request-456' }
      ])
    ).toEqual([
      {
        mode: 'rule',
        strategy: 'auto',
        ruleProfile: 'ruleset',
        subscriptionRefreshIntervalHours: 12,
        remoteSubscriptionUrl: null,
        petWindow: { x: 10, y: -21 }
      },
      { requestId: 'request-456' }
    ]);
  });

  it('rejects extra arguments and arguments on no-argument routes', () => {
    expect(() => parseIpcArguments(ipcChannels.getSnapshot, ['unexpected'])).toThrow(IpcArgumentError);
    expect(() => parseIpcArguments(ipcChannels.selectNode, ['Node A', 'unexpected'])).toThrow(IpcArgumentError);
  });

  it('rejects coercible primitives, unknown object fields, and malformed request ids', () => {
    expect(() => parseIpcArguments(ipcChannels.setPetMousePassthrough, [1])).toThrow(/passthrough/);
    expect(() => parseIpcArguments(ipcChannels.start, [{ requestId: 'short' }])).toThrow(/requestId/);
    expect(() => parseIpcArguments(ipcChannels.saveSettings, [new Date()])).toThrow(/settings/);
    expect(() =>
      parseIpcArguments(ipcChannels.registerTrafficIdentity, [{ name: 'Alice', passphrase: 'secret', elevated: true }])
    ).toThrow(/registration/);
  });

  it('bounds text, coordinates, settings intervals, and route enums', () => {
    expect(() => parseIpcArguments(ipcChannels.testNode, ['A'.repeat(257)])).toThrow(/name/);
    expect(() => parseIpcArguments(ipcChannels.selectStrategy, ['fastest'])).toThrow(/strategy/);
    expect(() => parseIpcArguments(ipcChannels.testConnectivity, ['unknown'])).toThrow(/key/);
    expect(() => parseIpcArguments(ipcChannels.saveSettings, [{ subscriptionRefreshIntervalHours: 3 }])).toThrow(
      /subscriptionRefreshIntervalHours/
    );
    expect(() => parseIpcArguments(ipcChannels.saveSettings, [{ petWindow: { x: Infinity, y: 0 } }])).toThrow(
      /petWindow.x/
    );
  });

  it('rejects unknown channels so newly added routes fail closed until a schema exists', () => {
    expect(() => parseIpcArguments('youyu:unknown', [])).toThrow(/channel/);
  });
});
