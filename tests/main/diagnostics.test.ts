import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  DiagnosticLogBuffer,
  LocalDiagnosticSession,
  buildDiagnosticReport,
  classifyDiagnosticIssue,
  createDiagnosticExportDefaultPath,
  createDiagnosticExportFileName,
  exportDiagnosticReport,
  isDiagnosticIssueResolvedByOperation,
  redactDiagnosticText
} from '../../src/main/diagnostics';

describe('diagnostic log buffer', () => {
  it('keeps only the newest logical entries and reports how many were dropped', () => {
    const logs = new DiagnosticLogBuffer({ capacity: 3 });

    for (let index = 1; index <= 4; index += 1) {
      logs.append(`event ${index}`, new Date(2026, 6, 19, 5, 0, index));
    }

    expect(logs.size).toBe(3);
    expect(logs.capacity).toBe(3);
    expect(logs.droppedCount).toBe(1);
    expect(logs.getLogs()).toEqual([
      '2026-07-19 05:00:02 event 2',
      '2026-07-19 05:00:03 event 3',
      '2026-07-19 05:00:04 event 4'
    ]);
  });

  it('merges equal safe messages within the recent window even when another event is interleaved', () => {
    const logs = new DiagnosticLogBuffer();

    logs.append('流量统计失败: token=first-secret', new Date(2026, 6, 19, 5, 1, 2));
    logs.append('后台刷新开始', new Date(2026, 6, 19, 5, 1, 4));
    logs.append('流量统计失败: token=second-secret', new Date(2026, 6, 19, 5, 1, 7));

    expect(logs.size).toBe(2);
    expect(logs.droppedCount).toBe(0);
    expect(logs.getLogs()).toEqual([
      '2026-07-19 05:01:04 后台刷新开始',
      '2026-07-19 05:01:02 - 2026-07-19 05:01:07 流量统计失败: token=[已隐藏]（重复 2 次）'
    ]);
  });

  it('keeps a continuous Mihomo dial warning visible as one current counted entry', () => {
    const logs = new DiagnosticLogBuffer();
    const warning =
      '[mihomo] time="2026-07-19T05:02:00+08:00" level=warning msg="[TCP] dial example.com:443 match DOMAIN-SUFFIX/example.com"';

    logs.append(warning, new Date(2026, 6, 19, 5, 2, 0));
    logs.append(warning.replace('05:02:00', '05:02:05'), new Date(2026, 6, 19, 5, 2, 5));

    expect(logs.getLogs()).toEqual([
      '2026-07-19 05:02:00 - 2026-07-19 05:02:05 连接警告：example.com 访问失败（TCP）（重复 2 次）'
    ]);
  });

  it('keeps node probe details in the export while rendering one concise deduplicated summary', () => {
    const logs = new DiagnosticLogBuffer();
    const failure =
      '[node-probe] {"node":"日本 01 alice@example.com","checks":[{"target":"gstatic-204","proxyDelay":"timeout"},{"target":"cloudflare-204","proxyDelay":"HTTP 504","providerHealthcheck":"request failed"}]}';

    logs.append(failure, new Date(2026, 7, 12, 9, 7, 25));
    logs.append(failure, new Date(2026, 7, 12, 9, 7, 37));

    expect(logs.getLogs()).toEqual([
      '2026-08-12 09:07:25 - 2026-08-12 09:07:37 节点检测失败：日本 01 [已隐藏邮箱]（重复 2 次）'
    ]);
    const [exported] = logs.getExportLogs();
    expect(exported).toContain('[node-probe]');
    expect(exported).toContain('gstatic-204');
    expect(exported).toContain('cloudflare-204');
    expect(exported).toContain('providerHealthcheck');
    expect(exported).toContain('HTTP 504');
    expect(exported).toContain('request failed');
    expect(exported).not.toContain('alice@example.com');
    expect(exported).toContain('（重复 2 次）');
  });

  it('keeps the renderer summary concise while exporting the latest safe full Mihomo failure sample', () => {
    const logs = new DiagnosticLogBuffer();
    const first =
      '[mihomo] time="2026-08-11T05:02:00+08:00" level=warning msg="[TCP] dial 🌐 自动选择 (match ProcessName/chrome.exe) 127.0.0.1:52100 --> api.example.com:443 error: proxy chain hk-01 -> relay-a: dial tcp 198.51.100.10:443: i/o timeout" account=alice@example.com';
    const latest = first
      .replace('05:02:00', '05:02:05')
      .replace('127.0.0.1:52100', '127.0.0.1:60999')
      .replace('alice@example.com', 'bob@example.com');

    logs.append(first, new Date(2026, 7, 11, 5, 2, 0));
    logs.append(latest, new Date(2026, 7, 11, 5, 2, 5));

    expect(logs.getLogs()).toEqual([
      '2026-08-11 05:02:00 - 2026-08-11 05:02:05 连接警告：api.example.com 访问失败（TCP）（重复 2 次）'
    ]);
    expect(logs.getLogs()[0]).not.toMatch(/ProcessName|proxy chain|dial tcp|i\/o timeout|:443/);

    const exportLogs = logs.getExportLogs();
    expect(exportLogs).toHaveLength(1);
    expect(exportLogs[0]).toContain('time="2026-08-11T05:02:05+08:00"');
    expect(exportLogs[0]).toContain('[TCP] dial 🌐 自动选择');
    expect(exportLogs[0]).toContain('match ProcessName/chrome.exe');
    expect(exportLogs[0]).toContain('127.0.0.1:60999 --> api.example.com:443');
    expect(exportLogs[0]).toContain('proxy chain hk-01 -> relay-a');
    expect(exportLogs[0]).toContain('dial tcp 198.51.100.10:443: i/o timeout');
    expect(exportLogs[0]).toContain('account=[已隐藏]');
    expect(exportLogs[0]).not.toContain('bob@example.com');
    expect(exportLogs[0]).toContain('（重复 2 次）');
  });

  it('does not coalesce the same Mihomo destination when rule, process, outbound, or root error changes', () => {
    const logs = new DiagnosticLogBuffer();
    const base =
      '[mihomo] time="2026-08-11T05:03:00+08:00" level=warning msg="[UDP] dial outbound-a (match ProcessName/app-a.exe) 127.0.0.1:53001 --> dns.example.com:53 error: dial udp 203.0.113.10:53: i/o timeout"';

    [
      base,
      base.replace('ProcessName/app-a.exe', 'ProcessName/app-b.exe').replace(':53001', ':53002'),
      base.replace('outbound-a', 'outbound-b').replace(':53001', ':53003'),
      base.replace('ProcessName/app-a.exe', 'DomainSuffix/example.com').replace(':53001', ':53004'),
      base.replace('i/o timeout', 'connection refused').replace(':53001', ':53005')
    ].forEach((warning, index) => logs.append(warning, new Date(2026, 7, 11, 5, 3, index)));

    expect(logs.getLogs()).toHaveLength(5);
    expect(logs.getExportLogs()).toHaveLength(5);
  });

  it('ignores only the TUN local temporary port while preserving the source process identity', () => {
    const logs = new DiagnosticLogBuffer();
    const appAFirst =
      '[mihomo] level=warning msg="[TCP] dial PROXY (match DomainSuffix/example.com) 127.0.0.1:51000(app-a.exe) --> example.com:443 error: dial tcp: i/o timeout"';
    const appALatest = appAFirst.replace(':51000(app-a.exe)', ':51001(app-a.exe)');
    const appB = appAFirst.replace(':51000(app-a.exe)', ':51002(app-b.exe)');

    logs.append(appAFirst, new Date(2026, 7, 11, 5, 3, 0));
    logs.append(appALatest, new Date(2026, 7, 11, 5, 3, 1));
    logs.append(appB, new Date(2026, 7, 11, 5, 3, 2));

    expect(logs.size).toBe(2);
    expect(logs.getLogs()).toEqual([
      '2026-08-11 05:03:00 - 2026-08-11 05:03:01 连接警告：example.com 访问失败（TCP）（重复 2 次）',
      '2026-08-11 05:03:02 连接警告：example.com 访问失败（TCP）'
    ]);
    expect(logs.getExportLogs()[0]).toContain('127.0.0.1:51001(app-a.exe) --> example.com:443');
    expect(logs.getExportLogs()[0]).toContain('（重复 2 次）');
    expect(logs.getExportLogs()[1]).toContain('127.0.0.1:51002(app-b.exe) --> example.com:443');
    expect(logs.getExportLogs()[1]).not.toContain('（重复');
  });

  it('flattens and bounds the detailed export sample without exposing it through getLogs', () => {
    const logs = new DiagnosticLogBuffer({ maxMessageLength: 256 });
    const warning = `[mihomo] time="2026-08-11T05:04:00+08:00" level=warning msg="[TCP] dial outbound-a (match ProcessName/app.exe) 127.0.0.1:54001 --> api.example.com:443 error: first line\r\nsecond line ${'safe '.repeat(100)}terminal root error: connection refused"`;

    logs.append(warning, new Date(2026, 7, 11, 5, 4, 0));

    expect(logs.getLogs()[0]).toBe('2026-08-11 05:04:00 连接警告：api.example.com 访问失败（TCP）');
    const [exported] = logs.getExportLogs();
    expect(exported).not.toMatch(/[\r\n]/);
    expect(exported).toContain('[中间省略]');
    expect(exported).toContain('[TCP] dial outbound-a');
    expect(exported).toContain('terminal root error: connection refused');
    expect(exported).toHaveLength(20 + 256);
  });

  it('uses the actual Mihomo destination instead of a matched rule-set label', () => {
    const logs = new DiagnosticLogBuffer();
    const warning =
      '[mihomo] time="2026-08-02T01:40:24+08:00" level=warning msg="[TCP] dial DIRECT (match RuleSet/China) 127.0.0.1:52100 --> api.example.cn:443 error: i/o timeout"';

    logs.append(warning, new Date(2026, 7, 2, 1, 40, 24));

    expect(logs.getLogs()).toEqual(['2026-08-02 01:40:24 连接警告：api.example.cn 访问失败（TCP）']);
  });

  it('preserves a bracketed IPv6 destination without treating its last segment as a port', () => {
    const logs = new DiagnosticLogBuffer();
    const warning =
      '[mihomo] time="2026-08-02T01:40:24+08:00" level=warning msg="[TCP] dial DIRECT 127.0.0.1:52100 --> [2001:db8::1]:443 error: i/o timeout"';

    logs.append(warning, new Date(2026, 7, 2, 1, 40, 24));

    expect(logs.getLogs()).toEqual(['2026-08-02 01:40:24 连接警告：2001:db8::1 访问失败（TCP）']);
  });

  it('drops the PowerShell CLIXML stream marker because it is not a Mihomo diagnostic event', () => {
    const logs = new DiagnosticLogBuffer();

    logs.append('[mihomo] #< CLIXML', new Date(2026, 7, 2, 1, 14, 34));

    expect(logs.getLogs()).toEqual([]);
    expect(logs.getExportLogs()).toEqual([]);
  });

  it('starts a new logical entry after the repeat coalescing window', () => {
    const logs = new DiagnosticLogBuffer({ coalesceWindowMs: 1000 });
    logs.append('same event', new Date(2026, 6, 19, 5, 2, 0));
    logs.append('same event', new Date(2026, 6, 19, 5, 2, 2));

    expect(logs.getLogs()).toEqual(['2026-07-19 05:02:00 same event', '2026-07-19 05:02:02 same event']);
  });

  it('bounds and flattens each safe message before retaining it', () => {
    const logs = new DiagnosticLogBuffer();
    const message = '安全内容'.repeat(2000);

    logs.append(`${message}\r\nignored`, new Date(2026, 6, 19, 5, 3, 0));

    const [line] = logs.getLogs();
    expect(line).toHaveLength(20 + 4096);
    expect(line).toBe(`2026-07-19 05:03:00 ${message.slice(0, 4095)}…`);
  });

  it('returns only the requested recent window without changing the retained count', () => {
    const logs = new DiagnosticLogBuffer({ capacity: 200 });
    for (let index = 0; index < 100; index += 1) {
      logs.append(`event ${index}`, new Date(2026, 6, 19, 6, 0, index % 60));
    }

    expect(logs.getLogs(80)).toHaveLength(80);
    expect(logs.getLogs()).toHaveLength(100);
    expect(logs.getExportLogs(80)).toHaveLength(80);
    expect(logs.size).toBe(100);
  });
});

