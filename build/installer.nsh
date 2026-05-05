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
!endif

!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend

!macro customInit
  InitPluginsDir
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

  ${NSD_CreateLabel} 13% 62u 74% 30u "安装 YouYu"
  Pop $0
  Push $0
  Call YouYuStyleTitle

  ${NSD_CreateLabel} 13% 108u 74% 24u "点击安装开始使用。"
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
