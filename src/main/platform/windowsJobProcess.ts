import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

type ProcessSpawner<TResult> = (binaryPath: string, args: string[]) => TResult;

type WindowsJobProcessScriptInput = {
  binaryPath: string;
  args: string[];
  parentPid: number;
  pollIntervalMs: number;
};

const windowsJobNativeSource = String.raw`
using System;
using System.ComponentModel;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace YouYu {
  public static class WindowsJobNative {
    public const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    private const uint CREATE_SUSPENDED = 0x00000004;
    private const uint CREATE_NO_WINDOW = 0x08000000;
    private const uint STARTF_USESTDHANDLES = 0x00000100;
    private const uint DUPLICATE_SAME_ACCESS = 0x00000002;
    private const int STD_INPUT_HANDLE = -10;
    private const int STD_OUTPUT_HANDLE = -11;
    private const int STD_ERROR_HANDLE = -12;

    [StructLayout(LayoutKind.Sequential)]
    public struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
      public long PerProcessUserTimeLimit;
      public long PerJobUserTimeLimit;
      public uint LimitFlags;
      public UIntPtr MinimumWorkingSetSize;
      public UIntPtr MaximumWorkingSetSize;
      public uint ActiveProcessLimit;
      public UIntPtr Affinity;
      public uint PriorityClass;
      public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct IO_COUNTERS {
      public ulong ReadOperationCount;
      public ulong WriteOperationCount;
      public ulong OtherOperationCount;
      public ulong ReadTransferCount;
      public ulong WriteTransferCount;
      public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
      public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
      public IO_COUNTERS IoInfo;
      public UIntPtr ProcessMemoryLimit;
      public UIntPtr JobMemoryLimit;
      public UIntPtr PeakProcessMemoryUsed;
      public UIntPtr PeakJobMemoryUsed;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct STARTUPINFO {
      public uint cb;
      public string lpReserved;
      public string lpDesktop;
      public string lpTitle;
      public uint dwX;
      public uint dwY;
      public uint dwXSize;
      public uint dwYSize;
      public uint dwXCountChars;
      public uint dwYCountChars;
      public uint dwFillAttribute;
      public uint dwFlags;
      public ushort wShowWindow;
      public ushort cbReserved2;
      public IntPtr lpReserved2;
      public IntPtr hStdInput;
      public IntPtr hStdOutput;
      public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION {
      public IntPtr hProcess;
      public IntPtr hThread;
      public uint dwProcessId;
      public uint dwThreadId;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr CreateJobObject(IntPtr securityAttributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool SetInformationJobObject(
      IntPtr job,
      int informationClass,
      IntPtr information,
      uint informationLength
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CreateProcessW(
      string applicationName,
      StringBuilder commandLine,
      IntPtr processAttributes,
      IntPtr threadAttributes,
      [MarshalAs(UnmanagedType.Bool)] bool inheritHandles,
      uint creationFlags,
      IntPtr environment,
      string currentDirectory,
      ref STARTUPINFO startupInfo,
      out PROCESS_INFORMATION processInformation
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint ResumeThread(IntPtr thread);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool TerminateProcess(IntPtr process, uint exitCode);

    [DllImport("kernel32.dll")]
    private static extern IntPtr GetCurrentProcess();

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GetStdHandle(int standardHandle);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool DuplicateHandle(
      IntPtr sourceProcess,
      IntPtr sourceHandle,
      IntPtr targetProcess,
      out IntPtr targetHandle,
      uint desiredAccess,
      [MarshalAs(UnmanagedType.Bool)] bool inheritHandle,
      uint options
    );

    public static void ThrowLastWin32Error(string operation) {
      throw new Win32Exception(Marshal.GetLastWin32Error(), operation + " failed");
    }

    public static Process StartProcessSuspendedAndAssignToJobObject(
      IntPtr job,
      string applicationPath,
      string arguments,
      bool inheritStandardHandles
    ) {
      var startup = new STARTUPINFO();
      startup.cb = (uint)Marshal.SizeOf(typeof(STARTUPINFO));
      var duplicatedHandles = new List<IntPtr>();
      PROCESS_INFORMATION created;
      try {
        if (inheritStandardHandles) {
          startup.dwFlags |= STARTF_USESTDHANDLES;
          startup.hStdInput = DuplicateStandardHandle(STD_INPUT_HANDLE, duplicatedHandles);
          startup.hStdOutput = DuplicateStandardHandle(STD_OUTPUT_HANDLE, duplicatedHandles);
          startup.hStdError = DuplicateStandardHandle(STD_ERROR_HANDLE, duplicatedHandles);
        }
        var commandLine = new StringBuilder(QuoteArgument(applicationPath));
        if (!String.IsNullOrWhiteSpace(arguments)) commandLine.Append(' ').Append(arguments);
        if (!CreateProcessW(
          applicationPath,
          commandLine,
          IntPtr.Zero,
          IntPtr.Zero,
          inheritStandardHandles,
          CREATE_SUSPENDED | CREATE_NO_WINDOW,
          IntPtr.Zero,
          null,
          ref startup,
          out created
        )) ThrowLastWin32Error("CreateProcessW(CREATE_SUSPENDED)");
      } finally {
        foreach (var handle in duplicatedHandles) CloseHandle(handle);
      }

      try {
        if (!AssignProcessToJobObject(job, created.hProcess)) {
          var assignmentError = Marshal.GetLastWin32Error();
          TerminateProcess(created.hProcess, 1);
          throw new Win32Exception(assignmentError, "AssignProcessToJobObject failed");
        }
        if (ResumeThread(created.hThread) == UInt32.MaxValue) {
          var resumeError = Marshal.GetLastWin32Error();
          TerminateProcess(created.hProcess, 1);
          throw new Win32Exception(resumeError, "ResumeThread failed");
        }
        return Process.GetProcessById((int)created.dwProcessId);
      } catch {
        TerminateProcess(created.hProcess, 1);
        throw;
      } finally {
        CloseHandle(created.hThread);
        CloseHandle(created.hProcess);
      }
    }

    private static IntPtr DuplicateStandardHandle(int standardHandle, List<IntPtr> duplicatedHandles) {
      var source = GetStdHandle(standardHandle);
      if (source == IntPtr.Zero || source == new IntPtr(-1)) return IntPtr.Zero;
      IntPtr duplicate;
      var currentProcess = GetCurrentProcess();
      if (!DuplicateHandle(
        currentProcess,
        source,
        currentProcess,
        out duplicate,
        0,
        true,
        DUPLICATE_SAME_ACCESS
      )) ThrowLastWin32Error("DuplicateHandle");
      duplicatedHandles.Add(duplicate);
      return duplicate;
    }

    public static string QuoteArgument(string value) {
      if (String.IsNullOrEmpty(value)) return "\"\"";
      if (value.IndexOfAny(new char[] { ' ', '\t', '\n', '\v', '\"' }) < 0) return value;

      var result = new StringBuilder();
      result.Append('\"');
      var backslashes = 0;
      foreach (var character in value) {
        if (character == '\\') {
          backslashes += 1;
        } else if (character == '\"') {
          result.Append('\\', backslashes * 2 + 1);
          result.Append('\"');
          backslashes = 0;
        } else {
          result.Append('\\', backslashes);
          result.Append(character);
          backslashes = 0;
        }
      }
      result.Append('\\', backslashes * 2);
      result.Append('\"');
      return result.ToString();
    }

    public static async Task<string> ReadFrameAsync(Stream stream, int maxBytes, CancellationToken token) {
      if (maxBytes <= 0) throw new ArgumentOutOfRangeException("maxBytes");
      var header = await ReadExactlyAsync(stream, 4, token).ConfigureAwait(false);
      var length = BitConverter.ToInt32(header, 0);
      if (length <= 0 || length > maxBytes) throw new InvalidDataException("named-pipe frame exceeds byte limit");
      var payload = await ReadExactlyAsync(stream, length, token).ConfigureAwait(false);
      return new UTF8Encoding(false, true).GetString(payload);
    }

    public static string ReadFrameWithTimeout(Stream stream, int maxBytes, int timeoutMilliseconds) {
      using (var cancellation = new CancellationTokenSource()) {
        cancellation.CancelAfter(timeoutMilliseconds);
        try {
          return ReadFrameAsync(stream, maxBytes, cancellation.Token).GetAwaiter().GetResult();
        } catch (OperationCanceledException error) {
          throw new TimeoutException("named-pipe protocol read timed out", error);
        }
      }
    }

    private static async Task<byte[]> ReadExactlyAsync(Stream stream, int length, CancellationToken token) {
      var result = new byte[length];
      var offset = 0;
      while (offset < length) {
        var count = await stream.ReadAsync(result, offset, length - offset, token).ConfigureAwait(false);
        if (count == 0) throw new EndOfStreamException("named-pipe connection closed");
        offset += count;
      }
      return result;
    }
  }
}
`.trim();

