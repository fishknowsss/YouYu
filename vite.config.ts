import { defineConfig } from 'vite';
import { loadRendererBuildDefinition } from './scripts/renderer-vite-config';

const sharedRendererBuild = loadRendererBuildDefinition(__dirname);

export default defineConfig({
  ...sharedRendererBuild.renderer,
  server: {
    watch: {
      ignored: ['**/out/**', '**/release/**', '**/node_modules/**']
    }
  }
});
