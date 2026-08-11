import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('Windows upgrade installer safety', () => {
  it('waits only on an authenticated SID/session handoff and never controls another user process', async () => {
    const installer = await readFile('build/installer.nsh', 'utf8');
    const processScript = await readFile('build/manage-installed-process.ps1', 'utf8');
    const implicitHandoffLookup = processScript.slice(
      processScript.indexOf('function Find-ImplicitUpdateHandoff'),
      processScript.indexOf('function Get-HandoffBoundary')
    );

    expect(installer).toContain('!macro customCheckAppRunning');
    expect(installer).toContain('!macro customInstall');
    expect(installer).toContain('!include FileFunc.nsh');
    expect(installer).toContain('Function YouYuApplyUpdateHandoffArguments');
    expect(installer).toContain('${GetParameters} $R0');
    expect(installer).toContain('${GetOptions} $R0 "--youyu-handoff-path" $R2');
    expect(installer).toContain('StrCmp $R7 "--youyu-" YouYuCountHandoffArgumentFound');
    expect(installer).toContain(
      'IntCmp $R2 $R5 YouYuCountHandoffArgumentsDone YouYuReadHandoffArgumentCharacter YouYuCountHandoffArgumentsDone'
    );
    expect(installer).toContain('Kernel32::SetEnvironmentVariable');
    expect(installer).toContain('SetEnvironmentVariable(t "PSModulePath", p 0)');
    expect(installer).toContain('SetEnvironmentVariable(t "PSModuleAnalysisCachePath", t "NUL")');
    expect(installer.indexOf('!insertmacro YouYuPrepareWindowsPowerShellEnvironment')).toBeLessThan(
      installer.indexOf('Call YouYuApplyUpdateHandoffArguments')
    );
    const customCheckAppRunning = installer.slice(
      installer.indexOf('!macro customCheckAppRunning'),
      installer.indexOf('!macroend', installer.indexOf('!macro customCheckAppRunning'))
    );
    expect(customCheckAppRunning).toMatch(
      /!ifdef BUILD_UNINSTALLER[\s\S]*?!insertmacro YouYuPrepareWindowsPowerShellEnvironment[\s\S]*?Call un\.YouYuValidateInstallBoundary/
    );
    expect(installer).toContain('Call YouYuConsumeInstallHandoff');
    expect(installer).toContain('manage-installed-process.ps1');
    expect(installer).toContain('-Action WaitForExit');
    expect(installer).toContain('-Action Consume');
    expect(installer).toContain('-RequireHandoff');
    expect(installer).toContain('-AllowLegacyUpdateBridge');
    expect(installer).toContain('-InstallerVersion "${VERSION}"');
    expect(installer).toContain('IfSilent');
    expect(installer).toMatch(/YouYuBoundaryFailedSilent:\r?\n\s+SetErrorLevel 2/);
    expect(installer).toContain('-ExecutionPolicy RemoteSigned');
    expect(installer).not.toContain('-ExecutionPolicy Bypass');
    expect(installer).not.toContain('--shutdown-for-install');
    expect(installer).not.toContain('YouYuRestoreOwnedProxyBeforeForceClose');
    expect(installer).not.toContain('restore-owned-proxy.ps1');
    expect(installer).not.toContain('-Action CloseWindow');
    expect(installer).not.toContain('-Action Force');

    expect(processScript).toContain("[ValidateSet('WaitForExit', 'Verify', 'AcknowledgeAndWait', 'Consume')]");
    expect(processScript).toContain("GetEnvironmentVariable('YOUYU_UPDATE_HANDOFF_PATH')");
    expect(processScript).toContain("GetEnvironmentVariable('YOUYU_UPDATE_TARGET_USER_SID')");
    expect(processScript).toContain("GetEnvironmentVariable('YOUYU_UPDATE_TARGET_SESSION_ID')");
    expect(processScript).toContain('GetOwner([Security.Principal.SecurityIdentifier])');
    expect(processScript).toContain('Get-CimInstance -ClassName Win32_Process');
    expect(processScript).toContain('belongs to a different user SID');
    expect(processScript).toContain('belongs to a different Windows session');
    expect(processScript).toContain("$Action -ne 'Verify'");
    expect(processScript).toContain("$legacyBridgeTargetVersion = '1.7.0'");
    expect(processScript).toContain('$legacyBridgeMaximumSourceVersion = [Version]::new(1, 6, 8, 0)');
    expect(processScript).toContain("$productName -cne 'YouYu'");
    expect(processScript).toContain("$companyName -cne '118 Studio'");
    expect(processScript).toContain('if ($legacyBridgeActive) { exit 10 }');
    expect(processScript).toContain('[IO.File]::Move($Boundary.Path, $claimedPath)');
    expect(processScript).toContain('Remove-Item -LiteralPath $claimedPath -Force -ErrorAction Stop');
    expect(processScript).not.toContain('Remove-Item -LiteralPath $boundary.Path');
    expect(processScript).not.toContain('Get-Process');
    expect(processScript).not.toContain('CloseMainWindow');
    expect(processScript).not.toContain('Stop-Process');
    expect(processScript).toContain('[Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)');
    expect(processScript).toContain("-Filter 'youyu-update-handoff-*.json'");
    expect(processScript).toContain('$implicitHandoffDiscoveryLifetimeMs = 300000L');
    expect(processScript).toContain('function Write-AuthenticatedUpdateAcknowledgement');
    expect(processScript).toContain('function Wait-ForAuthenticatedProcessExit');
    expect(processScript).toContain("if ($Action -eq 'AcknowledgeAndWait')");
    expect(processScript).toContain('SetAccessRuleProtection($true, $false)');
    expect(processScript).toContain('[IO.File]::GetAccessControl');
    expect(processScript).toContain('[IO.File]::SetAccessControl');
    expect(processScript).not.toContain('Get-Acl');
    expect(processScript).not.toContain('Set-Acl');
    expect(processScript).not.toContain('Import-Module');
    expect(processScript).not.toContain('$acl.Access');
    expect(processScript).toContain('Remove-AuthenticatedUpdateAcknowledgement $Boundary');
    expect(implicitHandoffLookup.indexOf('$candidateItems.Count -eq 0')).toBeLessThan(
      implicitHandoffLookup.indexOf('$identity = Get-CurrentInstallerBoundaryIdentity')
    );
    expect(implicitHandoffLookup.indexOf('$prefilterExecutablePath -ine $ExpectedExecutablePath')).toBeLessThan(
      implicitHandoffLookup.indexOf('$identity = Get-CurrentInstallerBoundaryIdentity')
    );
    expect(implicitHandoffLookup.indexOf('$identity = Get-CurrentInstallerBoundaryIdentity')).toBeLessThan(
      implicitHandoffLookup.indexOf('[IO.File]::GetAccessControl($item.FullName)')
    );
    expect(processScript).not.toMatch(/HKCU|\$env:LOCALAPPDATA/i);
    expect(processScript).not.toContain('Get-ChildItem C:\\Users');
    expect(installer).not.toMatch(/HKCU|APPDATA|LOCALAPPDATA/i);
  });

  it('limits the no-handoff bridge to a stock updater launch and skips consumption only for that mode', async () => {
    const installer = await readFile('build/installer.nsh', 'utf8');
    const updater = await readFile('node_modules/electron-updater/out/NsisUpdater.js', 'utf8');
    const customInit = installer.slice(
      installer.indexOf('!macro customInit'),
      installer.indexOf('!macroend', installer.indexOf('!macro customInit'))
    );
    const validate = installer.slice(
      installer.indexOf('Function YouYuValidateInstallBoundary'),
      installer.indexOf('FunctionEnd', installer.indexOf('Function YouYuValidateInstallBoundary'))
    );
    const customInstall = installer.slice(
      installer.indexOf('!macro customInstall'),
      installer.indexOf('!macroend', installer.indexOf('!macro customInstall'))
    );
    const acknowledge = installer.slice(
      installer.indexOf('Function YouYuAcknowledgeAndWaitUpdateHandoff'),
      installer.indexOf('FunctionEnd', installer.indexOf('Function YouYuAcknowledgeAndWaitUpdateHandoff'))
    );

    expect(updater).toContain('const args = ["--updated"]');
    expect(updater).toContain('args.push("/S")');
    expect(customInit).toContain('${If} ${isUpdated}');
    expect(customInit).toContain('StrCpy $YouYuIsUpdaterLaunch "1"');
    expect(customInit.indexOf('Call YouYuApplyUpdateHandoffArguments')).toBeLessThan(
      customInit.indexOf('Call YouYuValidateInstallBoundary')
    );
    expect(validate).toContain('$YouYuIsUpdaterLaunch == "1"');
    expect(validate.indexOf('YouYuOptionalHandoff:')).toBeLessThan(validate.indexOf('YouYuRequireHandoff:'));
    expect(
      validate.slice(validate.indexOf('YouYuOptionalHandoff:'), validate.indexOf('YouYuRequireHandoff:'))
    ).not.toContain('-AllowLegacyUpdateBridge');
    expect(
      validate.slice(validate.indexOf('YouYuRequireHandoff:'), validate.indexOf('YouYuCheckBoundaryResult:'))
    ).toContain('-AllowLegacyUpdateBridge');
    expect(customInstall).toContain('$YouYuLegacyUpdateBridge != "1"');
    expect(customInstall).toContain('Call YouYuConsumeInstallHandoff');
    expect(customInit).toContain('Call YouYuAcknowledgeAndWaitUpdateHandoff');
    expect(customInit).toContain('IfSilent YouYuAcknowledgeSilentUpdate YouYuValidateInitialInstallBoundary');
    expect(acknowledge).toContain('StrCpy $YouYuHandoffValidated "1"');
    expect(acknowledge).toContain('StrCpy $YouYuInitialBoundaryWaited "1"');
  });

  it('keeps every pre-install boundary check non-consuming and consumes only from the post-write hook', async () => {
    const installer = await readFile('build/installer.nsh', 'utf8');
    const template = await readFile('node_modules/app-builder-lib/templates/nsis/installer.nsi', 'utf8');
    const installSection = await readFile('node_modules/app-builder-lib/templates/nsis/installSection.nsh', 'utf8');
    const config = await readFile('electron-builder.yml', 'utf8');
    const customInit = installer.slice(
      installer.indexOf('!macro customInit'),
      installer.indexOf('!macroend', installer.indexOf('!macro customInit'))
    );
    const customCheck = installer.slice(
      installer.indexOf('!macro customCheckAppRunning'),
      installer.indexOf('!macroend', installer.indexOf('!macro customCheckAppRunning'))
    );
    const customInstall = installer.slice(
      installer.indexOf('!macro customInstall'),
      installer.indexOf('!macroend', installer.indexOf('!macro customInstall'))
    );

    expect(config).toMatch(/nsis:[\s\S]*?perMachine:\s*true/);
    expect(customInit).toContain('Call YouYuValidateInstallBoundary');
    expect(customCheck).toContain('Call YouYuValidateInstallBoundary');
    expect(customInit).not.toContain('Consume');
    expect(customCheck).not.toContain('Consume');
    expect(customInstall).toContain('Call YouYuConsumeInstallHandoff');
    expect(customInstall).not.toContain('YouYuValidateInstallBoundary');
    expect(template.indexOf('!insertmacro customInit')).toBeLessThan(template.indexOf('!include "installSection.nsh"'));
    expect(installSection.indexOf('!insertmacro CHECK_APP_RUNNING')).toBeLessThan(
      installSection.indexOf('!insertmacro customInstall')
    );
    expect(installSection.indexOf('!insertmacro installApplicationFiles')).toBeLessThan(
      installSection.indexOf('!insertmacro customInstall')
    );
    expect(installSection.indexOf('!insertmacro registryAddInstallInfo')).toBeLessThan(
      installSection.indexOf('!insertmacro customInstall')
    );
  });

  it('cleans only fully verified app-owned startup tasks during a real uninstall', async () => {
    const installer = await readFile('build/installer.nsh', 'utf8');
    const cleanupScript = await readFile('build/cleanup-startup-tasks.ps1', 'utf8');
    const uninstallMacro = installer.slice(
      installer.indexOf('!macro customUnInstall'),
      installer.indexOf('!macroend', installer.indexOf('!macro customUnInstall'))
    );

    expect(uninstallMacro).toContain('${IfNot} ${isUpdated}');
    expect(uninstallMacro).toContain('cleanup-startup-tasks.ps1');
    expect(uninstallMacro).toContain('-Action Cleanup');
    expect(uninstallMacro).toContain(String.raw`-ExecutablePath "$INSTDIR\YouYu.exe"`);
    expect(installer).not.toContain('/Delete /TN "YouYu"');
    expect(installer).not.toContain('schtasks.exe');
    expect(cleanupScript).toContain('GetTasks(1) # TASK_ENUM_HIDDEN');
    expect(cleanupScript).toContain('$settings.DtdProcessing = [System.Xml.DtdProcessing]::Prohibit');
    expect(cleanupScript).toContain('$settings.XmlResolver = $null');
    expect(cleanupScript).toContain('if (([string] $Entry.Path) -ine "\\$name")');
    expect(cleanupScript).toContain("'^YouYu-Startup-(S-1-");
    expect(cleanupScript).toContain("if ($Name -ieq 'YouYu')");
    expect(cleanupScript).toContain('$principalSid -cne $candidateSid');
    expect(cleanupScript).toContain('$triggers.Count -ne 1');
    expect(cleanupScript).toContain('$actions.Count -ne 1');
    expect(cleanupScript).toContain('$command -ine $ExpectedExecutablePath');
    expect(cleanupScript).toContain("$arguments[0].InnerText.Trim() -cne '--hidden'");
    expect(cleanupScript).toContain('Re-read and re-validate immediately before deletion');
    expect(cleanupScript).toContain('$folder.DeleteTask($candidate.Name, 0)');
  });

  it('launches the installed app through the original non-elevated shell identity', async () => {
    const installer = await readFile('build/installer.nsh', 'utf8');
    const finishFunction = installer.slice(
      installer.indexOf('Function YouYuFinishPageLeave'),
      installer.indexOf('FunctionEnd', installer.indexOf('Function YouYuFinishPageLeave'))
    );

    expect(finishFunction).toContain('${StdUtils.ExecShellAsUser}');
    expect(finishFunction).not.toContain('ExecShell "open"');
    expect(installer.indexOf('!macro customHeader')).toBeLessThan(installer.indexOf('Function YouYuFinishPageLeave'));
  });

  it('ships an isolated compile-and-run smoke for the exact production handoff macros', async () => {
    const smoke = await readFile('scripts/smoke-installer-handoff.ps1', 'utf8');
    const init = smoke.indexOf('!insertmacro customInit');
    const check = smoke.indexOf('!insertmacro customCheckAppRunning');
    const marker = smoke.indexOf('FileWrite $0 "installed"');
    const install = smoke.indexOf('!insertmacro customInstall');

    expect(smoke).toContain('build/installer.nsh');
    expect(smoke).toContain("[Environment]::SetEnvironmentVariable('NSISDIR', $nsisRoot, 'Process')");
    expect(smoke).toContain('RequestExecutionLevel user');
    expect(smoke).toContain('!include "FileFunc.nsh"');
    expect(smoke).toContain('!macro _isUpdated _a _b _t _f');
    expect(smoke).toContain('VIProductVersion "1.6.8.0"');
    expect(smoke).toContain('installed:1');
    expect(smoke).toContain('runningTarget');
    expect(smoke).toContain('partialHandoff');
    expect(smoke).toContain('explicitCli');
    expect(smoke).toContain('unknownCli');
    expect(smoke).toContain('implicitFallback');
    expect(smoke).toContain('Write-Handoff $implicitHandoffPath $implicitNonce');
    expect(smoke).toContain('The no-environment/no-CLI fallback did not use an authenticated handoff.');
    expect(smoke).toContain('The NSIS handoff parser accepted an unknown YouYu bridge argument.');
    expect(smoke).toContain('fresh');
    expect(init).toBeGreaterThan(-1);
    expect(init).toBeLessThan(check);
    expect(check).toBeLessThan(marker);
    expect(marker).toBeLessThan(install);
    expect(smoke).not.toMatch(/WriteReg|DeleteReg|schtasks\.exe|restore-owned-proxy|system proxy/i);
  });

  it('keeps the standalone proxy restore script ownership-guarded without invoking it as the elevated installer user', async () => {
    const installer = await readFile('build/installer.nsh', 'utf8');
    const restoreScript = await readFile('build/restore-owned-proxy.ps1', 'utf8');

    expect(installer).not.toContain('restore-owned-proxy.ps1');
    expect(restoreScript).toContain('system-proxy-ownership.json');
    expect(restoreScript).toContain("Get-RequiredProperty $state 'appliedFields'");
    expect(restoreScript).toContain('$serverWasReplaced');
    expect(restoreScript).toContain('$restoreTargets = @{}');
    expect(restoreScript).toContain("$field -eq 'enabled' -and $serverWasReplaced");
    expect(restoreScript).toContain('$postRestore = Get-CurrentProxySettings');
    expect(restoreScript).toContain('Failed to verify current-user proxy after restore');
    expect(restoreScript).toContain('InternetSetOption');
    expect(restoreScript).toContain('if (-not $settingsChanged -or -not $settingsRefreshed)');
    expect(restoreScript).not.toContain('if ($restoredAnyField)');
    expect(restoreScript.match(/Remove-Item -LiteralPath \$statePath -Force/g)).toHaveLength(1);
    expect(restoreScript.indexOf('Remove-Item -LiteralPath $statePath')).toBeGreaterThan(
      restoreScript.indexOf('$postRestore = Get-CurrentProxySettings')
    );
  });
});
