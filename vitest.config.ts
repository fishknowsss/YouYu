import { readFileSync } from 'node:fs';
import { configDefaults, defineConfig } from 'vitest/config';

const packageJson = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version?: string;
};

export default defineConfig({
  define: {
    __YOUYU_APP_VERSION__: JSON.stringify(packageJson.version ?? '0.0.0'),
    __YOUYU_BUILD_CHANNEL__: JSON.stringify('standard'),
    __YOUYU_DISABLE_PET__: JSON.stringify(false)
  },
  test: {
    exclude: [...configDefaults.exclude, 'cloudflare/youyu-traffic/test/**']
  }
});
