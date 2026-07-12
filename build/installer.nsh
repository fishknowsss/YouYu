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
!ifndef BUILD_UNINSTALLER
  Var YouYuRunCheckbox
  Var YouYuClosedRunningApp
  Var YouYuIsUpdateInstall
!endif

!macro customInit
  InitPluginsDir
  !ifndef BUILD_UNINSTALLER
    Call YouYuCloseRunningAppBeforeInstall
    Call YouYuDetectUpdateInstall
  !endif
  Call YouYuHideTitleIcon
!macroend

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

!ifndef BUILD_UNINSTALLER
Function YouYuCloseRunningAppBeforeInstall
  StrCpy $YouYuClosedRunningApp "0"

  RetryCloseYouYu:
    nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -Command "if (Get-Process -Name YouYu -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }"`
    Pop $0
    ${If} $0 != 0
      Return
    ${EndIf}

    StrCpy $YouYuClosedRunningApp "1"
    DetailPrint "Closing running YouYu before update."
    IfFileExists "$INSTDIR\YouYu.exe" 0 +4
      nsExec::Exec `"$INSTDIR\YouYu.exe" --shutdown-for-install`
      Pop $0
      Sleep 4500

    nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -Command "if (Get-Process -Name YouYu -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }"`
    Pop $0
    ${If} $0 != 0
      Goto YouYuCloseFinished
    ${EndIf}

    nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -Command "(Get-Process -Name YouYu -ErrorAction SilentlyContinue) | ForEach-Object { if ($$_.MainWindowHandle -ne 0) { [void]$$_.CloseMainWindow() } }"`
    Pop $0
    Sleep 1000

    nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -Command "if (Get-Process -Name YouYu -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }"`
    Pop $0
    ${If} $0 == 0
      Call YouYuRestoreOwnedProxyBeforeForceClose
      nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -Command "Get-Process -Name YouYu -ErrorAction SilentlyContinue | Stop-Process -Force"`
      Pop $0
      Sleep 1200
    ${EndIf}

    nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -Command "if (Get-Process -Name YouYu -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }"`
    Pop $0
    ${If} $0 == 0
      IfSilent YouYuCloseFailedSilent
      MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "YouYu 正在运行，安装程序无法关闭它。请手动退出后重试。" /SD IDRETRY IDRETRY RetryCloseYouYu
      Quit
    ${EndIf}
  YouYuCloseFailedSilent:
    Quit
  YouYuCloseFinished:
FunctionEnd

Function YouYuRestoreOwnedProxyBeforeForceClose
  DetailPrint "Restoring YouYu-managed system proxy before force close."
  nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -Command "$$ErrorActionPreference='Stop'; $$path=Join-Path $$env:APPDATA 'YouYu\system-proxy-ownership.json'; if(-not(Test-Path -LiteralPath $$path)){exit 0}; try{$$state=Get-Content -Raw -LiteralPath $$path | ConvertFrom-Json}catch{exit 0}; if($$state.version -notin @(1,2) -or $$null -eq $$state.previous -or $$null -eq $$state.applied){exit 0}; $$fields=if($$state.version -eq 1){@{enabled=$$true;server=$$true;override=$$true}}else{$$state.appliedFields}; foreach($$field in @('enabled','server','override')){if($$null -eq $$fields.$$field -or $$null -eq $$state.previous.$$field -or $$null -eq $$state.applied.$$field){exit 0}; if($$field -eq 'enabled'){if($$fields.$$field -isnot [bool] -or $$state.previous.$$field -isnot [bool] -or $$state.applied.$$field -isnot [bool]){exit 0}}else{if($$fields.$$field -isnot [bool] -or $$state.previous.$$field -isnot [string] -or $$state.applied.$$field -isnot [string]){exit 0}}}; $$settings=Get-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings'; $$current=@{enabled=([int]$$settings.ProxyEnable -eq 1);server=if($$null -eq $$settings.ProxyServer){''}else{[string]$$settings.ProxyServer};override=if($$null -eq $$settings.ProxyOverride){''}else{[string]$$settings.ProxyOverride}}; $$restore=$$false; foreach($$field in @('enabled','server','override')){if(-not $$fields.$$field){continue}; if($$current.$$field -ne $$state.applied.$$field -and $$current.$$field -ne $$state.previous.$$field){exit 0}; if($$current.$$field -eq $$state.applied.$$field){$$restore=$$true}}; if(-not $$restore){exit 0}; if($$fields.server){if([string]::IsNullOrEmpty([string]$$state.previous.server)){Remove-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' -Name ProxyServer -ErrorAction SilentlyContinue}else{Set-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' -Name ProxyServer -Value ([string]$$state.previous.server)}}; if($$fields.override){if([string]::IsNullOrEmpty([string]$$state.previous.override)){Remove-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' -Name ProxyOverride -ErrorAction SilentlyContinue}else{Set-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' -Name ProxyOverride -Value ([string]$$state.previous.override)}}; if($$fields.enabled){Set-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' -Name ProxyEnable -Type DWord -Value ([int][bool]$$state.previous.enabled)}; Remove-Item -LiteralPath $$path -Force -ErrorAction Stop; $$src=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('dXNpbmcgU3lzdGVtOyB1c2luZyBTeXN0ZW0uUnVudGltZS5JbnRlcm9wU2VydmljZXM7IG5hbWVzcGFjZSBZb3VZdSB7IHB1YmxpYyBzdGF0aWMgY2xhc3MgV2luSW5ldCB7IFtEbGxJbXBvcnQoIndpbmluZXQuZGxsIiwgU2V0TGFzdEVycm9yPXRydWUpXSBwdWJsaWMgc3RhdGljIGV4dGVybiBib29sIEludGVybmV0U2V0T3B0aW9uKEludFB0ciBoSW50ZXJuZXQsIGludCBkd09wdGlvbiwgSW50UHRyIGxwQnVmZmVyLCBpbnQgZHdCdWZmZXJMZW5ndGgpOyB9IH0=')); Add-Type -TypeDefinition $$src -ErrorAction Stop; [void][YouYu.WinInet]::InternetSetOption([IntPtr]::Zero,39,[IntPtr]::Zero,0); [void][YouYu.WinInet]::InternetSetOption([IntPtr]::Zero,37,[IntPtr]::Zero,0)"`
  Pop $0
FunctionEnd

Function YouYuDetectUpdateInstall
  StrCpy $YouYuIsUpdateInstall "0"
  IfFileExists "$INSTDIR\YouYu.exe" 0 +2
    StrCpy $YouYuIsUpdateInstall "1"
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

Function YouYuFinishPageLeave
  ${NSD_GetState} $YouYuRunCheckbox $0
  ${If} $0 == ${BST_CHECKED}
    ExecShell "open" "$INSTDIR\YouYu.exe"
  ${EndIf}
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
