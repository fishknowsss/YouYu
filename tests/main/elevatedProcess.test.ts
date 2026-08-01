import { spawnSync } from 'node:child_process';
import { EventEmitter, getEventListeners } from 'node:events';
import { win32 } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  ELEVATED_PIPE_CONTROL_MAX_BYTES,
  ELEVATED_PIPE_PROTOCOL_VERSION,
  ElevatedPipeFrameDecoder,
  buildElevatedProcessScript,
  createElevatedPipeChallenge,
  createElevatedPipeClientProtocol,
  encodeCompressedPowerShellCommand,
  encodeElevatedPipeFrame,
  runWindowsElevatedProcess,
  spawnWindowsElevatedProcess,
  type ElevatedPipeBinding
} from '../../src/main/platform/elevatedProcess';

const binding: ElevatedPipeBinding = {
  operationId: '087cba98-7f23-4a62-83d1-1a3c0c6f38c4',
  targetUserSid: 'S-1-5-21-1000-2000-3000-1001',
  targetSessionId: 3,
  parentPid: 1234,
  parentExecutablePath: 'C:\\Program Files\\YouYu\\YouYu.exe',
  binaryPath: 'C:\\Program Files\\YouYu\\resources\\mihomo.exe'
};
const clientChallenge = 'ERERERERERERERERERERERERERERERERERERERERERE';
const serverChallenge = 'IiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiI';

function serverMessage(kind: string, extra: Record<string, unknown> = {}) {
  return {
    version: ELEVATED_PIPE_PROTOCOL_VERSION,
    kind,
    binding,
    clientChallenge,
    serverChallenge,
    ...extra
  };
}

function extractNativeSource(script: string): string {
  const match = /\$nativeSource = @'\r?\n([\s\S]*?)\r?\n'@/.exec(script);
  if (!match) throw new Error('missing encoded native source');
  return match[1];
}

function createStalledLauncher() {
  const launcher = new EventEmitter() as EventEmitter & {
    exitCode: number | null;
    killed: boolean;
    kill: ReturnType<typeof vi.fn>;
  };
  launcher.exitCode = null;
  launcher.killed = false;
  launcher.kill = vi.fn(() => {
    launcher.killed = true;
    return true;
  });
  return launcher;
}

function createStalledPipeConnection() {
  const pipe = new EventEmitter() as EventEmitter & {
    destroyed: boolean;
    destroy: ReturnType<typeof vi.fn>;
    write: ReturnType<typeof vi.fn>;
  };
  pipe.destroyed = false;
  pipe.destroy = vi.fn(() => {
    pipe.destroyed = true;
    return pipe;
  });
  pipe.write = vi.fn(() => true);
  return pipe;
}

function decodeSingleFrame(frame: Buffer): Record<string, unknown> {
  const messages = new ElevatedPipeFrameDecoder(ELEVATED_PIPE_CONTROL_MAX_BYTES).push(frame);
  expect(messages).toHaveLength(1);
  return messages[0] as Record<string, unknown>;
}

