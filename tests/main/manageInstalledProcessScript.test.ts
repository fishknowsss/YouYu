import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const windowsIt = process.platform === 'win32' ? it : it.skip;
const executablePath = String.raw`C:\Program Files\YouYu\YouYu.exe`;
const targetUserSid = 'S-1-5-21-100-200-300-1001';
const targetSessionId = 7;
const nonce = '8fb748f0-540a-4f7a-9bd2-144020b83e9b';
const now = 1_800_000_000_000;

describe('manage-installed-process.ps1 user boundary', () => {
  windowsIt('accepts only exact-path processes from the authenticated SID and session', async () => {
    await withBoundaryFiles(
      [
        {
          processId: 4242,
          executablePath,
          ownerSid: targetUserSid,
          sessionId: targetSessionId
        }
      ],
      async ({ handoffPath, inventoryPath }) => {
        const result = await runVerify(handoffPath, inventoryPath);
        expect(result.stdout).toContain('"status":"verified"');
        const repeated = await runVerify(handoffPath, inventoryPath);
        expect(repeated.stdout).toContain('"status":"verified"');
        await expect(readFile(handoffPath, 'utf8')).resolves.toContain(nonce);
      }
    );
  });

  windowsIt('fails closed when an exact-path process belongs to another SID', async () => {
    await withBoundaryFiles(
      [
        {
          processId: 4242,
          executablePath,
          ownerSid: 'S-1-5-21-900-800-700-1002',
          sessionId: targetSessionId
        }
      ],
      async ({ handoffPath, inventoryPath }) => {
        await expect(runVerify(handoffPath, inventoryPath)).rejects.toMatchObject({
          stderr: expect.stringContaining('different user SID')
        });
      }
    );
  });

  windowsIt('fails closed when an exact-path process belongs to another session', async () => {
    await withBoundaryFiles(
      [
        {
          processId: 4242,
          executablePath,
          ownerSid: targetUserSid,
          sessionId: 11
        }
      ],
      async ({ handoffPath, inventoryPath }) => {
        await expect(runVerify(handoffPath, inventoryPath)).rejects.toMatchObject({
          stderr: expect.stringContaining('different Windows session')
        });
      }
    );
  });

  windowsIt('fails closed when a matching process has no authenticated handoff', async () => {
    await withBoundaryFiles(
      [
        {
          processId: 4242,
          executablePath,
          ownerSid: targetUserSid,
          sessionId: targetSessionId
        }
      ],
      async ({ inventoryPath }) => {
        await expect(
          runScript(['-Action', 'Verify', '-ExecutablePath', executablePath, '-ProcessInventoryPath', inventoryPath])
        ).rejects.toMatchObject({ stderr: expect.stringContaining('without an authenticated user handoff') });
      }
    );
  });

  windowsIt('rejects an expired handoff before trusting its process boundary', async () => {
    await withBoundaryFiles([], async ({ handoffPath, inventoryPath }) => {
      await expect(
        runScript([
          '-Action',
          'Verify',
          '-ExecutablePath',
          executablePath,
          '-HandoffPath',
          handoffPath,
          '-HandoffNonce',
          nonce,
          '-ExpectedUserSid',
          targetUserSid,
          '-ExpectedSessionId',
          String(targetSessionId),
          '-ProcessInventoryPath',
          inventoryPath,
          '-SkipFileOwnerCheck',
          '-CurrentTimeEpochMs',
          String(now + 900_001)
        ])
      ).rejects.toMatchObject({ stderr: expect.stringContaining('has expired') });
    });
  });

  windowsIt('does not permit injected process inventories in the mutating production action', async () => {
    await withBoundaryFiles([], async ({ handoffPath, inventoryPath }) => {
      await expect(
        runScript([
          '-Action',
          'WaitForExit',
          '-ExecutablePath',
          executablePath,
          '-HandoffPath',
          handoffPath,
          '-HandoffNonce',
          nonce,
          '-ExpectedUserSid',
          targetUserSid,
          '-ExpectedSessionId',
          String(targetSessionId),
          '-ProcessInventoryPath',
          inventoryPath,
          '-SkipFileOwnerCheck'
        ])
      ).rejects.toMatchObject({ stderr: expect.stringContaining('read-only Verify action') });
    });
  });

  windowsIt('validates the real owner SID of a temporary handoff file', async () => {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', '[Security.Principal.WindowsIdentity]::GetCurrent().User.Value'],
      { windowsHide: true }
    );
    const currentSid = String(stdout).trim().toUpperCase();
    if (['S-1-5-18', 'S-1-5-19', 'S-1-5-20'].includes(currentSid) || currentSid.endsWith('-500')) return;

    const directory = await mkdtemp(join(tmpdir(), 'youyu-owner-boundary-test-'));
    const handoffPath = join(directory, `youyu-update-handoff-${nonce}.json`);
    const inventoryPath = join(directory, 'processes.json');
    try {
      await writeFile(
        handoffPath,
        JSON.stringify({
          version: 1,
          nonce,
          targetUserSid: currentSid,
          targetSessionId,
          targetProcessId: 4242,
          executablePath,
          createdAtEpochMs: now,
          expiresAtEpochMs: now + 900_000
        }),
        'utf8'
      );
      await writeFile(inventoryPath, '[]', 'utf8');

      const result = await runScript([
        '-Action',
        'Verify',
        '-ExecutablePath',
        executablePath,
        '-HandoffPath',
        handoffPath,
        '-HandoffNonce',
        nonce,
        '-ExpectedUserSid',
        currentSid,
        '-ExpectedSessionId',
        String(targetSessionId),
        '-ProcessInventoryPath',
        inventoryPath,
        '-CurrentTimeEpochMs',
        String(now + 1_000)
      ]);
      expect(result.stdout).toContain('"status":"verified"');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  windowsIt(
    'keeps production validation repeatable and atomically consumes only after installation succeeds',
    async () => {
      const { stdout } = await execFileAsync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          '$identity = [Security.Principal.WindowsIdentity]::GetCurrent(); $session = (Get-Process -Id $PID).SessionId; [pscustomobject]@{ sid = $identity.User.Value; session = $session } | ConvertTo-Json -Compress'
        ],
        { windowsHide: true }
      );
      const current = JSON.parse(String(stdout)) as { sid: string; session: number };
      const currentSid = current.sid.toUpperCase();
      if (['S-1-5-18', 'S-1-5-19', 'S-1-5-20'].includes(currentSid) || currentSid.endsWith('-500')) return;

      const directory = await mkdtemp(join(tmpdir(), 'youyu-production-boundary-test-'));
      const uniqueExecutablePath = join(directory, 'YouYu.exe');
      const handoffPath = join(directory, `youyu-update-handoff-${nonce}.json`);
      const currentTime = Date.now();
      try {
        await writeFile(
          handoffPath,
          JSON.stringify({
            version: 1,
            nonce,
            targetUserSid: currentSid,
            targetSessionId: current.session,
            targetProcessId: 4242,
            executablePath: uniqueExecutablePath,
            createdAtEpochMs: currentTime,
            expiresAtEpochMs: currentTime + 900_000
          }),
          'utf8'
        );

        const boundaryArgs = [
          '-Action',
          'WaitForExit',
          '-ExecutablePath',
          uniqueExecutablePath,
          '-HandoffPath',
          handoffPath,
          '-HandoffNonce',
          nonce,
          '-ExpectedUserSid',
          currentSid,
          '-ExpectedSessionId',
          String(current.session),
          '-RequireHandoff'
        ];

        await runScript(boundaryArgs);
        await expect(readFile(handoffPath, 'utf8')).resolves.toContain(nonce);

        await runScript(boundaryArgs);
        await expect(readFile(handoffPath, 'utf8')).resolves.toContain(nonce);

        await runScript([...boundaryArgs.slice(0, 1), 'Consume', ...boundaryArgs.slice(2)]);
        await expect(readFile(handoffPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

        await expect(
          runScript([...boundaryArgs.slice(0, 1), 'Consume', ...boundaryArgs.slice(2)])
        ).rejects.toMatchObject({ stderr: expect.stringContaining('no longer available') });
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  );

  windowsIt(
    'writes a canonical private acknowledgement, then consumes both files after the same boundary waits',
    async () => {
      const current = await getCurrentWindowsIdentity();
      if (isNonInteractiveIdentity(current.sid)) return;

      const acknowledgementNonce = randomUUID().toLowerCase();
      const canonicalTempDirectory = await getCanonicalLocalTempDirectory();
      const handoffPath = join(canonicalTempDirectory, `youyu-update-handoff-${acknowledgementNonce}.json`);
      const acknowledgementPath = join(
        canonicalTempDirectory,
        `youyu-update-handoff-${acknowledgementNonce}.ready.json`
      );
      const uniqueExecutablePath = join(tmpdir(), `youyu-acknowledgement-target-${randomUUID()}.exe`);
      const currentTime = Date.now();
      const boundaryArgs = [
        '-ExecutablePath',
        uniqueExecutablePath,
        '-HandoffPath',
        handoffPath,
        '-HandoffNonce',
        acknowledgementNonce,
        '-ExpectedUserSid',
        current.sid,
        '-ExpectedSessionId',
        String(current.session),
        '-RequireHandoff'
      ];
      try {
        await writeFile(
          handoffPath,
          JSON.stringify({
            version: 1,
            nonce: acknowledgementNonce,
            targetUserSid: current.sid,
            targetSessionId: current.session,
            targetProcessId: process.pid,
            executablePath: uniqueExecutablePath,
            createdAtEpochMs: currentTime,
            expiresAtEpochMs: currentTime + 300_000
          }),
          'utf8'
        );

        const acknowledged = await runScript(['-Action', 'AcknowledgeAndWait', ...boundaryArgs]);
        expect(acknowledged.stdout).toContain('"status":"acknowledged-and-waited"');
        const acknowledgement = JSON.parse(await readFile(acknowledgementPath, 'utf8')) as {
          version: number;
          nonce: string;
          handoffPath: string;
          targetUserSid: string;
          targetSessionId: number;
          targetProcessId: number;
          executablePath: string;
          acknowledgedAtEpochMs: number;
          expiresAtEpochMs: number;
        };
        expect(acknowledgement).toMatchObject({
          version: 1,
          nonce: acknowledgementNonce,
          handoffPath,
          targetUserSid: current.sid,
          targetSessionId: current.session,
          targetProcessId: process.pid,
          executablePath: uniqueExecutablePath
        });
        expect(acknowledgement.acknowledgedAtEpochMs).toBeGreaterThan(0);
        expect(acknowledgement.expiresAtEpochMs - acknowledgement.acknowledgedAtEpochMs).toBeLessThanOrEqual(900_000);

        const acl = await getPrivateAcknowledgementAcl(acknowledgementPath);
        expect(acl).toEqual({
          ownerSid: current.sid,
          aclProtected: true,
          ruleCount: 1,
          ruleSid: current.sid,
          allowsFullControl: true
        });

        await runScript(['-Action', 'Consume', ...boundaryArgs]);
        await expect(readFile(handoffPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(readFile(acknowledgementPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      } finally {
        await rm(handoffPath, { force: true });
        await rm(acknowledgementPath, { force: true });
      }
    }
  );

  windowsIt('recovers the old 1.7.0 handoff from only the current installer identity temp directory', async () => {
    const current = await getCurrentWindowsIdentity();
    if (isNonInteractiveIdentity(current.sid)) return;

    const fallbackNonce = randomUUID().toLowerCase();
    const fallbackPath = join(await getCanonicalLocalTempDirectory(), `youyu-update-handoff-${fallbackNonce}.json`);
    const uniqueExecutablePath = join(tmpdir(), `youyu-fallback-target-${randomUUID()}.exe`);
    const now = Date.now();
    try {
      await writeFile(
        fallbackPath,
        JSON.stringify({
          version: 1,
          nonce: fallbackNonce,
          targetUserSid: current.sid,
          targetSessionId: current.session,
          targetProcessId: process.pid,
          executablePath: uniqueExecutablePath,
          createdAtEpochMs: now,
          expiresAtEpochMs: now + 300_000
        }),
        'utf8'
      );

      const result = await runScript(['-Action', 'Verify', '-ExecutablePath', uniqueExecutablePath, '-RequireHandoff']);
      expect(result.stdout).toContain('"boundaryMode":"authenticated"');
      await expect(readFile(fallbackPath, 'utf8')).resolves.toContain(fallbackNonce);
    } finally {
      await rm(fallbackPath, { force: true });
    }
  });

  windowsIt('does not revive an expired fallback handoff from the current user temp directory', async () => {
    const current = await getCurrentWindowsIdentity();
    if (isNonInteractiveIdentity(current.sid)) return;

    const fallbackNonce = randomUUID().toLowerCase();
    const fallbackPath = join(await getCanonicalLocalTempDirectory(), `youyu-update-handoff-${fallbackNonce}.json`);
    const uniqueExecutablePath = join(tmpdir(), `youyu-expired-fallback-${randomUUID()}.exe`);
    const now = Date.now();
    try {
      await writeFile(
        fallbackPath,
        JSON.stringify({
          version: 1,
          nonce: fallbackNonce,
          targetUserSid: current.sid,
          targetSessionId: current.session,
          targetProcessId: process.pid,
          executablePath: uniqueExecutablePath,
          createdAtEpochMs: now - 300_001,
          expiresAtEpochMs: now + 1_000
        }),
        'utf8'
      );

      await expect(
        runScript(['-Action', 'Verify', '-ExecutablePath', uniqueExecutablePath, '-RequireHandoff'])
      ).rejects.toMatchObject({ stderr: expect.stringContaining('An authenticated update handoff is required.') });
    } finally {
      await rm(fallbackPath, { force: true });
    }
  });

  windowsIt('admits the one-time legacy bridge only for an eligible stopped installation', async () => {
    await withLegacyBoundaryFiles([], '1.6.8.0', async ({ executablePath, inventoryPath, versionInfoPath }) => {
      const result = await runScript([
        '-Action',
        'Verify',
        '-ExecutablePath',
        executablePath,
        '-RequireHandoff',
        '-AllowLegacyUpdateBridge',
        '-InstallerVersion',
        '1.7.0',
        '-ProcessInventoryPath',
        inventoryPath,
        '-LegacyVersionInfoPath',
        versionInfoPath
      ]);

      expect(result.stdout).toContain('"boundaryMode":"legacy"');
      expect(result.stdout).toContain('"matchingProcessCount":0');
    });
  });

  windowsIt('fails the legacy bridge when the exact installed target is still running', async () => {
    await withLegacyBoundaryFiles(
      ({ executablePath }) => [
        {
          processId: 4242,
          executablePath,
          ownerSid: targetUserSid,
          sessionId: targetSessionId
        }
      ],
      '1.6.8.0',
      async ({ executablePath, inventoryPath, versionInfoPath }) => {
        await expect(
          runScript([
            '-Action',
            'Verify',
            '-ExecutablePath',
            executablePath,
            '-RequireHandoff',
            '-AllowLegacyUpdateBridge',
            '-InstallerVersion',
            '1.7.0',
            '-ProcessInventoryPath',
            inventoryPath,
            '-LegacyVersionInfoPath',
            versionInfoPath
          ])
        ).rejects.toMatchObject({
          stderr: expect.stringContaining('without an authenticated user handoff')
        });
      }
    );
  });

  windowsIt('fails closed for both partial handoff environment and a missing handoff file', async () => {
    await withLegacyBoundaryFiles([], '1.6.8.0', async ({ executablePath, inventoryPath, versionInfoPath }) => {
      const common = [
        '-Action',
        'Verify',
        '-ExecutablePath',
        executablePath,
        '-RequireHandoff',
        '-AllowLegacyUpdateBridge',
        '-InstallerVersion',
        '1.7.0',
        '-ProcessInventoryPath',
        inventoryPath,
        '-LegacyVersionInfoPath',
        versionInfoPath
      ];
      const missingHandoffPath = join(tmpdir(), `youyu-update-handoff-${nonce}.json`);

      await expect(runScript([...common, '-HandoffPath', missingHandoffPath])).rejects.toMatchObject({
        stderr: expect.stringContaining('environment is incomplete')
      });
      await expect(
        runScript([
          ...common,
          '-HandoffPath',
          missingHandoffPath,
          '-HandoffNonce',
          nonce,
          '-ExpectedUserSid',
          targetUserSid,
          '-ExpectedSessionId',
          String(targetSessionId)
        ])
      ).rejects.toMatchObject({ stderr: expect.stringContaining('no longer available') });
    });
  });

  windowsIt('keeps a complete authenticated handoff on the authenticated path without downgrading', async () => {
    await withBoundaryFiles([], async ({ handoffPath, inventoryPath }) => {
      const result = await runScript([
        '-Action',
        'Verify',
        '-ExecutablePath',
        executablePath,
        '-HandoffPath',
        handoffPath,
        '-HandoffNonce',
        nonce,
        '-ExpectedUserSid',
        targetUserSid,
        '-ExpectedSessionId',
        String(targetSessionId),
        '-RequireHandoff',
        '-AllowLegacyUpdateBridge',
        '-InstallerVersion',
        '1.7.0',
        '-ProcessInventoryPath',
        inventoryPath,
        '-SkipFileOwnerCheck',
        '-CurrentTimeEpochMs',
        String(now + 1_000)
      ]);

      expect(result.stdout).toContain('"boundaryMode":"authenticated"');
      expect(result.stdout).not.toContain('"boundaryMode":"legacy"');
    });
  });

  windowsIt('does not activate the bridge for a non-update check or a post-bridge installer', async () => {
    await withLegacyBoundaryFiles([], '1.6.8.0', async ({ executablePath, inventoryPath, versionInfoPath }) => {
      const standard = await runScript([
        '-Action',
        'Verify',
        '-ExecutablePath',
        executablePath,
        '-ProcessInventoryPath',
        inventoryPath,
        '-LegacyVersionInfoPath',
        versionInfoPath
      ]);
      expect(standard.stdout).toContain('"boundaryMode":"standard"');

      await expect(
        runScript([
          '-Action',
          'Verify',
          '-ExecutablePath',
          executablePath,
          '-RequireHandoff',
          '-AllowLegacyUpdateBridge',
          '-InstallerVersion',
          '1.6.11',
          '-ProcessInventoryPath',
          inventoryPath,
          '-LegacyVersionInfoPath',
          versionInfoPath
        ])
      ).rejects.toMatchObject({ stderr: expect.stringContaining('not available for this installer version') });
    });
  });

  windowsIt('rejects a 1.6.9 or newer installed executable from the legacy bridge', async () => {
    await withLegacyBoundaryFiles([], '1.6.9.0', async ({ executablePath, inventoryPath, versionInfoPath }) => {
      await expect(
        runScript([
          '-Action',
          'Verify',
          '-ExecutablePath',
          executablePath,
          '-RequireHandoff',
          '-AllowLegacyUpdateBridge',
          '-InstallerVersion',
          '1.7.0',
          '-ProcessInventoryPath',
          inventoryPath,
          '-LegacyVersionInfoPath',
          versionInfoPath
        ])
      ).rejects.toMatchObject({
        stderr: expect.stringContaining('requires an authenticated update handoff')
      });
    });
  });
});

async function withBoundaryFiles(
  processes: unknown[],
  run: (files: { handoffPath: string; inventoryPath: string }) => Promise<void>
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'youyu-user-boundary-test-'));
  const handoffPath = join(directory, `youyu-update-handoff-${nonce}.json`);
  const inventoryPath = join(directory, 'processes.json');
  try {
    await writeFile(
      handoffPath,
      JSON.stringify({
        version: 1,
        nonce,
        targetUserSid,
        targetSessionId,
        targetProcessId: 4242,
        executablePath,
        createdAtEpochMs: now,
        expiresAtEpochMs: now + 900_000
      }),
      'utf8'
    );
    await writeFile(inventoryPath, JSON.stringify(processes), 'utf8');
    await run({ handoffPath, inventoryPath });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function runVerify(handoffPath: string, inventoryPath: string) {
  return runScript([
    '-Action',
    'Verify',
    '-ExecutablePath',
    executablePath,
    '-HandoffPath',
    handoffPath,
    '-HandoffNonce',
    nonce,
    '-ExpectedUserSid',
    targetUserSid,
    '-ExpectedSessionId',
    String(targetSessionId),
    '-ProcessInventoryPath',
    inventoryPath,
    '-SkipFileOwnerCheck',
    '-CurrentTimeEpochMs',
    String(now + 1_000)
  ]);
}

async function withLegacyBoundaryFiles(
  processes: unknown[] | ((files: { executablePath: string }) => unknown[]),
  fileVersion: string,
  run: (files: { executablePath: string; inventoryPath: string; versionInfoPath: string }) => Promise<void>
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'youyu-legacy-boundary-test-'));
  const executablePath = join(directory, 'YouYu.exe');
  const inventoryPath = join(directory, 'processes.json');
  const versionInfoPath = join(directory, 'version-info.json');
  const [major, minor, build, privatePart] = fileVersion.split('.').map(Number);
  try {
    await writeFile(executablePath, 'isolated test fixture', 'utf8');
    await writeFile(
      versionInfoPath,
      JSON.stringify({
        ProductName: 'YouYu',
        CompanyName: '118 Studio',
        FileMajorPart: major,
        FileMinorPart: minor,
        FileBuildPart: build,
        FilePrivatePart: privatePart
      }),
      'utf8'
    );
    const resolvedProcesses = typeof processes === 'function' ? processes({ executablePath }) : processes;
    await writeFile(inventoryPath, JSON.stringify(resolvedProcesses), 'utf8');
    await run({ executablePath, inventoryPath, versionInfoPath });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function runScript(args: string[]) {
  return execFileAsync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'RemoteSigned',
      '-File',
      join(process.cwd(), 'build', 'manage-installed-process.ps1'),
      ...args
    ],
    {
      windowsHide: true,
      env: {
        ...process.env,
        YOUYU_UPDATE_HANDOFF_PATH: '',
        YOUYU_UPDATE_HANDOFF_NONCE: '',
        YOUYU_UPDATE_TARGET_USER_SID: '',
        YOUYU_UPDATE_TARGET_SESSION_ID: ''
      }
    }
  );
}

async function getCurrentWindowsIdentity(): Promise<{ sid: string; session: number }> {
  const { stdout } = await execFileAsync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '$identity = [Security.Principal.WindowsIdentity]::GetCurrent(); $session = (Get-Process -Id $PID).SessionId; [pscustomobject]@{ sid = $identity.User.Value; session = $session } | ConvertTo-Json -Compress'
    ],
    { windowsHide: true }
  );
  const current = JSON.parse(String(stdout)) as { sid: string; session: number };
  return { sid: current.sid.toUpperCase(), session: current.session };
}

async function getCanonicalLocalTempDirectory(): Promise<string> {
  const { stdout } = await execFileAsync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      "[IO.Path]::GetFullPath([IO.Path]::Combine([Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData), 'Temp'))"
    ],
    { windowsHide: true }
  );
  return String(stdout).trim();
}

async function getPrivateAcknowledgementAcl(path: string): Promise<{
  ownerSid: string;
  aclProtected: boolean;
  ruleCount: number;
  ruleSid: string;
  allowsFullControl: boolean;
}> {
  const script = [
    '$acl = Get-Acl -LiteralPath $env:YOUYU_TEST_ACKNOWLEDGEMENT_PATH -ErrorAction Stop',
    '$rules = @($acl.Access)',
    '$fullControl = [int64] [Security.AccessControl.FileSystemRights]::FullControl',
    '$rule = if ($rules.Count -eq 1) { $rules[0] } else { $null }',
    '[pscustomobject]@{',
    '  ownerSid = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value.ToUpperInvariant()',
    '  aclProtected = [bool] $acl.AreAccessRulesProtected',
    '  ruleCount = $rules.Count',
    '  ruleSid = if ($null -eq $rule) { "" } else { $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value.ToUpperInvariant() }',
    '  allowsFullControl = if ($null -eq $rule) { $false } else { ((([int64] $rule.FileSystemRights) -band $fullControl) -eq $fullControl) }',
    '} | ConvertTo-Json -Compress'
  ].join('\n');
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true,
    env: { ...process.env, YOUYU_TEST_ACKNOWLEDGEMENT_PATH: path }
  });
  return JSON.parse(String(stdout)) as {
    ownerSid: string;
    aclProtected: boolean;
    ruleCount: number;
    ruleSid: string;
    allowsFullControl: boolean;
  };
}

function isNonInteractiveIdentity(sid: string): boolean {
  return ['S-1-5-18', 'S-1-5-19', 'S-1-5-20'].includes(sid) || sid.endsWith('-500');
}
