import { describe, expect, it, vi } from 'vitest';
import {
  resolveUpdateRelaunchAcknowledgementRequest,
  stripUpdateRelaunchAcknowledgementArguments,
  updateRelaunchAcknowledgementNonceArgument,
  updateRelaunchAcknowledgementPathArgument,
  writeUpdateRelaunchAcknowledgement
} from '../../src/main/updateRelaunchAcknowledgement';

const nonce = '8fb748f0-540a-4f7a-9bd2-144020b83e9b';
const path = String.raw`C:\Users\Example\AppData\Local\Temp\youyu-update-relaunch-8fb748f0-540a-4f7a-9bd2-144020b83e9b.ready.json`;
const environment = { LOCALAPPDATA: String.raw`C:\Users\Example\AppData\Local` };

describe('update relaunch acknowledgement', () => {
  it('accepts only the nonce-bound acknowledgement path in the current user temp directory', () => {
    expect(
      resolveUpdateRelaunchAcknowledgementRequest(
        [updateRelaunchAcknowledgementPathArgument, path, updateRelaunchAcknowledgementNonceArgument, nonce],
        environment
      )
    ).toEqual({ path, nonce });

    expect(
      resolveUpdateRelaunchAcknowledgementRequest(
        [
          updateRelaunchAcknowledgementPathArgument,
          String.raw`C:\Users\Other\AppData\Local\Temp\youyu-update-relaunch-8fb748f0-540a-4f7a-9bd2-144020b83e9b.ready.json`,
          updateRelaunchAcknowledgementNonceArgument,
          nonce
        ],
        environment
      )
    ).toBeUndefined();
    expect(
      resolveUpdateRelaunchAcknowledgementRequest(
        [updateRelaunchAcknowledgementPathArgument, path, updateRelaunchAcknowledgementPathArgument, path],
        environment
      )
    ).toBeUndefined();
  });

  it('overwrites only a supervisor-created challenge with the authenticated ready record', async () => {
    const writeFile = vi.fn(
      async (_path: string, _contents: string, _options: { encoding: 'utf8'; flag: 'r+' }) => undefined
    );

    await writeUpdateRelaunchAcknowledgement(
      { path, nonce },
      {
        appVersion: '1.7.7',
        environment,
        executablePath: String.raw`C:\Program Files\YouYu\YouYu.exe`,
        processId: 4242,
        now: () => 1_800_000_000_000,
        resolveUserIdentity: async () => ({
          userSid: 'S-1-5-21-100-200-300-1001',
          sessionId: 7
        }),
        writeFile
      }
    );

    expect(writeFile).toHaveBeenCalledOnce();
    expect(writeFile.mock.calls[0]?.[0]).toBe(path);
    expect(writeFile.mock.calls[0]?.[2]).toEqual({ encoding: 'utf8', flag: 'r+' });
    expect(JSON.parse(String(writeFile.mock.calls[0]?.[1]))).toEqual({
      version: 1,
      nonce,
      appVersion: '1.7.7',
      executablePath: String.raw`C:\Program Files\YouYu\YouYu.exe`,
      processId: 4242,
      targetUserSid: 'S-1-5-21-100-200-300-1001',
      targetSessionId: 7,
      readyAtEpochMs: 1_800_000_000_000
    });
  });

  it('removes acknowledgement flags and their values from later application relaunches', () => {
    expect(
      stripUpdateRelaunchAcknowledgementArguments([
        'out/main/index.js',
        '--hidden',
        updateRelaunchAcknowledgementPathArgument,
        path,
        updateRelaunchAcknowledgementNonceArgument,
        nonce,
        '--another'
      ])
    ).toEqual(['out/main/index.js', '--hidden', '--another']);
  });
});