async function waitForImmediate(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe('elevated process named-pipe protocol', () => {
  it('executes a compressed helper without approaching the Windows command-line limit', () => {
    const command = encodeCompressedPowerShellCommand("[Console]::Write('compressed-helper-ok')");

    expect(command.length).toBeLessThan(28_000);
    const executed = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', command], {
      encoding: 'utf8',
      windowsHide: true
    });
    expect(executed.status, executed.stderr).toBe(0);
    expect(executed.stdout).toBe('compressed-helper-ok');
  });

  it('requires a fresh 256-bit challenge for each direction', () => {
    const randomBytes = vi.fn((size: number) => Buffer.alloc(size, 0xa5));

    const challenge = createElevatedPipeChallenge(randomBytes);

    expect(randomBytes).toHaveBeenCalledExactlyOnceWith(32);
    expect(Buffer.from(challenge, 'base64url')).toHaveLength(32);
  });

  it('authenticates both peers before sending a start request', () => {
    const protocol = createElevatedPipeClientProtocol({
      binding,
      clientChallenge,
      canceled: false,
      mihomoConfig: 'mixed-port: 7890'
    });

    expect(protocol.state).toBe('awaiting-server-challenge');
    expect(
      protocol.receive({
        version: ELEVATED_PIPE_PROTOCOL_VERSION,
        kind: 'server-challenge',
        binding,
        serverChallenge
      })
    ).toEqual(serverMessage('client-authenticate'));
    expect(protocol.state).toBe('awaiting-server-authentication');
    expect(protocol.receive(serverMessage('server-authenticated'))).toEqual({
      ...serverMessage('start'),
      canceled: false,
      config: Buffer.from('mixed-port: 7890', 'utf8').toString('base64')
    });
    expect(protocol.state).toBe('awaiting-ready');
    expect(protocol.receive(serverMessage('ready', { pid: 4321 }))).toBeUndefined();
    expect(protocol.state).toBe('running');
    expect(protocol.createStopMessage()).toEqual(serverMessage('stop'));
    expect(protocol.receive(serverMessage('exit', { code: 0 }))).toEqual({ code: 0 });
    expect(protocol.state).toBe('exited');
  });

  it.each([
    ['protocol downgrade', { version: ELEVATED_PIPE_PROTOCOL_VERSION - 1 }],
    ['operation substitution', { binding: { ...binding, operationId: 'other-operation' } }],
    ['user substitution', { binding: { ...binding, targetUserSid: 'S-1-5-21-9-9-9-1001' } }],
    ['session substitution', { binding: { ...binding, targetSessionId: 8 } }],
    ['parent substitution', { binding: { ...binding, parentPid: 9876 } }],
    ['install path substitution', { binding: { ...binding, parentExecutablePath: 'C:\\Temp\\YouYu.exe' } }]
  ])('fails closed on %s', (_label, mutation) => {
    const protocol = createElevatedPipeClientProtocol({ binding, clientChallenge, canceled: false });

    expect(() =>
      protocol.receive({
        version: ELEVATED_PIPE_PROTOCOL_VERSION,
        kind: 'server-challenge',
        binding,
        serverChallenge,
        ...mutation
      })
    ).toThrow(/protocol/i);
    expect(protocol.state).toBe('failed');
  });

  it('rejects replayed and out-of-order messages', () => {
    const protocol = createElevatedPipeClientProtocol({ binding, clientChallenge, canceled: false });
    const challenge = {
      version: ELEVATED_PIPE_PROTOCOL_VERSION,
      kind: 'server-challenge',
      binding,
      serverChallenge
    };

    protocol.receive(challenge);

    expect(() => protocol.receive(challenge)).toThrow(/state/i);
    expect(protocol.state).toBe('failed');
  });

  it('rejects an invalid server proof after the client has authenticated', () => {
    const protocol = createElevatedPipeClientProtocol({ binding, clientChallenge, canceled: false });
    protocol.receive({
      version: ELEVATED_PIPE_PROTOCOL_VERSION,
      kind: 'server-challenge',
      binding,
      serverChallenge
    });

    expect(() => protocol.receive(serverMessage('server-authenticated', { clientChallenge: 'wrong-proof' }))).toThrow(
      /protocol/i
    );
    expect(protocol.state).toBe('failed');
  });

  it('bounds framed messages before allocating or parsing payloads', () => {
    expect(() => encodeElevatedPipeFrame({ value: 'x'.repeat(256) }, 64)).toThrow(/limit/i);

    const decoder = new ElevatedPipeFrameDecoder(64);
    const oversizedHeader = Buffer.alloc(4);
    oversizedHeader.writeUInt32LE(65);
    expect(() => decoder.push(oversizedHeader)).toThrow(/limit/i);
  });

  it('buffers a split frame and rejects trailing bytes after a complete control message', () => {
    const frame = encodeElevatedPipeFrame({ kind: 'test' }, ELEVATED_PIPE_CONTROL_MAX_BYTES);
    const decoder = new ElevatedPipeFrameDecoder(ELEVATED_PIPE_CONTROL_MAX_BYTES);

    expect(decoder.push(frame.subarray(0, 3))).toEqual([]);
    expect(decoder.push(frame.subarray(3))).toEqual([{ kind: 'test' }]);

    const malformed = Buffer.concat([frame, Buffer.from([1, 0, 0, 0, 0xff])]);
    const strictDecoder = new ElevatedPipeFrameDecoder(ELEVATED_PIPE_CONTROL_MAX_BYTES, 1);
    expect(() => strictDecoder.push(malformed)).toThrow(/unexpected/i);
  });
});