function encodeUtf8(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64');
}

function encodePowerShell(source: string): string {
  return Buffer.from(source, 'utf16le').toString('base64');
}

export function encodeCompressedPowerShellCommand(source: string): string {
  const payload = gzipSync(Buffer.from(source, 'utf8'), { level: 9 }).toString('base64');
  const bootstrap = [
    "$ErrorActionPreference = 'Stop'",
    `$compressed = [Convert]::FromBase64String('${payload}')`,
    '$memory = [IO.MemoryStream]::new($compressed, $false)',
    '$gzip = [IO.Compression.GZipStream]::new($memory, [IO.Compression.CompressionMode]::Decompress, $false)',
    '$reader = [IO.StreamReader]::new($gzip, [Text.UTF8Encoding]::new($false, $true), $false, 4096, $false)',
    'try { & ([ScriptBlock]::Create($reader.ReadToEnd())) } finally { $reader.Dispose(); $gzip.Dispose(); $memory.Dispose() }'
  ].join('; ');
  return encodePowerShell(bootstrap);
}

export function windowsJobNativeTypePowerShell(indent = ''): string[] {
  if (indent) throw new Error('native PowerShell here-string must not be indented');
  return [
    "if (-not ('YouYu.WindowsJobNative' -as [type])) {",
    "  $nativeSource = @'",
    ...windowsJobNativeSource.split('\n'),
    "'@",
    '  Add-Type -TypeDefinition $nativeSource -Language CSharp',
    '}'
  ];
}

