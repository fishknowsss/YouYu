# YouYu

YouYu 是面向 Windows 的轻量代理控制台，基于 Electron、Vite、React 和 TypeScript。应用内置 Mihomo 运行时，提供订阅配置、模式切换、节点测试、系统代理控制和桌宠辅助交互。

## 功能

- 一键启动或停止代理。
- 支持规则、全局、直连三种模式。
- 支持订阅保存、节点列表、单节点测速和全量测速。
- 支持 TUN、DNS 增强、嗅探、局域网访问和系统代理开关。
- 支持托盘驻留，关闭主窗口后可从托盘恢复。
- 标准版带桌宠；无桌宠版禁用桌宠窗口、托盘桌宠入口和桌宠资源。
- 控制台左下角显示当前版本号，标准版无后缀，内部版显示 `-in`，无桌宠版显示 `-no`。

## 安装包类型

本地交付默认保留三种 Windows x64 安装包：

| 类型 | 文件名 | 用途 |
| --- | --- | --- |
| 标准版 | `YouYu-<version>-x64.exe` | 公开发布，带桌宠，不内置订阅 |
| 内部版 | `YouYu-<version>-x64-in.exe` | 本地或内部临时使用，带桌宠，可内置本地订阅 |
| 无桌宠版 | `YouYu-<version>-x64-no.exe` | 不包含桌宠功能和桌宠资源 |

公开发布只能使用标准版。内部版和无桌宠版仅用于本地交付或内部测试。

## 开发

```bash
npm ci
npm run dev
```

只预览前端界面：

```bash
npm run dev:ui
```

浏览器打开：

```text
http://127.0.0.1:5173
```

## 验证

```bash
npm run typecheck
npm test
npm run build
npm run smoke
```

无桌宠构建可单独检查：

```bash
npm run build:no-pet
```

该构建不应在 `out/renderer/assets` 中产生 `spritesheet` 资源。

## 打包

标准版：

```bash
npm run dist:win
```

内部版：

```bash
npm run dist:win:in
```

无桌宠版：

```bash
npm run dist:win:no
```

这三个命令都会先清空 `release/`。如果一次交付需要同时保留三种安装包，需要先把前一次构建出的 `.exe` 和 `.blockmap` 复制到 `release-archive/`，最后再恢复回 `release/`。

完整打包规则见 [docs/release-packaging.md](docs/release-packaging.md)。

## 订阅文件

- `resources/default-subscription.txt`：公开版使用，必须保持为空。
- `resources/default-subscription.in.txt`：本地内部版使用，已被 `.gitignore` 忽略，不能提交。
- `resources/generated/default-subscription.txt`：打包时生成，不提交。

## Windows 测试重点

- 安装包能正常安装和启动。
- 标准版左下角显示 `v<version>`，内部版显示 `v<version>-in`，无桌宠版显示 `v<version>-no`。
- 标准版和内部版的桌宠能显示、拖拽、贴边；无桌宠版不出现桌宠。
- 保存订阅后能拉取节点并启动代理。
- 停止代理后 Windows 系统代理能恢复。
- 托盘菜单能打开主界面、启动/停止代理、修复网络和退出。