describe('elevated mihomo process script', () => {
  it('binds an ACL-restricted pipe, authenticated parent identity, byte limits, and a kill-on-close job', () => {
    const script = buildElevatedProcessScript({
      binaryPath: `C:\\Program Files\\YouYu\\mihomo'quoted.exe`,
      args: ['-d', 'C:\\Users\\测试 用户\\mihomo', '-f', 'config.yaml'],
      pipeName: 'youyu-elevated-test',
      binding,
      clientChallenge,
      pollIntervalMs: 250,
      receivesMihomoConfig: true
    });

    expect(script).not.toContain("mihomo'quoted.exe");
    expect(script).not.toContain('测试 用户');
    expect(script).toContain('NamedPipeServerStream');
    expect(script).toContain('PipeSecurity');
    expect(script).toContain('S-1-5-32-544');
    expect(script).toContain('S-1-5-18');
    expect(script).toContain(binding.targetUserSid);
    expect(script).toContain('SetAccessRuleProtection($true, $false)');
    expect(script).toContain('WaitForConnectionAsync');
    expect(script).toContain('Read-FrameWithTimeout');
    expect(script).toContain('Assert-ProtocolBinding');
    expect(script).toContain('Win32_Process');
    expect(script).toContain('GetOwnerSid');
    expect(script).toContain('JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE');
    const nativeSource = extractNativeSource(script);
    expect(nativeSource).toContain('AssignProcessToJobObject');
    expect(nativeSource).toContain('CREATE_SUSPENDED');
    expect(nativeSource).toContain('ResumeThread');
    expect(script).toContain('SetInformationJobObject');
    expect(script).toContain('SetAccessControl($secureWorkDir, $acl)');
    expect(script).not.toContain('NamedPipeClientStream');
    expect(script).not.toContain("$readTask.Result -eq 'STOP'");
    const startInvocation = script.lastIndexOf(
      '$process = [YouYu.WindowsJobNative]::StartProcessSuspendedAndAssignToJobObject'
    );
    expect(script.indexOf("Assert-AuthenticatedMessage $request 'start'")).toBeLessThan(startInvocation);
    expect(startInvocation).toBeLessThan(script.indexOf("kind = 'ready'"));

    const compressedCommand = encodeCompressedPowerShellCommand(script);
    expect(compressedCommand.length).toBeLessThan(28_000);
    const compressedBootstrap = Buffer.from(compressedCommand, 'base64').toString('utf16le');
    expect(compressedBootstrap).toContain('GZipStream');

    const parsed = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', '[ScriptBlock]::Create([Console]::In.ReadToEnd()) | Out-Null'],
      { encoding: 'utf8', input: script, windowsHide: true }
    );
    expect(parsed.status, `${parsed.error?.message ?? ''}\n${parsed.stderr}`).toBe(0);
  });
});