export function windowsJobCreationPowerShell(indent = ''): string[] {
  return [
    `${indent}$jobHandle = [YouYu.WindowsJobNative]::CreateJobObject([IntPtr]::Zero, $null)`,
    `${indent}if ($jobHandle -eq [IntPtr]::Zero) { throw 'CreateJobObject failed' }`,
    `${indent}$jobInfo = [YouYu.WindowsJobNative+JOBOBJECT_EXTENDED_LIMIT_INFORMATION]::new()`,
    `${indent}$basicLimitInfo = [YouYu.WindowsJobNative+JOBOBJECT_BASIC_LIMIT_INFORMATION]::new()`,
    `${indent}$basicLimitInfo.LimitFlags = [YouYu.WindowsJobNative]::JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`,
    `${indent}$jobInfo.BasicLimitInformation = $basicLimitInfo`,
    `${indent}$jobInfoSize = [Runtime.InteropServices.Marshal]::SizeOf($jobInfo)`,
    `${indent}$jobInfoPointer = [Runtime.InteropServices.Marshal]::AllocHGlobal($jobInfoSize)`,
    `${indent}try {`,
    `${indent}  [Runtime.InteropServices.Marshal]::StructureToPtr($jobInfo, $jobInfoPointer, $false)`,
    `${indent}  $configured = [YouYu.WindowsJobNative]::SetInformationJobObject($jobHandle, 9, $jobInfoPointer, [uint32]$jobInfoSize)`,
    `${indent}  if (-not $configured) { throw 'SetInformationJobObject failed' }`,
    `${indent}} finally {`,
    `${indent}  [Runtime.InteropServices.Marshal]::FreeHGlobal($jobInfoPointer)`,
    `${indent}` + '}'
  ];
}

