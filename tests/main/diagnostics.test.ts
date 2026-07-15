import { describe, expect, it, vi } from 'vitest';
import {
  buildDiagnosticReport,
  classifyDiagnosticIssue,
  createDiagnosticExportFileName,
  exportDiagnosticReport,
  isDiagnosticIssueResolvedByOperation,
  redactDiagnosticText
} from '../../src/main/diagnostics';

describe('diagnostic export', () => {
  it.each([
    ['WinINet system proxy disable failed', 'system-proxy'],
    ['getaddrinfo ENOTFOUND example.com', 'dns'],
    ['mihomo controller failed to start', 'kernel'],
    ['missing subscription url', 'subscription'],
    ['Access is denied; administrator permission required', 'permission'],
    ['remote config signature invalid', 'registration'],
    ['connection timed out', 'network'],
    ['后台刷新订阅失败: getaddrinfo ENOTFOUND api.example.com', 'dns'],
    ['后台刷新订阅失败: connection timed out', 'network'],
    ['unexpected operation failure', 'unknown']
  ] as const)('classifies %s as %s', (message, expected) => {
    expect(classifyDiagnosticIssue(message)).toBe(expected);
  });

  it('does not invent a diagnostic issue without an error', () => {
    expect(classifyDiagnosticIssue(undefined)).toBeUndefined();
    expect(classifyDiagnosticIssue('')).toBeUndefined();
  });

  it.each([
    ['subscription-refresh', 'subscription', true],
    ['subscription-refresh', 'dns', true],
    ['subscription-refresh', 'network', true],
    ['subscription-refresh', 'kernel', false],
    ['save-settings', 'dns', true],
    ['save-settings', 'network', true],
    ['save-settings', 'backend', false],
    ['sync-settings', 'dns', true],
    ['sync-settings', 'backend', true],
    ['sync-settings', 'registration', true],
    ['sync-settings', 'kernel', false]
  ] as const)('resolves %s / %s as %s', (operation, issueKind, expected) => {
    expect(isDiagnosticIssueResolvedByOperation(operation, issueKind)).toBe(expected);
  });

  it('redacts credentials, private URL paths, proxy values, ids, and the Windows user directory', () => {
    const input = [
      'GET https://user:pass@example.com/sub/private-token?token=query-secret',
      'Authorization: Bearer bearer-secret',
      'controllerSecret=controller-secret deviceId=device-secret',
      'ProxyServer=127.0.0.1:7890 ProxyOverride=<local>',
      'C:\\Users\\Alice\\AppData\\Roaming\\YouYu'
    ].join(' | ');

    const redacted = redactDiagnosticText(input);

    expect(redacted).toContain('https://example.com/[已隐藏]');
    expect(redacted).toContain('C:\\Users\\[已隐藏]\\AppData');
    for (const secret of [
      'private-token',
      'query-secret',
      'bearer-secret',
      'controller-secret',
      'device-secret',
      '127.0.0.1:7890',
      '<local>',
      'Alice'
    ]) {
      expect(redacted).not.toContain(secret);
    }
  });

  it('redacts JSON credentials, escaped values, cookies, and full-width separators', () => {
    const input = [
      '{"token":"shortsecret","authorization":"Basic dXNlcjpwYXNz","client_secret":"clientvalue"}',
      String.raw`{"private_key":"abc\"def","sessionToken":"sessionvalue"}`,
      'cookie: sid=cookievalue',
      'Set-Cookie：sid=fullwidthvalue'
    ].join(' | ');

    const redacted = redactDiagnosticText(input);

    for (const secret of [
      'shortsecret',
      'dXNlcjpwYXNz',
      'clientvalue',
      'abc',
      'def',
      'sessionvalue',
      'cookievalue',
      'fullwidthvalue'
    ]) {
      expect(redacted).not.toContain(secret);
    }
    expect(redactDiagnosticText(redacted)).toBe(redacted);
  });

  it('redacts slash and UNC user paths plus every non-HTTP connection URI', () => {
    const input = [
      'file:///C:/Users/Alice/AppData/Roaming/YouYu',
      'C:/Users/Bob/Documents/report.txt',
      String.raw`\\server\Users\Carol\logs\youyu.txt`,
      'file:///C:/Users/Dana/Documents/Customer-Secret/Case-123.txt',
      'https://example.com/Users/Eve/private-token?token=query-secret',
      'ws://user:password@127.0.0.1:9090/path',
      'hysteria2://user:password@example.com:443',
      'tuic://user:password@example.com:443',
      'socks4://user:password@example.com:1080'
    ].join(' | ');

    const redacted = redactDiagnosticText(input);

    for (const secret of [
      'Alice',
      'Bob',
      'Carol',
      'Dana',
      'Eve',
      'Customer-Secret',
      'Case-123',
      'private-token',
      'query-secret',
      'password',
      'file:///',
      'ws://',
      'hysteria2://',
      'tuic://',
      'socks4://'
    ]) {
      expect(redacted).not.toContain(secret);
    }
    expect(redacted).toContain('[已隐藏连接]');
    expect(redacted).toContain('https://example.com/[已隐藏]');
  });

  it('redacts credential aliases, Basic auth, and spaced proxy server labels', () => {
    const input = [
      '{"credential":"shortsecret"}',
      'credential=dXNlcjpwYXNz',
      'Basic dXNlcjpwYXNz',
      'Proxy Server(s) : proxy-user:proxy-pass@example.com:8080'
    ].join(' | ');

    const redacted = redactDiagnosticText(input);

    for (const secret of ['shortsecret', 'dXNlcjpwYXNz', 'proxy-user', 'proxy-pass']) {
      expect(redacted).not.toContain(secret);
    }
    expect(redactDiagnosticText(redacted)).toBe(redacted);
  });

  it('redacts JSON-escaped drive and UNC user paths', () => {
    const input = [
      String.raw`{"path":"C:\\Users\\Alice\\AppData\\Roaming\\YouYu"}`,
      String.raw`path=C:\\Users\\Bob\\Documents\\report.txt`,
      String.raw`{"path":"\\\\server\\Users\\Carol\\Customer-Secret\\Case.txt"}`,
      String.raw`deviceName=WORKSTATION session_id=session-value secret_key=private-value cookies=session=cookie-value`
    ].join(' | ');

    const redacted = redactDiagnosticText(input);

    for (const secret of ['Alice', 'Bob', 'Carol', 'WORKSTATION', 'session-value', 'private-value', 'cookie-value']) {
      expect(redacted).not.toContain(secret);
    }
    expect(redactDiagnosticText(redacted)).toBe(redacted);
  });

  it('redacts UUIDv7 and long base64 tokens', () => {
    const redacted = redactDiagnosticText(
      'device=019f60d8-d5fb-73d0-a15c-a954a55b85b4 value=dXNlcjpwYXNzd29yZDphYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5eg=='
    );

    expect(redacted).not.toContain('019f60d8-d5fb-73d0-a15c-a954a55b85b4');
    expect(redacted).not.toContain('dXNlcjpwYXNzd29yZDphYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5eg==');
  });

  it('builds a stable UTF-8 text report from an explicit safe metadata allowlist', () => {
    const report = buildDiagnosticReport({
      exportedAt: new Date('2026-07-15T04:05:06.000Z'),
      appVersion: '1.5.11',
      buildChannel: 'in',
      status: 'failed',
      platform: 'win32',
      architecture: 'x64',
      osRelease: '10.0.26100',
      features: {
        systemProxyEnabled: true,
        dnsEnhanced: true,
        snifferEnabled: true,
        tunEnabled: false
      },
      runtimePorts: { mixedPort: 7890, controllerPort: 9090, dnsPort: 1053 },
      lastError: '订阅失败: https://example.com/sub/private?token=secret',
      logs: ['12:00:00 启动完成', '12:00:01 token=secret']
    });

    expect(report).toContain('YouYu 诊断日志');
    expect(report).toContain('导出时间: 2026-07-15T04:05:06.000Z');
    expect(report).toContain('版本: 1.5.11');
    expect(report).toContain('通道: in');
    expect(report).toContain('状态: failed');
    expect(report).toContain('系统: win32 x64 10.0.26100');
    expect(report).toContain('日志条数: 2');
    expect(report).toContain('系统代理: 开启');
    expect(report).toContain('TUN: 关闭');
    expect(report).not.toContain('/sub/private');
    expect(report).not.toContain('token=secret');
  });

  it('uses a sortable filesystem-safe default filename', () => {
    expect(createDiagnosticExportFileName('1.5.11', new Date('2026-07-15T04:05:06.000Z'))).toBe(
      'YouYu-diagnostics-1.5.11-20260715-040506.txt'
    );
  });

  it('does not write when the save dialog is canceled', async () => {
    const writeFile = vi.fn(async (_filePath: string, _contents: string) => undefined);
    const result = await exportDiagnosticReport(createReportInput(), {
      chooseFile: vi.fn(async () => undefined),
      writeFile
    });

    expect(result).toEqual({ canceled: true, exportedCount: 0 });
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('writes a BOM-prefixed redacted report and returns only the exported count', async () => {
    const writeFile = vi.fn(async (_filePath: string, _contents: string) => undefined);
    const result = await exportDiagnosticReport(createReportInput(), {
      chooseFile: vi.fn(async (name) => `C:\\safe\\${name}`),
      writeFile
    });

    expect(result).toEqual({ canceled: false, exportedCount: 2 });
    expect(writeFile).toHaveBeenCalledOnce();
    expect(writeFile.mock.calls[0]?.[0]).toMatch(/YouYu-diagnostics-1\.5\.11-/);
    expect(writeFile.mock.calls[0]?.[1].startsWith('\uFEFFYouYu 诊断日志')).toBe(true);
    expect(writeFile.mock.calls[0]?.[1]).not.toContain('secret');
  });

  it('is idempotent and bounds each exported log line', () => {
    const once = redactDiagnosticText('token=secret https://example.com/private');
    expect(redactDiagnosticText(once)).toBe(once);
    const report = buildDiagnosticReport({ ...createReportInput(), logs: ['safe '.repeat(2000)] });
    const exportedLog = report.split('\r\n').find((line) => line.startsWith('[001]')) ?? '';
    expect(exportedLog.length).toBeLessThanOrEqual(8198);
    expect(exportedLog.endsWith('…')).toBe(true);
  });
});

function createReportInput() {
  return {
    exportedAt: new Date('2026-07-15T04:05:06.000Z'),
    appVersion: '1.5.11',
    buildChannel: 'standard',
    status: 'running',
    platform: 'win32' as const,
    architecture: 'x64',
    osRelease: '10.0.26100',
    lastError: 'token=secret',
    logs: ['启动完成', 'https://example.com/private?token=secret']
  };
}
