import { defineConfig } from 'electron-vite';
import { loadRendererBuildDefinition } from './scripts/renderer-vite-config';

const sharedRendererBuild = loadRendererBuildDefinition(__dirname);

export default defineConfig({
  main: {
    define: sharedRendererBuild.buildDefines,
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
    ...sharedRendererBuild.renderer,
    root: '.',
    build: {
      minify: 'esbuild',
      rollupOptions: {
        input: 'index.html'
      }
    }
  }
});
