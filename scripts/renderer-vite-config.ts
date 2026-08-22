import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRendererCspPlugin } from './renderer-csp';

type RendererBuildEnvironment = Record<string, string | undefined>;

type RendererBuildDefinitionInput = {
  rootDir: string;
  appVersion?: string;
  env: RendererBuildEnvironment;
};

export function createRendererBuildDefinition(input: RendererBuildDefinitionInput) {
  const disablePet = input.env.YOUYU_DISABLE_PET === '1';
  const buildChannel = input.env.YOUYU_BUILD_CHANNEL ?? (disablePet ? 'no' : 'standard');
  const buildDefines = {
    __YOUYU_APP_VERSION__: JSON.stringify(input.appVersion ?? '0.0.0'),
    __YOUYU_BUILD_CHANNEL__: JSON.stringify(buildChannel),
    __YOUYU_DISABLE_PET__: JSON.stringify(disablePet)
  };

  return {
    disablePet,
    buildChannel,
    buildDefines,
    renderer: {
      plugins: [createRendererCspPlugin(), react()],
      define: buildDefines,
      resolve: {
        alias: disablePet
          ? [
              {
                find: './PetApp',
                replacement: resolve(input.rootDir, 'src/renderer/NoPetApp.tsx')
              },
              {
                find: './pages/PetPreviewPage',
                replacement: resolve(input.rootDir, 'src/renderer/pages/NoPetPreviewPage.tsx')
              }
            ]
          : []
      }
    }
  };
}

export function loadRendererBuildDefinition(rootDir: string, env: RendererBuildEnvironment = process.env) {
  const packageJson = JSON.parse(readFileSync(resolve(rootDir, 'package.json'), 'utf8')) as { version?: string };
  return createRendererBuildDefinition({ rootDir, appVersion: packageJson.version, env });
}
