# YouYu

YouYu 是一个 Windows 桌面代理工具，面向工作室内部成员。当前版本已经完成 Electron/Vite/TypeScript 项目骨架、品牌 UI、设置持久化、mihomo 配置生成、Windows x64 安装包构建链路，并内置 `mihomo-windows-amd64-v1`。

打包、版本号、公开版和本地内置版规则见 [docs/release-packaging.md](docs/release-packaging.md)。修改 Windows 打包、订阅默认值、release 上传路径或版本号前，先看这份文档。

## 当前能力

- 订阅拉取：托管 proxy-provider，也支持尝试读取机场完整 Clash/Mihomo 配置。
- 策略组：手动节点、自动选择、故障转移、负载均衡、直连。
- 模式切换：规则、全局、直连。
- 运行能力：DNS 增强、流量嗅探、TUN 配置、局域网开关、系统代理开关。
- 节点操作：节点列表、单节点测速、全部测速、延迟显示。
- 连接管理：读取连接数量和累计流量，支持一键关闭当前连接。
- 托盘驻留：Windows 上关闭主窗口会隐藏到右下角托盘，托盘菜单支持显示、停止代理、修复网络、退出。

## 本地开发

```bash
npm ci
npm run dev
```

如果项目目录来自 macOS，请在 Windows 上重新执行 `npm ci`，不要复用 macOS 生成的 `node_modules`。Windows 需要 `.cmd` 可执行入口，否则 `tsc`、`vitest`、`tsx`、`electron-builder` 等命令会找不到。

只看前端界面时，用浏览器预览：

```bash
npm run dev:ui
```

打开：

```text
http://127.0.0.1:5173
```

这个模式使用本地 mock 数据，适合改 UI 和提意见，不会启动 mihomo，也不会修改 macOS 网络代理。

## 验证

```bash
npm test
npm run typecheck
npm run build
npm run smoke
```

## 版本与交付规则

每次改动较多、修复关键启动/代理问题、或完成一轮可交付功能后，默认需要提升 `package.json` 版本号并重新打包 Windows exe。

- 普通迭代递增补丁号，例如 `0.3.3` -> `0.3.4`。
- 较大改动递增次版本号，例如 `0.4.3` -> `0.5.0`，或按当前版本线推进到新的 `0.x.0`。
- 只有用户主动要求大版本变化时，才递增第一个版本号，例如 `1.3.3`。
- 打包前确认版本号已更新；打包命令使用 `npm run dist:win`。
- 交付时说明新版本号、exe 产物路径，以及已执行的验证命令。

## 打 Windows 安装包

公开版用于 GitHub release，不内置订阅：

```bash
npm run dist:win
```

本地内置版只给本机或内部临时使用，文件名带 `-in`，不上传 GitHub：

```bash
npm run dist:win:in
```

两条命令都会先清空 `release/`。如果需要同时保留公开版和 `-in` 版，先把其中一个复制到 `release-archive/`，再运行另一个打包命令，最后复制回来。完整规则见 [docs/release-packaging.md](docs/release-packaging.md)。

`dist:win` 会先生成品牌资源、完成生产构建，并通过 `@electron/get` 预缓存 Windows x64 Electron zip，随后再调用 electron-builder 生成 NSIS 安装包。这个流程可以避开下载缓存损坏导致的 `zip: not a valid zip file`。

构建脚本会屏蔽 electron-builder 在 Node 24 下触发的 `DEP0190` 依赖内部警告；打包失败仍会正常返回非零退出码。

产物在：

```text
release/YouYu-0.3.6-x64.exe
release/YouYu-0.3.6-x64-in.exe
```

## Windows 测试重点

- 安装包能否正常安装和启动。
- 保存订阅后，点击启动是否能拉到真实节点。
- 切换节点后，访问网络是否走新节点。
- 停止后，Windows 系统代理是否恢复。
- 修复网络后，系统代理是否关闭。
