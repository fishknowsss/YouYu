import { describe, expect, it, vi } from 'vitest';
import { createTrustedIpcMain } from '../../src/main/trustedIpcMain';
import { ipcChannels } from '../../src/shared/ipc';

function createHarness(options: { isDev?: boolean; rendererUrl?: string } = {}) {
  const listeners = new Map<string, (...args: unknown[]) => unknown>();
  const mainFrame = { url: options.isDev ? 'http://127.0.0.1:5173/' : 'file:///app/renderer/index.html' };
  const noticeFrame = { url: mainFrame.url };
  const petFrame = { url: mainFrame.url };
  const main = { mainFrame };
  const notice = { mainFrame: noticeFrame };
  const pet = { mainFrame: petFrame };
  const ipcMain = {
    handle: vi.fn((channel: string, listener: (...args: unknown[]) => unknown) => {
      listeners.set(channel, listener);
    })
  };
  const trusted = createTrustedIpcMain({
    ipcMain,
    getMainWebContents: () => main as never,
    getNoticeWebContents: () => notice as never,
    getPetWebContents: () => pet as never,
    isDev: options.isDev ?? false,
    rendererUrl: options.rendererUrl
  });

  return {
    trusted,
    main,
    notice,
    pet,
    invoke(channel: string, sender: typeof main, args: unknown[] = [], senderFrame = sender.mainFrame) {
      const listener = listeners.get(channel);
      if (!listener) throw new Error(`missing listener: ${channel}`);
      return listener({ sender, senderFrame }, ...args);
    }
  };
}

describe('createTrustedIpcMain', () => {
  it('keeps role authorization, main-frame trust, and argument parsing in one fail-closed seam', async () => {
    const harness = createHarness();
    const getSnapshot = vi.fn(async () => 'snapshot');
    const getNotice = vi.fn(async () => 'notice');
    const selectNode = vi.fn(async (_event: unknown, node: string) => node);
    harness.trusted.handle(ipcChannels.getSnapshot, getSnapshot);
    harness.trusted.handle(ipcChannels.getDesktopNoticeSnapshot, getNotice);
    harness.trusted.handle(ipcChannels.selectNode, selectNode);

    await expect(harness.invoke(ipcChannels.getSnapshot, harness.main)).resolves.toBe('snapshot');
    await expect(harness.invoke(ipcChannels.getSnapshot, harness.notice)).rejects.toThrow(
      'IPC channel is not available to the notice window'
    );
    await expect(harness.invoke(ipcChannels.getDesktopNoticeSnapshot, harness.notice)).resolves.toBe('notice');
    await expect(
      harness.invoke(ipcChannels.getSnapshot, harness.main, [], { url: 'file:///app/renderer/child.html' })
    ).rejects.toThrow('untrusted IPC sender');
    await expect(harness.invoke(ipcChannels.selectNode, harness.main, ['  日本 01  '])).resolves.toBe('日本 01');
    expect(selectNode).toHaveBeenCalledWith(expect.anything(), '日本 01');
  });

  it('accepts only the configured development origin and rejects unknown senders', async () => {
    const harness = createHarness({ isDev: true, rendererUrl: 'http://127.0.0.1:5173/' });
    harness.trusted.handle(ipcChannels.getSnapshot, async () => 'snapshot');

    await expect(harness.invoke(ipcChannels.getSnapshot, harness.main)).resolves.toBe('snapshot');
    harness.main.mainFrame.url = 'http://127.0.0.1:5174/';
    await expect(harness.invoke(ipcChannels.getSnapshot, harness.main)).rejects.toThrow('untrusted IPC sender');
    harness.main.mainFrame.url = 'http://127.0.0.1:5173/';
    await expect(harness.invoke(ipcChannels.getSnapshot, { mainFrame: harness.main.mainFrame })).rejects.toThrow(
      'untrusted IPC sender'
    );
  });
});
