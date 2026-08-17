import { describe, expect, it } from 'vitest';
import {
  formatUpdateUserMessage,
  getActionErrorMessage,
  isActionErrorMessage,
  isActionNoticeMessage,
  toUserFacingDiagnostic
} from '../../src/shared/userFacingCopy';

describe('user-facing copy', () => {
  it('does not treat a successful region fallback as an error', () => {
    const fallback = '日本节点均不可用，已自动切换至美国节点';
    const verifyFallback = '日本节点出口验证暂不可用，已使用当前可用节点';

    expect(isActionErrorMessage(fallback)).toBe(false);
    expect(isActionErrorMessage(verifyFallback)).toBe(false);
    expect(isActionNoticeMessage(fallback)).toBe(true);
    expect(isActionNoticeMessage(verifyFallback)).toBe(true);
  });

  it('still treats real failures as errors', () => {
    expect(isActionErrorMessage('没有可用节点')).toBe(true);
    expect(isActionErrorMessage('没有可用的日本节点')).toBe(true);
    expect(isActionErrorMessage('先填写订阅地址')).toBe(true);
    expect(isActionErrorMessage('操作失败')).toBe(true);
  });

  it('maps leftover English errors instead of always saying 操作失败', () => {
    expect(getActionErrorMessage(new Error('update not downloaded'))).toBe('更新还没准备好');
    expect(getActionErrorMessage(new Error('proxy start canceled'))).toBe('已取消');
    expect(getActionErrorMessage(new Error('network repair already in progress'))).toBe('正在修复');
    expect(getActionErrorMessage(new Error('mihomo node selection not applied: expected 日本, got 香港'))).toBe(
      '切换节点失败'
    );
    expect(getActionErrorMessage(new Error('ECONNRESET'))).toBe('连接中断');
    expect(getActionErrorMessage(new Error('some totally unknown boom'))).toBe('操作失败');
  });

  it('keeps already-Chinese messages and strips English tails from lastError', () => {
    expect(toUserFacingDiagnostic('请先同步云端配置')).toBe('请先同步云端配置');
    expect(toUserFacingDiagnostic('启动失败: mihomo controller not ready on 127.0.0.1:9090')).toBe('启动失败');
    expect(
      toUserFacingDiagnostic(
        '2026-08-01 22:27:38 启动失败: Command failed: reg.exe query HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings /v ProxyServer'
      )
    ).toBe('启动失败: 系统代理设置读取失败');
    expect(toUserFacingDiagnostic('启动失败: some totally unknown boom')).toBe('启动失败');
  });

  it('distinguishes update permission, installer launch, and download failures', () => {
    expect(
      formatUpdateUserMessage({
        status: 'downloaded',
        failureKind: 'installer-launch-failed',
        message: '启动安装器失败: The operation was canceled by the user. (1223)'
      })
    ).toBe('未允许安装');
    expect(
      formatUpdateUserMessage({
        status: 'downloaded',
        failureKind: 'installer-launch-failed',
        message: '启动安装器失败: elevated update installer exited before the app handoff completed'
      })
    ).toBe('安装器未能启动，请重试');
    expect(
      formatUpdateUserMessage({
        status: 'failed',
        message: 'net::ERR_CONNECTION_TIMED_OUT'
      })
    ).toBe('下载失败，请检查网络后重试');
    expect(
      formatUpdateUserMessage({
        status: 'downloaded',
        failureKind: 'refresh-check-failed',
        message: '检查新版失败: net::ERR_CONNECTION_TIMED_OUT'
      })
    ).toBe('未能确认最新版，请重试');
  });
});