describe('managed elevated process cancellation', () => {
  it('binds a trusted bare PowerShell command to the absolute System32 executable', async () => {
    const launcher = createStalledLauncher();
    const pipe = createStalledPipeConnection();
    let pipePath = '';
    const elevated = spawnWindowsElevatedProcess('powershell.exe', [], {
      resolveUserIdentity: async () => ({ userSid: binding.targetUserSid, sessionId: binding.targetSessionId }),
      spawnLauncher: vi.fn(() => launcher as never),
      createPipeConnection: vi.fn((path: string) => {
        pipePath = path;
        return pipe as never;
      })
    });
    const error = vi.fn();
    elevated.once('error', error);
    await vi.waitFor(() => expect(pipePath).not.toBe(''));

    const operationId = /([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/i.exec(pipePath)?.[1];
    expect(operationId).toBeDefined();
    const runtimeBinding: ElevatedPipeBinding = {
      operationId: operationId as string,
      targetUserSid: binding.targetUserSid,
      targetSessionId: binding.targetSessionId,
      parentPid: process.pid,
      parentExecutablePath: win32.resolve(process.execPath),
      binaryPath: win32.join(
        process.env.SystemRoot ?? 'C:\\Windows',
        'System32',
        'WindowsPowerShell',
        'v1.0',
        'powershell.exe'
      )
    };

    pipe.emit('connect');
    pipe.emit(
      'data',
      encodeElevatedPipeFrame(
        {
          version: ELEVATED_PIPE_PROTOCOL_VERSION,
          kind: 'server-challenge',
          binding: runtimeBinding,
          serverChallenge
        },
        ELEVATED_PIPE_CONTROL_MAX_BYTES
      )
    );

    expect(error).not.toHaveBeenCalled();
    expect(decodeSingleFrame(pipe.write.mock.calls[0][0] as Buffer)).toMatchObject({
      kind: 'client-authenticate',
      binding: runtimeBinding
    });
    expect(elevated.kill()).toBe(true);
  });

  it('does not misreport an elevated launcher failure as missing administrator rights', async () => {
    const launcher = createStalledLauncher();
    const pipe = createStalledPipeConnection();
    const elevated = spawnWindowsElevatedProcess('C:\\Windows\\System32\\cmd.exe', ['/c', 'exit', '7'], {
      resolveUserIdentity: async () => ({ userSid: binding.targetUserSid, sessionId: binding.targetSessionId }),
      spawnLauncher: vi.fn(() => launcher as never),
      createPipeConnection: vi.fn(() => pipe as never)
    });
    const failure = new Promise<Error>((resolve) => elevated.once('error', resolve));
    await vi.waitFor(() => expect(launcher.listenerCount('exit')).toBe(1));

    launcher.exitCode = 7;
    launcher.emit('exit', 7, null);

    await expect(failure).resolves.toMatchObject({
      message: expect.stringContaining('退出码 7')
    });
    await expect(failure).resolves.not.toMatchObject({
      message: expect.stringContaining('需要管理员权限')
    });
  });

  it('settles and disposes a stalled launcher immediately when killed before the pipe connects', async () => {
    const launcher = createStalledLauncher();
    const pipe = createStalledPipeConnection();
    const spawnLauncher = vi.fn(() => launcher as never);
    const createPipeConnection = vi.fn(() => pipe as never);
    const elevated = spawnWindowsElevatedProcess('C:\\Program Files\\YouYu\\helper.exe', [], {
      resolveUserIdentity: async () => ({ userSid: binding.targetUserSid, sessionId: binding.targetSessionId }),
      spawnLauncher,
      createPipeConnection
    });
    const exit = vi.fn();
    const error = vi.fn();
    elevated.once('exit', exit);
    elevated.once('error', error);
    await vi.waitFor(() => expect(spawnLauncher).toHaveBeenCalledOnce());

    const firstKill = elevated.kill();
    const secondKill = elevated.kill();
    await waitForImmediate();
    const immediateExitCount = exit.mock.calls.length;
    if (immediateExitCount === 0) launcher.emit('exit', 1, null);
    pipe.emit('connect');
    pipe.emit('error', Object.assign(new Error('late pipe failure'), { code: 'ENOENT' }));
    await waitForImmediate();

    expect(firstKill).toBe(true);
    expect(secondKill).toBe(false);
    expect(immediateExitCount).toBe(1);
    expect(exit).toHaveBeenCalledExactlyOnceWith(0, null);
    expect(error).not.toHaveBeenCalled();
    expect(launcher.kill).toHaveBeenCalledOnce();
    expect(createPipeConnection).toHaveBeenCalledOnce();
    expect(pipe.destroy).toHaveBeenCalledOnce();
    expect(launcher.listenerCount('error')).toBe(0);
    expect(launcher.listenerCount('exit')).toBe(0);
  });

  it('rejects an aborted stalled launch immediately with the abort reason', async () => {
    const launcher = createStalledLauncher();
    const pipe = createStalledPipeConnection();
    const spawnLauncher = vi.fn(() => launcher as never);
    const createPipeConnection = vi.fn(() => pipe as never);
    const controller = new AbortController();
    const reason = new Error('operation canceled');
    const operation = runWindowsElevatedProcess('C:\\Program Files\\YouYu\\helper.exe', [], {
      signal: controller.signal,
      resolveUserIdentity: async () => ({ userSid: binding.targetUserSid, sessionId: binding.targetSessionId }),
      spawnLauncher,
      createPipeConnection
    });
    let settled = false;
    void operation.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );
    await vi.waitFor(() => expect(spawnLauncher).toHaveBeenCalledOnce());

    controller.abort(reason);
    await waitForImmediate();
    const settledImmediately = settled;
    if (!settledImmediately) launcher.emit('exit', 1, null);
    const rejection = await operation.catch((error: unknown) => error);

    expect(settledImmediately).toBe(true);
    expect(rejection).toBe(reason);
    expect(launcher.kill).toHaveBeenCalledOnce();
    expect(pipe.destroy).toHaveBeenCalledOnce();
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });

  it('does not spawn a launcher when identity resolution completes after cancellation', async () => {
    let resolveIdentity: ((identity: { userSid: string; sessionId: number }) => void) | undefined;
    const identity = new Promise<{ userSid: string; sessionId: number }>((resolve) => {
      resolveIdentity = resolve;
    });
    const spawnLauncher = vi.fn();
    const createPipeConnection = vi.fn();
    const elevated = spawnWindowsElevatedProcess('C:\\Program Files\\YouYu\\helper.exe', [], {
      resolveUserIdentity: () => identity,
      spawnLauncher: spawnLauncher as never,
      createPipeConnection: createPipeConnection as never
    });
    const exit = vi.fn();
    elevated.once('exit', exit);

    expect(elevated.kill()).toBe(true);
    const immediateExitCount = exit.mock.calls.length;
    resolveIdentity?.({ userSid: binding.targetUserSid, sessionId: binding.targetSessionId });
    await waitForImmediate();

    expect(immediateExitCount).toBe(1);
    expect(exit).toHaveBeenCalledExactlyOnceWith(0, null);
    expect(spawnLauncher).not.toHaveBeenCalled();
    expect(createPipeConnection).not.toHaveBeenCalled();
    expect(elevated.kill()).toBe(false);
  });

  it('settles immediately when the pipe connects but authentication never starts', async () => {
    const launcher = createStalledLauncher();
    const pipe = createStalledPipeConnection();
    const createPipeConnection = vi.fn(() => pipe as never);
    const elevated = spawnWindowsElevatedProcess('C:\\Program Files\\YouYu\\helper.exe', [], {
      resolveUserIdentity: async () => ({ userSid: binding.targetUserSid, sessionId: binding.targetSessionId }),
      spawnLauncher: vi.fn(() => launcher as never),
      createPipeConnection
    });
    const exit = vi.fn();
    elevated.once('exit', exit);
    await vi.waitFor(() => expect(createPipeConnection).toHaveBeenCalledOnce());
    pipe.emit('connect');

    expect(elevated.kill()).toBe(true);

    expect(exit).toHaveBeenCalledExactlyOnceWith(0, null);
    expect(pipe.destroy).toHaveBeenCalledOnce();
    expect(launcher.kill).toHaveBeenCalledOnce();
    expect(elevated.kill()).toBe(false);
  });

  it('keeps an authenticated connected process on the stop-and-exit protocol', async () => {
    const launcher = createStalledLauncher();
    const pipe = createStalledPipeConnection();
    const spawnLauncher = vi.fn(() => launcher as never);
    let pipePath = '';
    const createPipeConnection = vi.fn((path: string) => {
      pipePath = path;
      return pipe as never;
    });
    const binaryPath = 'C:\\Program Files\\YouYu\\helper.exe';
    const elevated = spawnWindowsElevatedProcess(binaryPath, [], {
      resolveUserIdentity: async () => ({ userSid: binding.targetUserSid, sessionId: binding.targetSessionId }),
      spawnLauncher,
      createPipeConnection
    });
    const exit = vi.fn();
    elevated.once('exit', exit);
    await vi.waitFor(() => expect(createPipeConnection).toHaveBeenCalledOnce());

    const operationId = /([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/i.exec(pipePath)?.[1];
    expect(operationId).toBeDefined();
    const runtimeBinding: ElevatedPipeBinding = {
      operationId: operationId as string,
      targetUserSid: binding.targetUserSid,
      targetSessionId: binding.targetSessionId,
      parentPid: process.pid,
      parentExecutablePath: win32.resolve(process.execPath),
      binaryPath: win32.resolve(binaryPath)
    };

    pipe.emit('connect');
    pipe.emit(
      'data',
      encodeElevatedPipeFrame(
        {
          version: ELEVATED_PIPE_PROTOCOL_VERSION,
          kind: 'server-challenge',
          binding: runtimeBinding,
          serverChallenge
        },
        ELEVATED_PIPE_CONTROL_MAX_BYTES
      )
    );
    const authentication = decodeSingleFrame(pipe.write.mock.calls[0][0] as Buffer);
    const runtimeClientChallenge = String(authentication.clientChallenge);
    pipe.emit(
      'data',
      encodeElevatedPipeFrame(
        {
          version: ELEVATED_PIPE_PROTOCOL_VERSION,
          kind: 'server-authenticated',
          binding: runtimeBinding,
          clientChallenge: runtimeClientChallenge,
          serverChallenge
        },
        ELEVATED_PIPE_CONTROL_MAX_BYTES
      )
    );
    expect(decodeSingleFrame(pipe.write.mock.calls[1][0] as Buffer)).toMatchObject({
      kind: 'start',
      canceled: false
    });
    pipe.emit(
      'data',
      encodeElevatedPipeFrame(
        {
          version: ELEVATED_PIPE_PROTOCOL_VERSION,
          kind: 'ready',
          binding: runtimeBinding,
          clientChallenge: runtimeClientChallenge,
          serverChallenge,
          pid: 4321
        },
        ELEVATED_PIPE_CONTROL_MAX_BYTES
      )
    );

    expect(elevated.kill()).toBe(true);
    expect(exit).not.toHaveBeenCalled();
    expect(launcher.kill).not.toHaveBeenCalled();
    expect(decodeSingleFrame(pipe.write.mock.calls[2][0] as Buffer)).toMatchObject({ kind: 'stop' });

    pipe.emit(
      'data',
      encodeElevatedPipeFrame(
        {
          version: ELEVATED_PIPE_PROTOCOL_VERSION,
          kind: 'exit',
          binding: runtimeBinding,
          clientChallenge: runtimeClientChallenge,
          serverChallenge,
          code: 0
        },
        ELEVATED_PIPE_CONTROL_MAX_BYTES
      )
    );

    expect(exit).toHaveBeenCalledExactlyOnceWith(0, null);
    expect(pipe.destroy).toHaveBeenCalledOnce();
    expect(launcher.kill).toHaveBeenCalledOnce();
    expect(elevated.kill()).toBe(false);
  });
});
