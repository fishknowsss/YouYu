// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UserNoticeBanner } from '../../src/renderer/components/UserNoticeBanner';
import type { UserNotice } from '../../src/shared/ipc';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  vi.useRealTimers();
});

describe('targeted user notice', () => {
  it.each([
    ['info', 'status', '通知'],
    ['warning', 'alert', '重要通知']
  ] as const)('renders %s as escaped plain text with its semantic state', async (tone, role, title) => {
    const container = await renderNotice(createNotice(tone, '<b>今晚维护</b>'));

    expect(container.querySelector(`[role="${role}"]`)).not.toBeNull();
    expect(container.querySelector('.user-notice-banner')?.classList.contains(tone)).toBe(true);
    expect(container.textContent).toContain(title);
    expect(container.textContent).toContain('<b>今晚维护</b>');
    expect(container.querySelector('b')).toBeNull();
  });

  it('acknowledges from both the confirmation and close controls', async () => {
    const acknowledge = vi.fn(async () => false);
    const container = await renderNotice(createNotice('info', '测试通知'), acknowledge);
    const confirm = findButton(container, '知道了');

    await act(async () => confirm?.click());
    expect(acknowledge).toHaveBeenLastCalledWith(3);

    const close = container.querySelector<HTMLButtonElement>('[aria-label="关闭通知"]');
    await act(async () => close?.click());
    expect(acknowledge).toHaveBeenCalledTimes(2);
  });

  it('hides expired or invalid notices', async () => {
    const expired = createNotice('warning', '已过期');
    expired.expiresAt = new Date(Date.now() - 1000).toISOString();
    const container = await renderNotice(expired);
    expect(container.querySelector('.user-notice-banner')).toBeNull();

    await act(async () =>
      root?.render(<UserNoticeBanner notice={{ ...expired, expiresAt: 'invalid' }} onAcknowledge={() => true} />)
    );
    expect(container.querySelector('.user-notice-banner')).toBeNull();
  });

  it('automatically hides when the displayed notice reaches its expiry', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-02T00:00:00.000Z'));
    const notice = createNotice('info', '即将到期');
    notice.expiresAt = new Date(Date.now() + 1000).toISOString();
    const container = await renderNotice(notice);
    expect(container.querySelector('.user-notice-banner')).not.toBeNull();

    await act(async () => vi.advanceTimersByTime(1001));

    expect(container.querySelector('.user-notice-banner')).toBeNull();
  });

  it('keeps long message content scrollable while the confirmation row stays in the viewport', () => {
    const styles = readFileSync(join(process.cwd(), 'src/renderer/styles/user-notice.css'), 'utf8');
    expect(styles).toMatch(
      /\.user-notice-banner\s*\{[^}]*max-height:\s*calc\(100vh - 88px\);[^}]*overflow:\s*hidden;/s
    );
    expect(styles).toMatch(/\.user-notice-copy\s*\{[^}]*max-height:\s*calc\(100vh - 180px\);[^}]*overflow:\s*auto;/s);
    expect(styles).toMatch(/\.user-notice-confirm\s*\{[^}]*grid-column:\s*2 \/ 4;/s);
  });
});

async function renderNotice(notice: UserNotice, onAcknowledge = async () => true): Promise<HTMLElement> {
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(<UserNoticeBanner notice={notice} onAcknowledge={onAcknowledge} />));
  return container;
}

function createNotice(tone: UserNotice['tone'], message: string): UserNotice {
  return {
    revision: 3,
    tone,
    message,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    updatedAt: new Date().toISOString()
  };
}

function findButton(container: HTMLElement, text: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === text);
}
