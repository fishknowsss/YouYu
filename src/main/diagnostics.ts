import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { DiagnosticIssueKind } from '../shared/ipc';
import { isExpectedOperationCancellation } from '../shared/operationCancellation';

export type DiagnosticReportInput = {
  exportedAt: Date;
  appVersion: string;
  buildChannel: string;
  status: string;
  platform: NodeJS.Platform;
  architecture: string;
  osRelease: string;
  features?: {
    systemProxyEnabled: boolean;
    dnsEnhanced: boolean;
    snifferEnabled: boolean;
    tunEnabled: boolean;
  };
  runtimePorts?: {
    mixedPort: number;
    controllerPort: number;
    dnsPort: number;
  };
  logCapacity?: number;
  droppedLogCount?: number;
  lastError?: string;
  logs: string[];
};

export type DiagnosticExportDependencies = {
  chooseFile: (defaultFileName: string) => Promise<string | undefined>;
  writeFile: (filePath: string, contents: string) => Promise<void>;
};

export const diagnosticLogCapacity = 200;
export const diagnosticSnapshotLogLimit = 80;
export const diagnosticLogMessageLimit = 4096;
export const diagnosticLogCoalesceWindowMs = 2 * 60 * 1000;

type DiagnosticLogEntry = {
  summaryMessage: string;
  exportMessage: string;
  coalesceKey: string;
  firstAt: Date;
  lastAt: Date;
  occurrences: number;
};

type NormalizedDiagnosticLog = Pick<DiagnosticLogEntry, 'summaryMessage' | 'exportMessage' | 'coalesceKey'>;

type DiagnosticLogBufferOptions = {
  capacity?: number;
  maxMessageLength?: number;
  coalesceWindowMs?: number;
};

export class DiagnosticLogBuffer {
  readonly capacity: number;
  private readonly maxMessageLength: number;
  private readonly coalesceWindowMs: number;
  private readonly entries: DiagnosticLogEntry[] = [];
  private droppedEntries = 0;

  constructor(options: DiagnosticLogBufferOptions = {}) {
    this.capacity = normalizePositiveInteger(options.capacity, diagnosticLogCapacity);
    this.maxMessageLength = normalizePositiveInteger(options.maxMessageLength, diagnosticLogMessageLimit);
    this.coalesceWindowMs = normalizePositiveInteger(options.coalesceWindowMs, diagnosticLogCoalesceWindowMs);
  }

  get size(): number {
    return this.entries.length;
  }

  get droppedCount(): number {
    return this.droppedEntries;
  }

  append(input: string, at = new Date()): void {
    const normalized = normalizeDiagnosticLog(input, this.maxMessageLength);
    if (!normalized) return;

    for (let index = this.entries.length - 1; index >= 0; index -= 1) {
      const candidate = this.entries[index];
      if (candidate.coalesceKey !== normalized.coalesceKey) continue;
      const elapsed = at.getTime() - candidate.lastAt.getTime();
      if (elapsed >= 0 && elapsed <= this.coalesceWindowMs) {
        candidate.summaryMessage = normalized.summaryMessage;
        candidate.exportMessage = normalized.exportMessage;
        candidate.lastAt = new Date(at.getTime());
        candidate.occurrences += 1;
        if (index !== this.entries.length - 1) {
          this.entries.splice(index, 1);
          this.entries.push(candidate);
        }
        return;
      }
      break;
    }

    this.entries.push({
      ...normalized,
      firstAt: new Date(at.getTime()),
      lastAt: new Date(at.getTime()),
      occurrences: 1
    });
    if (this.entries.length > this.capacity) {
      this.entries.splice(0, this.entries.length - this.capacity);
      this.droppedEntries += 1;
    }
  }

  getLogs(limit = this.capacity): string[] {
    return this.getFormattedLogs('summaryMessage', limit);
  }

  getExportLogs(limit = this.capacity): string[] {
    return this.getFormattedLogs('exportMessage', limit);
  }