export function windowsJobAssignmentPowerShell(processVariable = '$process', indent = ''): string[] {
  return [
    `${indent}$assigned = [YouYu.WindowsJobNative]::AssignProcessToJobObject($jobHandle, ${processVariable}.Handle)`,
    `${indent}if (-not $assigned) {`,
    `${indent}  try { ${processVariable}.Kill() } catch { }`,
    `${indent}  throw 'AssignProcessToJobObject failed'`,
    `${indent}` + '}'
  ];
}

export function buildWindowsJobProcessScript(input: WindowsJobProcessScriptInput): string {
  if (!Number.isSafeInteger(input.parentPid) || input.parentPid <= 0) throw new Error('invalid parent process id');
  const pollIntervalMs = Math.max(100, Math.floor(input.pollIntervalMs));
  const encodedArgs = encodeUtf8(JSON.stringify(input.args));
  return [
    "$ErrorActionPreference = 'Stop'",
    '$process = $null',
    '$jobHandle = [IntPtr]::Zero',
    '$exitCode = 1',
    ...windowsJobNativeTypePowerShell(),
    '$decode = { param([string]$value) [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($value)) }',
    `$binary = & $decode '${encodeUtf8(input.binaryPath)}'`,
    `[string[]] $arguments = ConvertFrom-Json (& $decode '${encodedArgs}')`,
    'try {',
    ...windowsJobCreationPowerShell('  '),
    '  $nativeArguments = @($arguments | ForEach-Object { [YouYu.WindowsJobNative]::QuoteArgument([string] $_) })',
    "  $process = [YouYu.WindowsJobNative]::StartProcessSuspendedAndAssignToJobObject($jobHandle, $binary, ($nativeArguments -join ' '), $true)",
    '  while (-not $process.HasExited) {',
    `    if (-not (Get-Process -Id ${input.parentPid} -ErrorAction SilentlyContinue)) {`,
    '      try { $process.Kill() } catch { }',
    '      break',
    '    }',
    `    Start-Sleep -Milliseconds ${pollIntervalMs}`,
    '    $process.Refresh()',
    '  }',
    '  $process.WaitForExit()',
    '  $exitCode = $process.ExitCode',
    '} catch {',
    '  [Console]::Error.WriteLine($_.Exception.Message)',
    '  $exitCode = 1',
    '} finally {',
    '  if ($process -and -not $process.HasExited) { try { $process.Kill() } catch { } }',
    '  if ($process) { $process.Dispose() }',
    '  if ($jobHandle -ne [IntPtr]::Zero) { [YouYu.WindowsJobNative]::CloseHandle($jobHandle) | Out-Null }',
    '}',
    'exit $exitCode'
  ].join('\r\n');
}

export function spawnWindowsJobProcess(
  binaryPath: string,
  args: string[],
  options: {
    parentPid?: number;
    pollIntervalMs?: number;
    spawnHost?: typeof spawn;
  } = {}
): ChildProcess {
  const script = buildWindowsJobProcessScript({
    binaryPath,
    args,
    parentPid: options.parentPid ?? process.pid,
    pollIntervalMs: options.pollIntervalMs ?? 250
  });
  const powershellPath = join(
    process.env.SystemRoot ?? 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  );
  const encodedCommand = encodeCompressedPowerShellCommand(script);
  if (encodedCommand.length > 28_000) throw new Error('Windows Job Object helper exceeds the command-line limit');
  return (options.spawnHost ?? spawn)(
    powershellPath,
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodedCommand],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
  );
}

export function selectMihomoProcessSpawner<TDirect, TJob>(input: {
  platform?: NodeJS.Platform;
  spawnDirect: ProcessSpawner<TDirect>;
  spawnWindowsJob: ProcessSpawner<TJob>;
}): ProcessSpawner<TDirect | TJob> {
  return (input.platform ?? process.platform) === 'win32' ? input.spawnWindowsJob : input.spawnDirect;
}
