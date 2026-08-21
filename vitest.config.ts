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
    setupFiles: ['./tests/setup/windowsPowerShellEnvironment.ts'],
    hookTimeout: 15_000,
    testTimeout: 15_000,
    exclude: [...configDefaults.exclude, 'cloudflare/youyu-traffic/test/**'],
    coverage: {
      provider: 'v8',
      reportsDirectory: 'coverage/critical',
      reporter: ['text', 'json-summary', 'lcov'],
      include: [
        'src/main/connectivity.ts',
        'src/main/deviceAuth.ts',
        'src/main/diagnostics.ts',
        'src/main/http/boundedBody.ts',
        'src/main/networkRepair.ts',
        'src/main/platform/systemProxy.ts',
        'src/main/remoteConfig.ts',
        'src/main/runtimePorts.ts',
        'src/main/runtimeRecoveryPolicy.ts',
        'src/main/traffic/journal.ts',
        'src/main/traffic/reporter.ts',
        'src/main/traffic/store.ts',
        'src/main/updateInstallHandoff.ts'
      ],
      thresholds: {
        lines: 80,
        statements: 80,
        functions: 80,
        branches: 70
      }
    }
  }
});
