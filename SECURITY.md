# 安全策略

## 支持范围

安全修复只面向最新公开的 `1.5.x` 版本。旧版本用户应先升级到 [最新 Release](https://github.com/fishknowsss/YouYu/releases/latest)，再确认问题是否仍然存在。

## 私下报告漏洞

请通过仓库的 [Security Advisories](https://github.com/fishknowsss/YouYu/security/advisories/new) 提交私密漏洞报告。不要在公开 Issue、Discussion、提交记录或日志附件中包含以下内容：

- 订阅地址、访问令牌、口令或后台凭据；
- 用户、设备标识及设备密钥；
- 未脱敏的日志、数据库、配置文件或抓包内容；
- 可以直接复现生产环境访问权限的安装包或链接。

报告建议包含受影响版本、复现条件、预期与实际结果、影响判断，以及已经完成脱敏的最小复现材料。维护者会优先确认可复现性和影响范围，并在修复可用后协调披露时间。

如果敏感值已经进入公开提交、Actions artifact 或 Release，应先在对应服务中撤销或轮换；删除文件或重写 Git 历史不能恢复已经暴露的凭据。

## 仓库与发布要求

- `resources/default-subscription.txt` 必须为空。
- `resources/default-subscription.in.txt`、`.dev.vars*`、`.wrangler/`、`release/`、`release-archive/` 和 `resources/generated/` 不得提交。
- 公共三通道资产必须由 `npm run dist:win:release` 生成，并通过空内置订阅校验。
- 推送前应运行 `npm run validate:repo`；正式发布还需完成 [发布检查清单](docs/release-packaging.md)。
- 发现历史敏感内容时，按 [历史净化流程](docs/security-history-cleanup.md) 完成凭据处置、离线备份、历史改写、远端校验和缓存清理申请。
