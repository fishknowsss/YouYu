import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const { version } = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
await build({
  configFile: false,
  root: fileURLToPath(new URL('site/', root)),
  base: './',
  publicDir: false,
  plugins: [react()],
  define: {
    __YOUYU_APP_VERSION__: JSON.stringify(version),
    __YOUYU_BUILD_CHANNEL__: JSON.stringify('standard'),
    __YOUYU_DISABLE_PET__: 'false'
  },
  build: {
    outDir: fileURLToPath(new URL('docs/demo/', root)),
    emptyOutDir: true,
    manifest: 'entries.json',
    rollupOptions: {
      preserveEntrySignatures: 'strict',
      output: {
        manualChunks(id) {
          if (id.includes('node_modules')) return 'react';
          if (id.includes('/renderer/components/PetSprite') || id.includes('/renderer/pet/atlas')) return 'pet-sprite';
        }
      },
      input: {
        demo: fileURLToPath(new URL('site/index.html', root)),
        pet: fileURLToPath(new URL('site/pet.tsx', root))
      }
    }
  }
});
await writeFile(new URL('docs/demo/version.json', root), JSON.stringify({ version }) + '\n');
const notices = await Promise.all(
  ['react', 'react-dom', 'scheduler'].map(async (name) => {
    const license = await readFile(new URL(`node_modules/${name}/LICENSE`, root), 'utf8');
    return `${name}\n${license.trim()}\n`;
  })
);
await writeFile(new URL('docs/demo/THIRD_PARTY_NOTICES.txt', root), notices.join('\n'));
await import('./sync-site-release.mjs');
