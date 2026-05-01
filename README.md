# YouYu

YouYu 是一个 Windows 桌面代理工具，面向工作室内部成员。当前版本已经完成 Electron/Vite/TypeScript 项目骨架、品牌 UI、设置持久化、mihomo 配置生成、Windows x64 安装包构建链路，并内置 `mihomo-windows-amd64-v1`。

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

## 打 Windows 安装包

```bash
npm run dist:win
```

`dist:win` 会先生成品牌资源、完成生产构建，并通过 `@electron/get` 预缓存 Windows x64 Electron zip，随后再调用 electron-builder 生成 NSIS 安装包。这个流程可以避开下载缓存损坏导致的 `zip: not a valid zip file`。

构建脚本会屏蔽 electron-builder 在 Node 24 下触发的 `DEP0190` 依赖内部警告；打包失败仍会正常返回非零退出码。

产物在：

```text
release/YouYu-0.3.6-x64.exe
```

## Windows 测试重点

- 安装包能否正常安装和启动。
- 保存订阅后，点击启动是否能拉到真实节点。
- 切换节点后，访问网络是否走新节点。
- 停止后，Windows 系统代理是否恢复。
- 修复网络后，系统代理是否关闭。
