import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRendererCspPlugin } from './scripts/renderer-csp';

const disablePet = process.env.YOUYU_DISABLE_PET === '1';
const packageJson = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8')) as {
  version?: string;
};
const buildChannel = process.env.YOUYU_BUILD_CHANNEL ?? (disablePet ? 'no' : 'standard');

export default defineConfig({
  plugins: [createRendererCspPlugin(), react()],
  define: {
    __YOUYU_APP_VERSION__: JSON.stringify(packageJson.version ?? '0.0.0'),
    __YOUYU_BUILD_CHANNEL__: JSON.stringify(buildChannel),
    __YOUYU_DISABLE_PET__: JSON.stringify(disablePet)
  },
  resolve: {
    alias: disablePet
      ? [
          {
            find: './PetApp',
            replacement: resolve(__dirname, 'src/renderer/NoPetApp.tsx')
          },
          {
            find: './pages/PetPreviewPage',
            replacement: resolve(__dirname, 'src/renderer/pages/NoPetPreviewPage.tsx')
          }
        ]
      : []
  },
  server: {
    watch: {
      ignored: ['**/out/**', '**/release/**', '**/node_modules/**']
    }
  }
});
