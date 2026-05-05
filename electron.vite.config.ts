import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const disablePet = process.env.YOUYU_DISABLE_PET === '1';
const packageJson = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8')) as {
  version?: string;
};
const buildChannel = process.env.YOUYU_BUILD_CHANNEL ?? (disablePet ? 'no' : 'standard');
const buildDefines = {
  __YOUYU_APP_VERSION__: JSON.stringify(packageJson.version ?? '0.0.0'),
  __YOUYU_BUILD_CHANNEL__: JSON.stringify(buildChannel),
  __YOUYU_DISABLE_PET__: JSON.stringify(disablePet)
};

export default defineConfig({
  main: {
    define: buildDefines,
    build: {
      rollupOptions: {
        input: 'src/main/index.ts'
      }
    }
  },
  preload: {
    build: {
      rollupOptions: {
        input: 'src/preload/index.ts',
        output: {
          format: 'cjs',
          entryFileNames: '[name].cjs'
        }
      }
    }
  },
  renderer: {
    define: buildDefines,
    resolve: {
      alias: disablePet
        ? [
            {
              find: './PetApp',
              replacement: resolve(__dirname, 'src/renderer/NoPetApp.tsx')
            }
          ]
        : []
    },
    plugins: [react()],
    root: '.',
    build: {
      rollupOptions: {
        input: 'index.html'
      }
    }
  }
});
