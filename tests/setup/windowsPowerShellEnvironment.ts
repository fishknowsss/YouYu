import {
  windowsPowerShellModuleAnalysisCacheEnvironment,
  windowsPowerShellModulePathEnvironment
} from '../../src/main/platform/windowsPowerShell';

// Vitest workers inherit the shell that started npm. Remove PowerShell 7's module and cache overrides
// before any fixture can launch Windows PowerShell 5.1, while keeping the default file-parallel topology.
for (const key of Object.keys(process.env)) {
  const normalizedKey = key.toLowerCase();
  if (
    normalizedKey === windowsPowerShellModulePathEnvironment.toLowerCase() ||
    normalizedKey === windowsPowerShellModuleAnalysisCacheEnvironment.toLowerCase()
  ) {
    delete process.env[key];
  }
}
