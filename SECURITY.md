# 安全策略

## 支持范围

安全修复面向仓库 [最新公开稳定版](https://github.com/fishknowsss/YouYu/releases/latest)，不再按固定 minor 系列声明支持范围。旧版本用户应先升级到该 Release；如果问题仍然存在，报告时请注明实际版本和复现条件。尚未公开发布的修复只有进入新的稳定 Release 后才视为对用户可用。

## 私下报告漏洞

请通过仓库的 [Security Advisories](https://github.com/fishknowsss/YouYu/security/advisories/new) 提交私密漏洞报告。不要在公开 Issue、Discussion、提交记录或日志附件中包含以下内容：

- 订阅地址、访问令牌、口令或后台凭据；
- 用户、设备标识及设备密钥；
- 未脱敏的日志、数据库、配置文件或抓包内容；
- 可以直接复现生产环境访问权限的安装包或链接。

报告建议包含受影响版本、复现条件、预期与实际结果、影响判断，以及已经完成脱敏的最小复现材料。维护者会优先确认可复现性和影响范围，并在修复可用后协调披露时间。

如果敏感值已经进入公开提交、Actions artifact 或 Release，应先在对应服务中撤销或轮换；删除文件或重写 Git 历史不能恢复已经暴露的凭据。

## 仓库与发布要求

### 当前依赖维护记录（2026-10-21）

1.8.3 维护改动覆盖受影响的 Electron 43 系列、`js-yaml`、Vite、Vitest，以及构建与 Worker 工具链的依赖修复；用户可用版本仍以最新稳定 Release 为准。

以下更新已在 1.8.3 维护源码中整合。部分 PR 的目标版本仍受后续公告影响，因此直接采用同系列修复版本；对应 Dependabot PR 由本次维护统一覆盖，无需分别合并。

| Dependabot PR | 采用版本 |
| --- | --- |
| #5 `fast-uri` | `3.1.9`，替代仍有后续告警的 `3.1.7` |
| #6 `@xmldom/xmldom` | `0.8.15` |
| #7 `browserslist`、#9 `baseline-browser-mapping` | `4.29.4`、`2.11.30` |
| #8 `vitest` | `4.1.11`，`@vitest/coverage-v8` 同步版本 |
| #10 `sharp` / `wrangler` | `0.35.5` / `4.151.3`，覆盖后续 sharp 与 Undici 公告；Workers 类型同步到所需版本 |
| #11 `js-yaml` | `4.3.2`，包含桌面运行依赖中的副本 |
| #12 `electron` | `43.8.3`，保留 43 系列并同步官方 ZIP 校验清单 |
| #13 `undici` | node-gyp 链为 `6.29.1`；其他开发工具链为 `7.29.1` |
| #14 `brace-expansion` | 按原依赖范围分别更新为 `1.1.21`、`2.1.7`、`5.0.12` |
| #15 `source-map-js` | `1.2.2` |

审计另发现 Vite 开发服务器的编辑器启动漏洞及 `http-cache-semantics` 缓存问题，分别更新到 `7.3.7` 和 `4.3.0`。本次 `npm audit` 高危为 0；`npm audit --omit=dev` 为 0。Electron 实际随桌面安装包交付，已单独处理其安全公告，不按 npm 的开发依赖标签排除。

`sprintf-js <=1.1.3` 的 [GHSA-hp3w-g68c-fv3c](https://github.com/advisories/GHSA-hp3w-g68c-fv3c) 尚无修复版。它来自 `electron-builder → app-builder-lib → @electron/get → global-agent → roarr` 的开发依赖链，不随桌面运行时交付。已检查 `global-agent` 的日志调用：格式字符串由库内固定文本提供，远端数据放在日志上下文对象中；触发公告中的资源耗尽需要攻击者控制格式字符串的精度参数。暂保留打包器版本，等待上游修复，不用自动审计建议的降级消除提示。

### 日常要求

- `resources/default-subscription.txt` 必须为空。
- `resources/default-subscription.in.txt`、`.dev.vars*`、`.wrangler/`、`release/`、`release-archive/`、`team-builds/`、遗留的 `local-subscription-builds/` 和 `resources/generated/` 不得提交。
- 公共三通道资产必须由 `npm run dist:win:release` 生成，并通过空内置订阅校验。
- 推送前应运行 `npm run validate:repo`；正式发布还需完成 [发布检查清单](docs/release-packaging.md)。
- 发现历史敏感内容时，按 [历史净化流程](docs/security-history-cleanup.md) 完成凭据处置、离线备份、历史改写、远端校验和缓存清理申请。

## Worker 生产部署边界

- 常规 Worker 生产变更只通过 `.github/workflows/deploy-worker.yml` 的手动固定 SHA 流程准备：必须从 `main` 触发，输入 SHA 必须等于定义该次 workflow run 的精确 `main` commit，并由仅允许 `main` 的受保护 `production-worker` Environment 审批；仓库推送、Pull Request 和本地质量门槛不会自动部署。
- Cloudflare 凭据只作为受保护 Environment 中的最小权限 secret 注入远端 schema、migration 和 deploy 步骤。`REGISTRATION_PASSPHRASE`、`ADMIN_TOKEN` 等 Worker 运行时 secret 不复制到 GitHub workflow，也不通过该流程写入。
- D1 migration apply 由多个远端命令组成，不应假定具备跨文件原子性。批准生产 apply 前必须核对 dry-run、固定目标和恢复方案；失败时停止后续部署，不用自动重试掩盖部分完成状态。
- Actions 日志、artifact 和审计摘要不得包含 token、环境变量转储、D1 数据行或未脱敏的 Wrangler 响应。

## 登记口令边界

`REGISTRATION_PASSPHRASE` 是受信团队选择和切换已有姓名档案的共享授权，不是每个姓名独立的账号密码。持有该口令的人可以为已有姓名登记设备，并读取该用户适用的远程配置、累计用量和当日用量。只应在受信团队内分发；疑似泄露时应立即轮换 Cloudflare Secret，并避免在日志、截图、安装包说明或聊天记录中发送。
