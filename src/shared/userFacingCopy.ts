import type { AppUpdateFailureKind, AppUpdateStatus } from './ipc';
import { isExpectedOperationCancellation } from './operationCancellation';

const fallbackNoticePattern = /节点均不可用，已自动切换|节点出口验证暂不可用/;
const chineseTextPattern = /[\u4e00-\u9fff]/;
const technicalEnglishPattern =
  /(?:error|failed|exception|errno|econn|enotfound|etimedout|eai_|spawn|controller|mihomo|handshake|timeout|undefined|null)/i;

export function isActionNoticeMessage(message: string): boolean {
  return fallbackNoticePattern.test(message);
}

export function isActionErrorMessage(message: string): boolean {
  if (!message || isActionNoticeMessage(message)) return false;
  return /失败|超时|错误|不可用|未加载|未获|先|没有|不对|太频繁|请重新登记/.test(message);
}

export function getActionErrorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'operation' in error) {
    const name = (error as { name?: string }).name;
    const operation = (error as { operation?: unknown }).operation;
    if (name === 'ActionTimeoutError' && typeof operation === 'string' && operation.trim()) {
      return `${operation}超时`;
    }
  }

  const message = error instanceof Error ? error.message : String(error);
  return formatActionErrorMessage(message);
}

export function formatActionErrorMessage(message: string): string {
  if (message.includes('operation timed out')) return '操作超时';
  if (isExpectedOperationCancellation(message)) return '已取消';
  if (message.includes('missing subscription url')) return '先填写订阅地址';
  if (message.includes('no usable proxy node') || message.includes('no proxy nodes')) return '没有可用节点';
  if (/没有可用的.+节点/.test(message) || message.includes('没有可用节点'))
    return message.includes('没有可用的') ? message : '没有可用节点';
  if (message.includes('核心接口未加载')) return '核心接口未加载';
  if (message.includes('traffic endpoint not configured')) return '先配置后台地址';
  if (message.includes('traffic identity required')) return '先完成登记';
  if (
    message.includes('remote config sync required') ||
    message.includes('请先同步云端配置') ||
    message.includes('云端配置尚未同步')
  ) {
    return '请先同步云端配置';
  }
  if (
    message.includes('managed config editing forbidden') ||
    message.includes('remote config update failed: 403') ||
    message.includes('未获配置修改权限')
  ) {
    return '此账号未获配置修改权限';
  }
  if (message.includes('missing traffic user name')) return '先填写姓名';
  if (message.includes('missing traffic passphrase')) return '先填写口令';
  if (message.includes('traffic activation failed: 403')) return '口令不对';
  if (message.includes('traffic activation failed: 429')) return '请求太频繁';
  if (message.includes('traffic activation failed: 5')) return '后台暂时不可用';
  if (message.includes('remote config failed: 401') || message.includes('traffic report failed: 401'))
    return '请重新登记';
  if (
    message.includes('signature required') ||
    message.includes('invalid signature') ||
    message.includes('stale signature')
  ) {
    return '请重新登记';
  }
  if (message.includes('traffic request timed out')) return '连接后台超时';
  if (message.includes('fetch failed') || message.includes('Failed to fetch')) return '连接后台失败';
  if (message.includes('update not downloaded')) return '更新还没准备好';
  if (message.includes('downloaded update version is unavailable')) return '更新版本无效';
  if (
    message.includes('update install preparation canceled') ||
    message.includes('update installer launch was canceled')
  ) {
    return '安装已取消';
  }
  if (message.includes('network repair already in progress')) return '正在修复';
  if (
    message.includes('mihomo node selection not applied') ||
    message.includes('mihomo strategy selection not applied')
  ) {
    return '切换节点失败';
  }
  if (message.includes('mihomo selector missing') || message.includes('mihomo node missing')) return '没有可用节点';
  if (message.includes('lifecycle is shutting down') || message.includes('lifecycle starts are suspended'))
    return '正在退出';
  if (
    message.includes('application cleanup already in progress') ||
    message.includes('app runtime coordinator disposed')
  ) {
    return '正在退出';
  }
  if (message.includes('node health coordinator') || message.includes('node availability')) return '节点检查未完成';
  if (message.includes('connectivity probe') || message.includes('unknown connectivity service')) return '检测失败';
  if (message.includes('operation request id already active')) return '请求太频繁';
  if (message.includes('update relaunch window did not become ready')) return '新版本窗口未就绪';
  if (message.includes('update installer launch pending')) return '正在安装更新';
  if (message.includes('当前用户用量尚未同步')) return '当前用户用量尚未同步，请稍后重试';
  if (message.includes('代理已停止，请重新启动后再选点')) return '代理已停止，请重新启动后再选点';
  if (/(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE)/i.test(message)) return '连接中断';
  if (/(?:ENOTFOUND|EAI_AGAIN|ERR_NAME_NOT_RESOLVED)/i.test(message)) return '无法连接网络';
  if (message.includes('mihomo api failed')) return '更新失败';
  if (message.includes('mihomo controller')) return '启动失败';
  if (isMostlyChineseUserCopy(message)) return toSingleLine(message);
  const prefix = message.match(/^([\u4e00-\u9fff][^:：]{0,24})[:：]/);
  if (prefix) return prefix[1];
  return '操作失败';
}

