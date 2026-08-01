import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('main-process fire-and-forget safety', () => {
  it('handles asynchronous window creation failures from the restore path', async () => {
    const source = await readFile('src/main/index.ts', 'utf8');
    const showMainWindow = source.slice(
      source.indexOf('function showMainWindow'),
      source.indexOf('function sendPetState')
    );

    expect(showMainWindow).toContain("void createWindow().catch((error) => recordError('创建主窗口失败', error))");
    expect(showMainWindow).not.toContain('void createWindow();');
  });

  it('absorbs and records desktop-pet position persistence failures', async () => {
    const source = await readFile('src/main/index.ts', 'utf8');
    const savePetBounds = source.slice(
      source.indexOf('function savePetBounds'),
      source.indexOf('function setPetMousePassthrough')
    );

    expect(savePetBounds).toContain('void settingsStore');
    expect(savePetBounds).toContain('.update({');
    expect(savePetBounds).toContain('.catch((error) => appendLog(`保存桌宠位置失败: ${formatError(error)}`))');
  });

  it('handles fallible desktop-pet creation, docking, and exit cleanup calls', async () => {
    const source = await readFile('src/main/index.ts', 'utf8');

    expect(source).not.toContain('void createPetWindow();');
    expect(source).not.toContain('void dockPetToBottomRight();');
    expect(source).not.toContain('void cleanupBeforeExit();');
    expect(source).toContain("void createPetWindow().catch((error) => recordError('创建桌宠窗口失败', error))");
    expect(source).toContain(
      'void dockPetToBottomRight().catch((error) => appendLog(`桌宠贴边失败: ${formatError(error)}`))'
    );
    expect(
      source.match(/void cleanupBeforeExit\(\)\.catch\(\(error\) => recordError\('退出清理失败', error\)\)/g)
    ).toHaveLength(4);
  });
});
