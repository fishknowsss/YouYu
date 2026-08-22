import { describe, expect, it } from 'vitest';
import { createRendererBuildDefinition } from '../../scripts/renderer-vite-config';

describe('shared renderer Vite definition', () => {
  it('uses the package version and standard channel by default', () => {
    const definition = createRendererBuildDefinition({
      rootDir: 'C:/workspace/youyu',
      appVersion: '1.7.13',
      env: {}
    });

    expect(definition.disablePet).toBe(false);
    expect(definition.buildChannel).toBe('standard');
    expect(definition.buildDefines).toEqual({
      __YOUYU_APP_VERSION__: JSON.stringify('1.7.13'),
      __YOUYU_BUILD_CHANNEL__: JSON.stringify('standard'),
      __YOUYU_DISABLE_PET__: JSON.stringify(false)
    });
    expect(definition.renderer.resolve.alias).toEqual([]);
    expect(definition.renderer.plugins).toHaveLength(2);
  });

  it('shares no-pet aliases and honors an explicit build channel', () => {
    const definition = createRendererBuildDefinition({
      rootDir: 'C:/workspace/youyu',
      appVersion: undefined,
      env: { YOUYU_DISABLE_PET: '1', YOUYU_BUILD_CHANNEL: 'in' }
    });

    expect(definition.buildChannel).toBe('in');
    expect(definition.buildDefines.__YOUYU_APP_VERSION__).toBe(JSON.stringify('0.0.0'));
    expect(definition.buildDefines.__YOUYU_DISABLE_PET__).toBe(JSON.stringify(true));
    expect(definition.renderer.resolve.alias).toEqual([
      {
        find: './PetApp',
        replacement: 'C:\\workspace\\youyu\\src\\renderer\\NoPetApp.tsx'
      },
      {
        find: './pages/PetPreviewPage',
        replacement: 'C:\\workspace\\youyu\\src\\renderer\\pages\\NoPetPreviewPage.tsx'
      }
    ]);
  });
});
