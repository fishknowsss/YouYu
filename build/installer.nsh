!macro customWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "欢迎安装 YouYu"
  !define MUI_WELCOMEPAGE_TEXT "YouYu 会安装为当前用户的桌面应用。安装完成后，你可以从桌面或开始菜单启动。$\r$\n$\r$\n安装前请先退出正在运行的 YouYu。"
  !insertmacro MUI_PAGE_WELCOME
!macroend

!macro customFinishPage
  Function StartApp
    ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" ""
  FunctionEnd
  !define MUI_FINISHPAGE_TITLE "YouYu 安装完成"
  !define MUI_FINISHPAGE_TEXT "现在可以启动 YouYu。"
  !define MUI_FINISHPAGE_RUN
  !define MUI_FINISHPAGE_RUN_TEXT "启动 YouYu"
  !define MUI_FINISHPAGE_RUN_FUNCTION "StartApp"
  !insertmacro MUI_PAGE_FINISH
!macroend

!macro customUnWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "卸载 YouYu"
  !define MUI_WELCOMEPAGE_TEXT "卸载前请先退出 YouYu。若正在代理网络，请先在应用内点击停止或修复网络。"
  !insertmacro MUI_UNPAGE_WELCOME
!macroend
