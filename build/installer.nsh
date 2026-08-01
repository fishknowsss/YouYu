!include LogicLib.nsh
!include nsDialogs.nsh
!include WinMessages.nsh

!define YOUYU_BG "FFFFFF"
!define YOUYU_PANEL "FFFFFF"
!define YOUYU_INK "21172F"
!define YOUYU_MUTED "685A78"
!define YOUYU_SOFT "F7F1FF"
!define YOUYU_ACCENT "8F58D7"
!define MUI_INSTFILESPAGE_COLORS "21172F FFFFFF"
!define MUI_INSTFILESPAGE_PROGRESSBAR "smooth"
!define /ifndef PBM_SETBARCOLOR 0x0409
!define /ifndef PBM_SETBKCOLOR 0x2001
!define /ifndef SWP_NOZORDER 0x0004
!define /ifndef SWP_NOACTIVATE 0x0010
!define /ifndef WM_SETICON 0x0080
!define /ifndef ICON_SMALL 0
!define /ifndef ICON_BIG 1
!define /ifndef GCLP_HICON -14
!define /ifndef GCLP_HICONSM -34

BrandingText " "

Var YouYuDialog
Var YouYuHandoffValidated
!ifndef BUILD_UNINSTALLER
  Var YouYuRunCheckbox
  Var YouYuClosedRunningApp
  Var YouYuIsUpdateInstall
  Var YouYuIsUpdaterLaunch
  Var YouYuLegacyUpdateBridge
!endif

!macro customInit
  InitPluginsDir
  StrCpy $YouYuHandoffValidated "0"
  !ifndef BUILD_UNINSTALLER
    StrCpy $YouYuIsUpdateInstall "0"
    StrCpy $YouYuIsUpdaterLaunch "0"
    StrCpy $YouYuLegacyUpdateBridge "0"
    IfFileExists "$INSTDIR\YouYu.exe" 0 +2
      StrCpy $YouYuIsUpdateInstall "1"
    ${If} ${isUpdated}
      StrCpy $YouYuIsUpdaterLaunch "1"
      StrCpy $YouYuIsUpdateInstall "1"
    ${EndIf}
    Call YouYuValidateInstallBoundary
  !endif
  Call YouYuHideTitleIcon
!macroend

!macro customCheckAppRunning
  !ifdef BUILD_UNINSTALLER
    Call un.YouYuValidateInstallBoundary
  !else
    Call YouYuValidateInstallBoundary
  !endif
!macroend

!ifndef BUILD_UNINSTALLER
  !macro customInstall
    ${If} $YouYuLegacyUpdateBridge != "1"
      Call YouYuConsumeInstallHandoff
    ${EndIf}
  !macroend

  # electron-builder adds its StdUtils plug-in directory after loading this
  # include. Delay this callback definition until the template's header hook.
  !macro customHeader
    Function YouYuFinishPageLeave
      ${NSD_GetState} $YouYuRunCheckbox $0
      ${If} $0 == ${BST_CHECKED}
        ${StdUtils.ExecShellAsUser} $0 "$INSTDIR\YouYu.exe" "open" ""
      ${EndIf}
    FunctionEnd
  !macroend
!endif

!macro customWelcomePage
  Page custom YouYuWelcomePageCreate
!macroend

!macro customPageAfterChangeDir
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW YouYuInstallFilesShow
!macroend

!macro customFinishPage
  Page custom YouYuFinishPageCreate YouYuFinishPageLeave
!macroend