  private getFormattedLogs(messageKey: 'summaryMessage' | 'exportMessage', limit: number): string[] {
    const count = Math.max(0, Math.floor(limit));
    if (count === 0) return [];
    return this.entries.slice(-count).map((entry) => formatDiagnosticLogEntry(entry, entry[messageKey]));
  }
}

const quotedDiagnosticValue = String.raw`"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'`;
const redactedDiagnosticValue = String.raw`\[已隐藏\]`;
const lineSensitiveKeyPattern = new RegExp(
  String.raw`(["']?)((?:proxy[_ -]?)?authorization|(?:set[_ -]?)?cookies?|proxy[_ -]?(?:server(?:\(s\))?|override))(["']?)\s*([:=：])\s*(${quotedDiagnosticValue}|${redactedDiagnosticValue}|[^|\r\n}]+)`,
  'gi'
);
const sensitiveKeyPattern = new RegExp(
  String.raw`(["']?)((?:(?:controller|client|device|private|shared)[_ -]?)?secret|(?:(?:access|refresh|session|auth)[_ -]?)?token|credentials?|api[_ -]?key|(?:private|secret)[_ -]?key|passphrase|password|device[_ -]?(?:id|key|seed|name)|session[_ -]?id|user[_ -]?(?:id|name)|accounts?(?:[_ -]?(?:id|name|email))?|e[_ -]?mail|login(?:[_ -]?(?:id|name))?|(?:remote[_ -]?)?subscription[_ -]?url|x[_ -]?device[_ -]?signature)(["']?)\s*([:=：])\s*(${quotedDiagnosticValue}|${redactedDiagnosticValue}|[^\s|,;}]+)`,
  'gi'
);

export function redactDiagnosticText(input: string): string {
  return input
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>|]+/gi, redactUrl)
    .replace(/[\\/]{2,}[^\\/\r\n]+[\\/]+Users[\\/]+[^\\/\r\n]+/gi, '[已隐藏用户路径]')
    .replace(/\b([A-Za-z]:[\\/]+Users[\\/]+)[^\\/\r\n]+/gi, '$1[已隐藏]')
    .replace(lineSensitiveKeyPattern, redactSensitiveKeyValue)
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/gi, 'Bearer [已隐藏]')
    .replace(/\bBasic\s+[A-Za-z0-9+/_=-]{8,}/gi, 'Basic [已隐藏]')
    .replace(sensitiveKeyPattern, redactSensitiveKeyValue)
    .replace(
      /\b[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+\b/gi,
      '[已隐藏邮箱]'
    )
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[已隐藏标识]')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '[已隐藏标识]')
    .replace(/(?<![A-Za-z0-9+/_=-])(?:[A-Fa-f0-9]{32,}|[A-Za-z0-9+/_=-]{40,})(?![A-Za-z0-9+/_=-])/g, '[已隐藏标识]');
}