export function toVisibleDiagnosticText(value: string): string {
  const registryCommandIndex = value.search(/Command failed:\s*(?:"[^"]*[\\/])?reg\.exe\b/i);
  if (registryCommandIndex >= 0) {
    return `${value.slice(0, registryCommandIndex)}系统代理设置读取失败`.trim();
  }

  const undecodableIndex = value.search(/�{2,}/);
  if (undecodableIndex < 0) return value;
  const context = value
    .slice(0, undecodableIndex)
    .replace(/[\s↩:：;；-]+$/u, '')
    .trim();
  return context ? `${context}: 系统返回的错误信息无法识别` : '系统返回的错误信息无法识别';
}

export function toUserFacingDiagnostic(raw: string): string {
  const visible = toVisibleDiagnosticText(raw).replace(/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}\s*/, '');
  if (isActionNoticeMessage(visible)) return visible;
  const mapped = formatActionErrorMessage(visible);
  if (mapped !== '操作失败') return mapped;
  if (isMostlyChineseUserCopy(visible)) return toSingleLine(visible);
  const prefix = visible.match(/^([\u4e00-\u9fff][^:：]{0,24})[:：]/);
  if (prefix) return prefix[1];
  return mapped;
}

export function formatUpdateUserMessage(update: {
  status: AppUpdateStatus | string;
  failureKind?: AppUpdateFailureKind | string;
  message?: string;
}): string {
  const message = update.message ?? '';
  if (update.failureKind === 'refresh-check-failed') return '未能确认最新版，请重试';
  if (isUpdatePermissionFailure(message, update.failureKind)) return '未允许安装';
  if (update.failureKind === 'installer-launch-failed' || isInstallerLaunchFailure(message)) {
    return '安装器未能启动，请重试';
  }
  if (update.status === 'failed' && isUpdateNetworkFailure(message)) return '下载失败，请检查网络后重试';
  if (message.includes('更新安装未完成') || message.includes('已重新打开当前版本')) return '安装未完成，请重新检查';
  if (update.status === 'failed') return formatLegacyUpdateFailure(message);
  if (update.status === 'downloaded' && message) return '安装未开始，请重试';
  return '';
}

export function formatLegacyUpdateFailure(message: string | undefined): string {
  if (!message) return '失败：原因未知';
  const channelFile = message.match(/(latest(?:-in|-no)?\.yml)/)?.[1];
  if (message.includes('Cannot find') && channelFile) return `失败：GitHub Release 缺少 ${channelFile}`;
  if (message.includes('404')) return '失败：GitHub Release 未发布或资源不存在';
  if (isUpdateNetworkFailure(message)) return '失败：无法连接 GitHub';
  if (message.includes('net::ERR_INTERNET_DISCONNECTED')) return '失败：网络未连接';
  return '失败：请稍后重试';
}

export function classifyUpdateInstallFailure(error: unknown): AppUpdateFailureKind {
  const message = error instanceof Error ? error.message : String(error);
  if (isUpdatePermissionFailure(message)) return 'permission-denied';
  if (isUpdateNetworkFailure(message)) return 'download-failed';
  return 'installer-launch-failed';
}

function isUpdatePermissionFailure(message: string, failureKind?: string): boolean {
  if (failureKind === 'permission-denied') return true;
  return /canceled by the user|cancelled by the user|user canceled|user cancelled|1223|elevation (?:was )?denied|用户取消|未允许安装/i.test(
    message
  );
}

function isInstallerLaunchFailure(message: string): boolean {
  return /elevated update installer|installer launch|handoff|spawn failed|did not start/i.test(message);
}

function isUpdateNetworkFailure(message: string): boolean {
  return /ENOTFOUND|EAI_AGAIN|ERR_NAME_NOT_RESOLVED|ERR_CONNECTION|ETIMEDOUT|fetch failed|Failed to fetch|net::ERR_/i.test(
    message
  );
}

function isMostlyChineseUserCopy(message: string): boolean {
  if (!chineseTextPattern.test(message) || technicalEnglishPattern.test(message)) return false;
  const tail = message.split(/[:：]/).slice(1).join(':');
  return !/[A-Za-z]{4,}/.test(tail);
}

function toSingleLine(message: string): string {
  return message.replace(/\s+/g, ' ').trim();
}