!ifdef BUILD_UNINSTALLER
  !macro customUnWelcomePage
    Page custom YouYuUninstallPageCreate
  !macroend

  !macro customUnInstall
    ${IfNot} ${isUpdated}
      File /oname=$PLUGINSDIR\YouYuCleanupStartupTasks.ps1 "${BUILD_RESOURCES_DIR}\cleanup-startup-tasks.ps1"
      nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -File "$PLUGINSDIR\YouYuCleanupStartupTasks.ps1" -Action Cleanup -ExecutablePath "$INSTDIR\YouYu.exe"`
      Pop $0
      ${If} $0 != 0
        DetailPrint "未能清理全部 YouYu 开机启动任务。"
      ${EndIf}
    ${EndIf}
  !macroend
!endif

Function YouYuStyleTitle
  Exch $0
  CreateFont $1 "Microsoft YaHei UI" 22 700
  SendMessage $0 ${WM_SETFONT} $1 1
  SetCtlColors $0 ${YOUYU_INK} ${YOUYU_PANEL}
FunctionEnd

Function YouYuStyleText
  Exch $0
  CreateFont $1 "Microsoft YaHei UI" 10 400
  SendMessage $0 ${WM_SETFONT} $1 1
  SetCtlColors $0 ${YOUYU_MUTED} ${YOUYU_PANEL}
FunctionEnd

Function YouYuHideTitleIcon
  SendMessage $HWNDPARENT ${WM_SETICON} ${ICON_SMALL} 0
  SendMessage $HWNDPARENT ${WM_SETICON} ${ICON_BIG} 0
  System::Call 'user32::SetClassLongPtr(p$HWNDPARENT, i${GCLP_HICON}, p0)'
  System::Call 'user32::SetClassLongPtr(p$HWNDPARENT, i${GCLP_HICONSM}, p0)'
FunctionEnd

!ifdef BUILD_UNINSTALLER
Function un.YouYuValidateInstallBoundary
!else
Function YouYuValidateInstallBoundary
!endif
  !ifndef BUILD_UNINSTALLER
    StrCpy $YouYuClosedRunningApp "0"
  !endif
  File /oname=$PLUGINSDIR\YouYuManageProcess.ps1 "${BUILD_RESOURCES_DIR}\manage-installed-process.ps1"

  RetryValidateYouYu:
    !ifndef BUILD_UNINSTALLER
      ${If} $YouYuIsUpdaterLaunch == "1"
        IfSilent YouYuRequireHandoff YouYuOptionalHandoff
      ${EndIf}
    YouYuOptionalHandoff:
    !endif

    nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -File "$PLUGINSDIR\YouYuManageProcess.ps1" -Action WaitForExit -ExecutablePath "$INSTDIR\YouYu.exe"`
    !ifndef BUILD_UNINSTALLER
      Goto YouYuCheckBoundaryResult

    YouYuRequireHandoff:
      nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -File "$PLUGINSDIR\YouYuManageProcess.ps1" -Action WaitForExit -ExecutablePath "$INSTDIR\YouYu.exe" -RequireHandoff -AllowLegacyUpdateBridge -InstallerVersion "${VERSION}"`

    YouYuCheckBoundaryResult:
    !endif
    Pop $0
    ${If} $0 == 0
      StrCpy $YouYuHandoffValidated "1"
      Return
    ${EndIf}
    !ifndef BUILD_UNINSTALLER
      ${If} $0 == 10
        StrCpy $YouYuHandoffValidated "1"
        StrCpy $YouYuLegacyUpdateBridge "1"
        Return
      ${EndIf}
    !endif

    IfSilent YouYuBoundaryFailedSilent
    MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "YouYu 仍在运行，或安装身份校验未通过。请在启动它的原用户会话中退出 YouYu 后重试。" /SD IDRETRY IDRETRY RetryValidateYouYu
    Quit
  YouYuBoundaryFailedSilent:
    SetErrorLevel 2
    Quit
FunctionEnd

!ifndef BUILD_UNINSTALLER
Function YouYuConsumeInstallHandoff
  ${If} $YouYuHandoffValidated != "1"
    Goto YouYuConsumeHandoffFailed
  ${EndIf}
  ${If} $YouYuIsUpdaterLaunch == "1"
    IfSilent YouYuConsumeRequiredHandoff YouYuConsumeOptionalHandoff
  ${EndIf}

  YouYuConsumeOptionalHandoff:
    nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -File "$PLUGINSDIR\YouYuManageProcess.ps1" -Action Consume -ExecutablePath "$INSTDIR\YouYu.exe"`
    Goto YouYuCheckConsumeHandoffResult

  YouYuConsumeRequiredHandoff:
    nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -File "$PLUGINSDIR\YouYuManageProcess.ps1" -Action Consume -ExecutablePath "$INSTDIR\YouYu.exe" -RequireHandoff`

  YouYuCheckConsumeHandoffResult:
    Pop $0
    ${If} $0 == 0
      Return
    ${EndIf}

  YouYuConsumeHandoffFailed:
    DetailPrint "The authenticated update handoff could not be consumed after installation."
    SetErrorLevel 2
    Quit
FunctionEnd

!endif

Function YouYuHideDefaultChrome
  Call YouYuHideTitleIcon
  GetDlgItem $0 $HWNDPARENT 1037
  ShowWindow $0 ${SW_HIDE}
  GetDlgItem $0 $HWNDPARENT 1038
  ShowWindow $0 ${SW_HIDE}
  GetDlgItem $0 $HWNDPARENT 1039
  ShowWindow $0 ${SW_HIDE}
  GetDlgItem $0 $HWNDPARENT 1034
  ShowWindow $0 ${SW_HIDE}
  GetDlgItem $0 $HWNDPARENT 1035
  ShowWindow $0 ${SW_HIDE}
  GetDlgItem $0 $HWNDPARENT 1045
  ShowWindow $0 ${SW_HIDE}
FunctionEnd

Function YouYuPrepareInstallButtons
  Call YouYuHideDefaultChrome
  GetDlgItem $0 $HWNDPARENT 3
  ShowWindow $0 ${SW_HIDE}
  GetDlgItem $0 $HWNDPARENT 1
  SendMessage $0 ${WM_SETTEXT} 0 "STR:安装"
  GetDlgItem $0 $HWNDPARENT 2
  SendMessage $0 ${WM_SETTEXT} 0 "STR:取消"
FunctionEnd

!ifndef BUILD_UNINSTALLER
Function YouYuPrepareFinishButtons
  Call YouYuHideDefaultChrome
  GetDlgItem $0 $HWNDPARENT 3
  ShowWindow $0 ${SW_HIDE}
  GetDlgItem $0 $HWNDPARENT 2
  ShowWindow $0 ${SW_HIDE}
  GetDlgItem $0 $HWNDPARENT 1
  ShowWindow $0 ${SW_SHOW}
  SendMessage $0 ${WM_SETTEXT} 0 "STR:完成"
FunctionEnd

Function YouYuCreateFrame
  nsDialogs::Create 1018
  Pop $YouYuDialog
  ${If} $YouYuDialog == error
    Abort
  ${EndIf}

  SetCtlColors $YouYuDialog ${YOUYU_INK} ${YOUYU_BG}

  ${NSD_CreateLabel} 0 0 100% 100% ""
  Pop $0
  SetCtlColors $0 ${YOUYU_INK} ${YOUYU_PANEL}
FunctionEnd

Function YouYuWelcomePageCreate
  Call YouYuPrepareInstallButtons
  Call YouYuCreateFrame

  ${If} $YouYuIsUpdateInstall == "1"
    ${NSD_CreateLabel} 13% 62u 74% 30u "更新 YouYu"
  ${Else}
    ${NSD_CreateLabel} 13% 62u 74% 30u "安装 YouYu"
  ${EndIf}
  Pop $0
  Push $0
  Call YouYuStyleTitle

  ${If} $YouYuIsUpdateInstall == "1"
    ${If} $YouYuClosedRunningApp == "1"
      ${NSD_CreateLabel} 13% 108u 74% 30u "旧版本已退出，点击安装完成更新。"
    ${Else}
      ${NSD_CreateLabel} 13% 108u 74% 30u "点击安装完成更新。"
    ${EndIf}
  ${Else}
    ${NSD_CreateLabel} 13% 108u 74% 24u "点击安装开始使用。"
  ${EndIf}
  Pop $0
  Push $0
  Call YouYuStyleText

  nsDialogs::Show
FunctionEnd

Function YouYuInstallFilesShow
  Call YouYuHideTitleIcon
  FindWindow $0 "#32770" "" $HWNDPARENT
  SetCtlColors $0 ${YOUYU_INK} ${YOUYU_PANEL}

  GetDlgItem $1 $HWNDPARENT 1037
  ShowWindow $1 ${SW_HIDE}
  GetDlgItem $1 $HWNDPARENT 1038
  ShowWindow $1 ${SW_HIDE}
  GetDlgItem $1 $HWNDPARENT 1039
  ShowWindow $1 ${SW_HIDE}
  GetDlgItem $1 $HWNDPARENT 1034
  SetCtlColors $1 ${YOUYU_INK} ${YOUYU_PANEL}
  GetDlgItem $1 $HWNDPARENT 1035
  ShowWindow $1 ${SW_HIDE}
  GetDlgItem $1 $HWNDPARENT 1045
  ShowWindow $1 ${SW_HIDE}

  GetDlgItem $1 $0 1006
  SendMessage $1 ${WM_SETTEXT} 0 "STR:正在安装"
  CreateFont $2 "Microsoft YaHei UI" 15 700
  SendMessage $1 ${WM_SETFONT} $2 1
  SetCtlColors $1 ${YOUYU_INK} ${YOUYU_PANEL}
  System::Call 'user32::SetWindowPos(p$1, p0, i66, i56, i360, i28, i${SWP_NOZORDER}|${SWP_NOACTIVATE})'

  GetDlgItem $1 $0 1004
  System::Call 'uxtheme::SetWindowTheme(p$1, w "", w "")'
  SendMessage $1 ${PBM_SETBKCOLOR} 0 0x00F8F1FF
  SendMessage $1 ${PBM_SETBARCOLOR} 0 0x00D7588F
  System::Call 'user32::SetWindowPos(p$1, p0, i66, i106, i360, i8, i${SWP_NOZORDER}|${SWP_NOACTIVATE})'

  GetDlgItem $1 $0 1027
  ShowWindow $1 ${SW_HIDE}
  GetDlgItem $1 $0 1016
  ShowWindow $1 ${SW_HIDE}
FunctionEnd

Function YouYuFinishPageCreate
  Call YouYuPrepareFinishButtons
  Call YouYuCreateFrame

  ${NSD_CreateLabel} 13% 62u 74% 30u "安装完成"
  Pop $0
  Push $0
  Call YouYuStyleTitle

  ${NSD_CreateLabel} 13% 108u 74% 24u "现在可以启动 YouYu。"
  Pop $0
  Push $0
  Call YouYuStyleText

  ${NSD_CreateCheckbox} 13% 146u 44% 16u "启动 YouYu"
  Pop $YouYuRunCheckbox
  ${NSD_SetState} $YouYuRunCheckbox ${BST_CHECKED}
  SetCtlColors $YouYuRunCheckbox ${YOUYU_INK} ${YOUYU_PANEL}

  nsDialogs::Show
FunctionEnd

!endif

!ifdef BUILD_UNINSTALLER
  Function YouYuUninstallPageCreate
    Call YouYuPrepareInstallButtons
    nsDialogs::Create 1018
    Pop $YouYuDialog
    ${If} $YouYuDialog == error
      Abort
    ${EndIf}

    SetCtlColors $YouYuDialog ${YOUYU_INK} ${YOUYU_PANEL}

    ${NSD_CreateLabel} 13% 62u 74% 30u "卸载 YouYu"
    Pop $0
    Push $0
    Call YouYuStyleTitle

    ${NSD_CreateLabel} 13% 108u 70% 28u "点击卸载即可移除应用。"
    Pop $0
    Push $0
    Call YouYuStyleText

    nsDialogs::Show
  FunctionEnd
!endif