describe('cross-session local diagnostics', () => {
  it('recovers a redacted tail after an unclean exit and ignores a clean previous session', () => {
    const directory = mkdtempSync(join(tmpdir(), 'youyu-diagnostics-'));
    try {
      const first = new LocalDiagnosticSession(directory, { maxBytes: 4096, archiveCount: 2, recoveryLimit: 3 });
      first.append('启动完成');
      first.append('请求失败 token=private-secret C:\\Users\\Alice\\private');

      const second = new LocalDiagnosticSession(directory, { maxBytes: 4096, archiveCount: 2, recoveryLimit: 3 });
      expect(second.recovery.unexpectedExit).toBe(true);
      expect(second.recovery.logs.map((entry) => entry.message)).toEqual([
        '启动完成',
        '请求失败 token=[已隐藏] C:\\Users\\[已隐藏]\\private'
      ]);

      const persisted = readdirSync(directory)
        .map((name) => readFileSync(join(directory, name), 'utf8'))
        .join('\n');
      expect(persisted).not.toContain('private-secret');
      expect(persisted).not.toContain('Alice');

      second.close();
      const third = new LocalDiagnosticSession(directory, { maxBytes: 4096, archiveCount: 2, recoveryLimit: 3 });
      expect(third.recovery.unexpectedExit).toBe(false);
      expect(third.recovery.logs).toEqual([]);
      third.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('bounds the local journal and keeps only the configured archives', () => {
    const directory = mkdtempSync(join(tmpdir(), 'youyu-diagnostics-'));
    try {
      const session = new LocalDiagnosticSession(directory, { maxBytes: 2048, archiveCount: 2 });
      for (let index = 0; index < 80; index += 1) session.append(`事件 ${index} ${'x'.repeat(120)}`);

      const files = readdirSync(directory);
      expect(files.length).toBeLessThanOrEqual(3);
      expect(Math.max(...files.map((name) => statSync(join(directory, name)).size))).toBeLessThanOrEqual(2300);
      session.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('diagnostic export', () => {
  it('wires detailed logs only to file export while snapshots keep the concise renderer view', () => {
    const mainSource = readFileSync(new URL('../../src/main/index.ts', import.meta.url), 'utf8');

    expect(mainSource).toContain('const logs = appLogs.getExportLogs();');
    expect(mainSource).toContain('logs: appLogs.getLogs(diagnosticSnapshotLogLimit),');
    expect(mainSource).not.toContain('logs: appLogs.getExportLogs(');
    expect(mainSource.match(/getExportLogs\(/g)).toHaveLength(1);
  });

  it('wires the local journal into startup, append, recovery, and clean shutdown', () => {
    const mainSource = readFileSync(new URL('../../src/main/index.ts', import.meta.url), 'utf8');

    expect(mainSource).toContain("new LocalDiagnosticSession(join(app.getPath('userData'), 'diagnostics'))");
    expect(mainSource).toContain('localDiagnosticSession?.append(message)');
    expect(mainSource).toContain('session.recovery.unexpectedExit');
    expect(mainSource).toContain('已恢复上次异常结束前的诊断记录');
    expect(mainSource).toContain('localDiagnosticSession?.close()');
  });

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
    expect(classifyDiagnosticIssue('启动失败: operation replaced')).toBeUndefined();
    expect(classifyDiagnosticIssue('remote refresh superseded by manual refresh')).toBeUndefined();
    expect(classifyDiagnosticIssue('connection aborted by peer')).toBe('network');
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

  it('redacts email addresses and account-style identity fields', () => {
    const input = [
      'contact=alice+support@example.com',
      'account=customer-42',
      'accountId=019f60d8-d5fb-73d0-a15c-a954a55b85b4',
      'account_name="Alice Zhang"',
      'email: bob@example.net',
      'loginName=alice-login',
      'username=alice-user'
    ].join(' | ');

    const redacted = redactDiagnosticText(input);

    for (const secret of [
      'alice+support@example.com',
      'customer-42',
      '019f60d8-d5fb-73d0-a15c-a954a55b85b4',
      'Alice Zhang',
      'bob@example.net',
      'alice-login',
      'alice-user'
    ]) {
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
      logCapacity: 200,
      droppedLogCount: 7,
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
    expect(report).toContain('日志容量: 200 条');
    expect(report).toContain('已丢弃较早日志: 7 条');
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

  it('places the save dialog in the supplied Downloads directory by default', () => {
    expect(createDiagnosticExportDefaultPath('C:\\Users\\Alice\\Downloads', 'YouYu-diagnostics.txt')).toBe(
      'C:\\Users\\Alice\\Downloads\\YouYu-diagnostics.txt'
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
