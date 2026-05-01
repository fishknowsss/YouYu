# YouYu Windows Proxy Design

## 目标

YouYu 是给工作室成员使用的 Windows 桌面代理工具。第一版只做启动、停止、节点选择、订阅保存和修复网络，不做 TUN、规则编辑、多订阅和复杂测速。

## 技术路线

- Electron + Vite + TypeScript 开发桌面端。
- electron-builder 输出 Windows NSIS 安装包和 `.exe`。
- macOS 负责日常开发、静态 UI、单元测试和普通构建。
- Windows 负责最终打包验证、系统代理验证、安装路径和真实 mihomo 进程验证。

## 界面布局

主界面采用单窗口三页结构：

- 首页：显示运行状态、当前节点、一个大启动按钮和基础操作。
- 节点页：显示自动选择和节点列表，提供更新订阅与返回。
- 设置页：保存订阅地址，提供修复网络和日志入口。

界面不展示规则、DNS、TUN、端口、provider、策略组等实现词。

## 组件树

```text
App
  AppShell
    Home
      StatusPanel
      PowerButton
    NodeSelect
      NodeList
    Settings
```

## 主进程边界

```text
main/index.ts
  mihomo/process.ts     启动和停止 mihomo
  mihomo/config.ts      生成 config.yaml
  mihomo/api.ts         调用 external-controller
  platform/systemProxy  Windows 系统代理和 macOS mock
  storage/settings.ts   本地 settings.json
```

## 稳定性要求

- 启动失败必须回滚系统代理。
- 停止时先恢复系统代理，再停止 mihomo。
- external-controller 只监听 `127.0.0.1`。
- secret 随机生成。
- 订阅 URL 不写日志，不在普通界面完整展示。
- 设置页提供“修复网络”，用于关闭系统代理并停止残留状态。