function normalizeDiagnosticLog(message: string, maxMessageLength: number): NormalizedDiagnosticLog | undefined {
  if (/^\[mihomo\]\s*#<\s*CLIXML\s*$/i.test(message.trim())) return undefined;

  const safeFullMessage = toSafeDiagnosticLine(message);
  if (!safeFullMessage) return undefined;
  const nodeProbe = parseNodeProbeDiagnostic(message);
  if (nodeProbe) {
    const summaryMessage = boundDiagnosticMessage(
      toSafeDiagnosticLine(`节点检测失败：${nodeProbe.node}`),
      maxMessageLength
    );
    const exportMessage = boundDiagnosticMessage(safeFullMessage, maxMessageLength);
    return {
      summaryMessage,
      exportMessage,
      coalesceKey: `node-probe:${createHash('sha256').update(exportMessage).digest('hex')}`
    };
  }
  const warning = parseMihomoDialWarning(message);
  const exportMessage = warning
    ? boundMihomoDiagnosticMessage(safeFullMessage, maxMessageLength)
    : boundDiagnosticMessage(safeFullMessage, maxMessageLength);
  if (!warning) {
    return {
      summaryMessage: exportMessage,
      exportMessage,
      coalesceKey: `message:${exportMessage}`
    };
  }

  const summaryMessage = boundDiagnosticMessage(
    toSafeDiagnosticLine(`连接警告：${warning.target} 访问失败（${warning.network}）`),
    maxMessageLength
  );
  return {
    summaryMessage,
    exportMessage,
    coalesceKey: createMihomoWarningCoalesceKey(safeFullMessage)
  };
}

function parseNodeProbeDiagnostic(message: string): { node: string } | undefined {
  const serialized = message.trim().match(/^\[node-probe\]\s+(.+)$/)?.[1];
  if (!serialized) return undefined;

  try {
    const payload = JSON.parse(serialized) as unknown;
    if (!isRecord(payload) || typeof payload.node !== 'string' || !payload.node.trim() || payload.node.length > 256) {
      return undefined;
    }
    if (!Array.isArray(payload.checks) || payload.checks.length < 1 || payload.checks.length > 2) return undefined;
    const valid = payload.checks.every((check) => {
      if (!isRecord(check)) return false;
      if (check.target !== 'gstatic-204' && check.target !== 'cloudflare-204') return false;
      if (!isSafeNodeProbeReason(check.proxyDelay)) return false;
      return check.providerHealthcheck === undefined || isSafeNodeProbeReason(check.providerHealthcheck);
    });
    return valid ? { node: payload.node.trim() } : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isSafeNodeProbeReason(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^(?:HTTP [1-5]\d{2}|timeout|no valid delay|request failed|fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN)$/.test(
      value
    )
  );
}

function createMihomoWarningCoalesceKey(safeMessage: string): string {
  const normalized = safeMessage
    .replace(/\btime\s*=\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\S+)/gi, 'time=[忽略]')
    .replace(/((?:\[[^\]\s]+\]|[^\s:"'()]+)):\d+(\([^)\r\n]*\))?(?=\s+-->)/g, '$1:[本地临时端口]$2');
  return `mihomo:${createHash('sha256').update(normalized).digest('hex')}`;
}

function parseMihomoDialWarning(message: string): { target: string; network: string } | undefined {
  if (
    !message.includes('[mihomo]') ||
    !/level=(?:warning|error)/i.test(message) ||
    !/\[(?:TCP|UDP)\]\s+dial/i.test(message)
  ) {
    return undefined;
  }

  const network = message.match(/\[(TCP|UDP)\]\s+dial/i)?.[1]?.toUpperCase() ?? '连接';
  const destination = message.match(/-->\s+(\[[^\]]+\]|[^:\s]+)(?::\d+)?(?=\s|$)/)?.[1];
  const rulePayload = message.match(/match\s+([A-Za-z-]+\/[^")\s]+)/i)?.[1];
  const dialTarget = message.match(/dial\s+([^ ]+)/i)?.[1];
  const target =
    normalizeDiagnosticTarget(destination) ||
    normalizeDiagnosticTarget(rulePayload?.split('/').pop()) ||
    normalizeDiagnosticTarget(dialTarget) ||
    '外部站点';
  return { target, network };
}

function normalizeDiagnosticTarget(value: string | undefined): string | undefined {
  const raw = value?.trim();
  if (!raw) return undefined;
  const bracketed = raw.match(/^\[([^\]]+)\](?::\d+)?$/);
  if (bracketed) return bracketed[1] || undefined;
  const target = (raw.match(/:/g)?.length ?? 0) <= 1 ? raw.replace(/:\d+$/, '') : raw;
  return target || undefined;
}

export function classifyDiagnosticIssue(message: string | undefined): DiagnosticIssueKind | undefined {
  if (!message?.trim()) return undefined;
  const value = message.toLowerCase();

  if (isExpectedOperationCancellation(message) || /(?:aborterror|已取消)/i.test(value)) return undefined;
  if (/(?:access (?:is )?denied|eacces|eperm|elevation|administrator|拒绝访问|权限|管理员)/i.test(value)) {
    return 'permission';
  }
  if (
    /(?:wininet|winhttp|proxyserver|proxyoverride|internetsetoption|checknetisolation|system proxy|系统代理|代理设置)/i.test(
      value
    )
  ) {
    return 'system-proxy';
  }
  if (/(?:\bdns\b|enotfound|eai_again|name resolution|lookup|resolve|域名解析|解析失败)/i.test(value)) {
    return 'dns';
  }
  if (
    /(?:mihomo|controller|lifecycle|kernel|runtime process|process exited|eaddrinuse|address already in use|内核|端口占用)/i.test(
      value
    )
  ) {
    return 'kernel';
  }
  if (/(?:traffic identity|signature|activation|重新登记|登记|身份验证|\b401\b)/i.test(value)) {
    return 'registration';
  }
  if (
    /(?:timed? ?out|econnrefused|econnreset|etimedout|fetch failed|failed to fetch|tls|certificate|connection|连接失败|网络异常)/i.test(
      value
    )
  ) {
    return 'network';
  }
  if (/(?:missing subscription|subscription|rule provider|ruleset|yaml|订阅|规则集|配置解析)/i.test(value)) {
    return 'subscription';
  }
  if (/(?:traffic endpoint|remote config|后台|远程配置)/i.test(value)) {
    return 'backend';
  }
  return 'unknown';
}

export type DiagnosticRecoveryOperation = 'subscription-refresh' | 'save-settings' | 'sync-settings';

export function isDiagnosticIssueResolvedByOperation(
  operation: DiagnosticRecoveryOperation,
  issueKind: DiagnosticIssueKind | undefined
): boolean {
  if (!issueKind) return false;
  if (operation === 'sync-settings') {
    return ['backend', 'registration', 'network', 'dns', 'subscription'].includes(issueKind);
  }
  return ['subscription', 'dns', 'network'].includes(issueKind);
}

function redactSensitiveKeyValue(
  _match: string,
  openingQuote: string,
  key: string,
  closingQuote: string,
  separator: string
): string {
  return `${openingQuote}${key}${closingQuote}${separator}[已隐藏]`;
}

export function buildDiagnosticReport(input: DiagnosticReportInput): string {
  const safeLogs = input.logs.map(toSingleSafeLine);
  const lines = [
    'YouYu 诊断日志',
    `导出时间: ${input.exportedAt.toISOString()}`,
    `版本: ${toSingleSafeLine(input.appVersion)}`,
    `通道: ${toSingleSafeLine(input.buildChannel)}`,
    `状态: ${toSingleSafeLine(input.status)}`,
    `系统: ${toSingleSafeLine(input.platform)} ${toSingleSafeLine(input.architecture)} ${toSingleSafeLine(input.osRelease)}`,
    `日志条数: ${safeLogs.length}`
  ];

  if (input.logCapacity !== undefined) {
    lines.push(`日志容量: ${normalizeNonNegativeInteger(input.logCapacity)} 条`);
  }
  if (input.droppedLogCount !== undefined) {
    lines.push(`已丢弃较早日志: ${normalizeNonNegativeInteger(input.droppedLogCount)} 条`);
  }

  if (input.features) {
    lines.push(
      `系统代理: ${formatEnabled(input.features.systemProxyEnabled)}`,
      `DNS 增强: ${formatEnabled(input.features.dnsEnhanced)}`,
      `流量识别: ${formatEnabled(input.features.snifferEnabled)}`,
      `TUN: ${formatEnabled(input.features.tunEnabled)}`
    );
  }
  if (input.runtimePorts) {
    lines.push(
      `运行端口: mixed=${input.runtimePorts.mixedPort}, controller=${input.runtimePorts.controllerPort}, dns=${input.runtimePorts.dnsPort}`
    );
  }

  lines.push('', `最近错误: ${input.lastError ? toSingleSafeLine(input.lastError) : '无'}`, '', '日志:');
  if (safeLogs.length === 0) {
    lines.push('（无）');
  } else {
    safeLogs.forEach((line, index) => lines.push(`[${String(index + 1).padStart(3, '0')}] ${line}`));
  }
  return `${lines.join('\r\n')}\r\n`;
}

export function createDiagnosticExportFileName(appVersion: string, exportedAt = new Date()): string {
  const version = appVersion.replace(/[^0-9A-Za-z._-]+/g, '_') || 'unknown';
  const timestamp = exportedAt.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  return `YouYu-diagnostics-${version}-${timestamp}.txt`;
}

export function createDiagnosticExportDefaultPath(downloadsDirectory: string, defaultFileName: string): string {
  return join(downloadsDirectory, defaultFileName);
}

export async function exportDiagnosticReport(
  input: DiagnosticReportInput,
  dependencies: DiagnosticExportDependencies
): Promise<{ canceled: boolean; exportedCount: number }> {
  const filePath = await dependencies.chooseFile(createDiagnosticExportFileName(input.appVersion, input.exportedAt));
  if (!filePath) return { canceled: true, exportedCount: 0 };
  await dependencies.writeFile(filePath, `\uFEFF${buildDiagnosticReport(input)}`);
  return { canceled: false, exportedCount: input.logs.length };
}

function redactUrl(value: string): string {
  const trailingMatch = value.match(/[).,;!?，。；！）]+$/);
  const trailing = trailingMatch?.[0] ?? '';
  const candidate = trailing ? value.slice(0, -trailing.length) : value;
  try {
    const url = new URL(candidate);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return `[已隐藏连接]${trailing}`;
    const hasPrivatePart = Boolean(url.username || url.password || url.search || url.hash || url.pathname !== '/');
    return `${url.protocol}//${url.host}${hasPrivatePart ? '/[已隐藏]' : ''}${trailing}`;
  } catch {
    return `[已隐藏网址]${trailing}`;
  }
}

function toSingleSafeLine(value: string): string {
  const line = toSafeDiagnosticLine(value);
  return line.length > 8192 ? `${line.slice(0, 8191)}…` : line;
}

function toSafeDiagnosticLine(value: string): string {
  return redactDiagnosticText(String(value))
    .replace(/[\r\n]+/g, ' ↩ ')
    .trim();
}

function boundDiagnosticMessage(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 1)}…`;
}

function boundMihomoDiagnosticMessage(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  const omissionMarker = ' …[中间省略]… ';
  if (maxLength <= omissionMarker.length + 2) return boundDiagnosticMessage(value, maxLength);
  const retainedLength = maxLength - omissionMarker.length;
  const headLength = Math.ceil(retainedLength * 0.65);
  const tailLength = retainedLength - headLength;
  return `${value.slice(0, headLength)}${omissionMarker}${value.slice(-tailLength)}`;
}

function formatDiagnosticLogEntry(entry: DiagnosticLogEntry, message: string): string {
  if (entry.occurrences === 1) return `${formatLocalDateTime(entry.lastAt)} ${message}`;
  return `${formatLocalDateTime(entry.firstAt)} - ${formatLocalDateTime(entry.lastAt)} ${message}（重复 ${entry.occurrences} 次）`;
}

function formatLocalDateTime(value: Date): string {
  return (
    [
      String(value.getFullYear()).padStart(4, '0'),
      String(value.getMonth() + 1).padStart(2, '0'),
      String(value.getDate()).padStart(2, '0')
    ].join('-') +
    ` ${String(value.getHours()).padStart(2, '0')}:${String(value.getMinutes()).padStart(2, '0')}:${String(value.getSeconds()).padStart(2, '0')}`
  );
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.max(1, Math.floor(value)) : fallback;
}

function normalizeNonNegativeInteger(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function formatEnabled(enabled: boolean): string {
  return enabled ? '开启' : '关闭';
}
