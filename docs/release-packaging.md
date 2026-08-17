# YouYu Release Packaging

本地私有双包统一运行 `npm run dist:win:team`；`npm run dist:win:local` 是兼容别名。该流程只构建并逐一校验内置私有订阅的 `-in`、`-no` 安装包，成功后原子刷新扁平 `team-builds/` 并清理 `release/` 中的私有临时输出。公共三通道统一运行 `npm run dist:win:release`，最终公开资产全部为空订阅。两个流程不得互相借用同名 `-in`、`-no` 安装包。

这份文档记录 YouYu 的打包、版本号、订阅内置和本地归档规则。以后处理打包、发布、版本号、订阅默认值时，先读这里。

## 交付原则

Windows x64 安装包按交付对象分成两个互不混用的流程：

| 流程 | 命令 | 最终交付目录 | 产物 | 是否内置订阅 |
| --- | --- | --- | --- | --- |
| 团队私有双包 | `npm run dist:win:team` | `team-builds/` | `-in.exe`、`-no.exe` | 是 |
| GitHub 公共三通道 | `npm run dist:win:release` | `release/` | 标准、`-in`、`-no` 及更新资产 | 否 |

`npm run dist:win`、`npm run dist:win:in`、`npm run dist:win:no` 仍保留给单通道排查，不是日常团队交付入口。公开 GitHub release、GitHub Actions artifact 和公开下载渠道只能上传不含内置订阅的产物。标准版使用 `latest.yml` 更新；内部通道和无桌宠通道只能上传 `--public-update` 生成的更新包，分别使用 `latest-in.yml` 和 `latest-no.yml`。

纯文档、项目规则或归档目录维护不需要递增版本号，也不需要重新打安装包。

## 订阅文件

- `resources/default-subscription.txt`
  - 被 Git 跟踪。
  - 必须保持为空。
  - 只有标准版读取它，校验脚本要求标准版包内订阅为空。
- `resources/default-subscription.in.txt`
  - 本机私有文件。
  - 必须被 `.gitignore` 命中。
  - 保存内部版和无桌宠版使用的真实内置订阅。
  - 不能提交，不能上传 GitHub，不能放进公开 release。
- `resources/generated/default-subscription.txt`
  - 打包脚本临时生成。
  - 必须被 `.gitignore` 命中。
  - `dist:win` 从空的 `resources/default-subscription.txt` 生成。
  - `dist:win:in` 和 `dist:win:no` 从 `resources/default-subscription.in.txt` 生成，仅用于本地自用或内部分发。
  - `dist:win:release` 生成公开更新用三通道产物，三种通道都从空的 `resources/default-subscription.txt` 生成，禁止携带真实订阅。

如果真实订阅曾经进入 GitHub commit、Actions artifact 或 release asset，要当作已经泄露处理，必须更换订阅 token。删除文件或重写历史只能止血，不能让旧 token 重新安全。

## Electron 运行时缓存

`scripts/electron-win-x64.json` 固定 Windows x64 Electron 官方 ZIP 的精确版本、官方资产 URL、字节数和 SHA256。`npm run cache:electron:win` 必须先完整验证本机 electron-builder 缓存；验证一致时允许离线复用，缺失或不一致时才从官方 GitHub Release 有界重试下载，并在复制前后再次验证。打包脚本会把再次验证通过的 ZIP 作为 `electronDist` 直接交给 electron-builder，避免缓存命中后仍联网读取校验清单；`afterPack` 会精确移除官方 ZIP 自带的 `resources/default_app.asar` 与根 `version` 标记，使产物与默认下载路径保持一致。不得使用第三方镜像、仅凭文件名复用缓存或跳过哈希校验。

升级 Electron 时，必须同时更新 `package.json`、lockfile 与该 manifest；官方 ZIP 的 SHA256 必须和同一 Release 的 `SHASUMS256.txt` 一致，并运行 Electron distribution 回归测试和 Windows 安装包验证。

## GitHub CDN 路由门禁

本机访问 GitHub Release CDN 时可能出现“连接仍在传输，但速度低到数小时无法完成”的路径问题。这类情况不会稳定触发普通超时，不能通过反复重跑、清空代理变量或临时强制直连处理。

在 Electron/Mihomo 缓存下载、GitHub Release 上传和远端资产校验之前运行：

```powershell
npm run release:network:preflight
```

该命令通过当前进程实际继承的网络环境，从最新公开安装包读取一个有界的 2 MB 分段，检查 HTTP 状态、完整字节数和最低可用速度。它不会打印代理凭据，也不会擅自改走直连。预检失败时先检查当前 `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY`、WinINET 和 YouYu 实际监听端口；不要写死 `7890`，不要在同一发布过程中清空已经验证可用的代理环境。

远端发布完成后统一运行：

```powershell
npm run release:verify:remote
```

校验器会先重复 CDN 预检，再通过公开 GitHub API 核对精确的 11 个资产，使用 `curl.exe --ssl-no-revoke`、重试、低速中止和断点续传下载到独立临时目录，并验证三个更新描述文件、远端大小、完整十项 SHA256 清单以及本地/远端 `SHA256SUMS.txt` 逐字节一致。临时目录在成功或失败后都会清理。不要再使用手工 `Invoke-WebRequest`、`gh release download` 或无界直连下载替代这项门禁。

## Mihomo 第三方运行时

`resources/mihomo/win-x64/` 是一个不可拆分的分发单元，必须同时包含：

```text
mihomo.exe
manifest.json
LICENSE-GPL-3.0.txt
SOURCE.md
```

`manifest.json` 是版本与供应链校验的唯一数据源，记录正式 tag、tag commit、官方二进制资产 URL、资产压缩包 SHA256、解压后二进制 SHA256、精确 `-v` 输出、GPL 文件，以及固定 commit 的源码快照 URL 和 SHA256。`npm run validate:mihomo` 必须通过；`smoke` 和 Windows installer 校验还会再次验证仓库与包内副本完全一致。缺失 manifest、许可证、来源说明、版本不符或任一 SHA256 不符都必须停止打包。

当前固定正式版为 `v1.19.28`，只允许使用 `mihomo-windows-amd64-v1.19.28.zip` 的标准 Windows amd64 `with_gvisor` 构建。不要用 `latest`、`main`、Alpha、`v1.19.29` 标签或第三方镜像替代固定资产。升级 Mihomo 时，要把二进制、manifest、`SOURCE.md` 和固定值测试作为同一次可审查改动更新，并重新核对 GitHub Release API 的资产 digest 与 tag commit。

公开发布还必须携带对应源码快照 `YouYu-<version>-Mihomo-v<core-version>-source.tar.gz`。`dist:win:release` 会优先复用按 SHA256 命名且完整验证通过的本机 release cache；缓存缺失时才从 manifest 中固定到 commit 的官方 codeload URL 有界重试下载。无论来源，脚本都会验证大小、SHA256 及归档内的 `LICENSE`、`Makefile`、`go.mod`、`go.sum`、`main.go` 后才写入 `release/`。该源码资产不塞进安装包；安装包内的 `SOURCE.md` 同时给出上游固定 URL 和每个 YouYu Release 的源码资产命名规则。

## 私有双包打包流程

`dist:win`、`dist:win:in` 和 `dist:win:no` 都会先执行 `npm run clean:release`，所以每次打包都会清空上一次的 `release/` 输出。

团队交付只需要无桌宠版和内部版。标准顺序是先构建并校验 `-no`，暂存完整 EXE，再构建并校验 `-in`，最后在当前内部版 `win-unpacked` 上运行通用 `smoke`。每个单通道构建都已运行对应的 `validate-windows-release.ts`：私有订阅必须非空并与 `resources/default-subscription.in.txt` 逐字一致，安装包、更新元数据、SHA512、Mihomo、生产 API 和通道特征也必须匹配。随后 `validate-team-installers.mjs` 会用 electron-builder 已缓存的 7za 反向提取两个最终 NSIS EXE，再次核对其中的订阅载荷；反向校验失败时不能刷新 `team-builds/`。

通常直接运行 `npm run dist:win:team`；旧命令 `npm run dist:win:local` 只作为兼容别名。只有排查单个打包步骤时，才按下面的手动顺序执行；临时目录使用随机后缀，避免并行任务互相覆盖：

```powershell
$version = (node -p "require('./package.json').version")
$archive = Join-Path $env:TEMP ("youyu-release-{0}-{1}" -f $version, [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $archive | Out-Null

npm run dist:win:no
Copy-Item "release/YouYu-$version-x64-no.exe" "$archive/YouYu-$version-x64-no.exe" -Force

npm run dist:win:in
Copy-Item "release/YouYu-$version-x64-in.exe" "$archive/YouYu-$version-x64-in.exe" -Force

npm run smoke

node scripts/validate-team-installers.mjs $archive
node --input-type=module -e "import { refreshTeamBuilds } from './scripts/team-builds.mjs'; await refreshTeamBuilds({ root: process.cwd(), sourceDir: process.argv[1], version: process.argv[2] });" "$archive" "$version"

npm run clean:release
Remove-Item -LiteralPath $archive -Recurse -Force
```

只有两个私有构建、单通道验证、`smoke` 和 `team-builds/` 原子刷新全部成功后，正式脚本才清理 `release/`。失败时可能保留当前单通道输出用于诊断，但不得分发或上传；上一组 `team-builds/` 不会被破坏。`release/`、`release-archive/`、`team-builds/`、遗留的 `local-subscription-builds/` 和 `resources/generated/` 都不应该提交。

## 私有双包留存规则

每次 `npm run dist:win:team` 全部构建、校验和冒烟测试成功后，脚本会自动替换仅供团队手动分发的带订阅双包：

```text
team-builds/YouYu-<version>-x64-in.exe
team-builds/YouYu-<version>-x64-no.exe
```

- `team-builds/` 只表示“当前可以直接发给团队的安装包”，目录内固定只有当前版本的两个 EXE；不分版本子目录，不保留旧版本，不复制标准无后缀版。
- `.blockmap` 是 electron-updater 差分下载使用的分块索引。团队成员手动接收并运行完整 EXE 时不需要它，因此不得复制到 `team-builds/`；公开 `release/`、`release-archive/` 和 GitHub Release 仍需保留对应 `.blockmap`。
- 文件必须来自 `npm run dist:win:team` 暂存的私有产物，不能使用 `npm run dist:win:release` 生成的同名空订阅公开更新包。
- 复制前应确认 `-in`、`-no` 安装包内的 `resources/default-subscription.txt` 非空，并与本机 `resources/default-subscription.in.txt` 一致。
- `team-builds/` 整体由 `.gitignore` 排除，只在本机保存；不得提交、上传 GitHub Release、放入 Actions artifact 或作为公开更新资产来源。
- 打包失败时不能破坏上一次可用双包；新双包准备完整后再整体替换旧目录。

通常不需要手动复制；`npm run dist:win:team` 已完成留存。正式脚本先在系统临时目录保存两个已经分别验证过的私有 EXE，再复用 `scripts/team-builds.mjs` 的原子刷新逻辑整体交换目录；任一源文件缺失、验证失败或复制失败时都不会先删除上一组可用双包。不要从只包含当前单通道输出的 `release/` 手工覆盖 `team-builds/`，也不要改回“先删目录、再逐个复制”的流程。

## 本地归档规则

`release-archive/` 只用于本机备份公开更新产物，不用于打包中转，也不提交到 Git。每个新版本使用 `release-archive/<version>/` 独立目录，按 GitHub Release 的原始文件名保留全部 11 个公开资产；这样 `latest.yml`、`latest-in.yml`、`latest-no.yml` 与 `SHA256SUMS.txt` 不会跨版本冲突，归档目录也能直接复用清单校验。带私有订阅的 `-in`、`-no` 手动分发双包只进入扁平 `team-builds/`，不承担历史归档职责。若归档根目录出现高于本次打包版本的语义版本目录，脚本会在写入或删除前直接失败，要求先人工确认版本方向，不会按目录名大小误删当前版本。

归档保留范围：

- 当前构建版本。
- 前两个构建版本。
- 每个保留版本应尽量保留对应安装包和 `.blockmap` 文件。

如果当前目录暂时不满足这个范围，例如刚清空或旧版本缺少 `.blockmap`，可以先忽略，等下一次完整打包后再补齐。

## 单独打包命令

标准版：

```powershell
npm run dist:win
```

预期结果：

```text
release/YouYu-<version>-x64.exe
```

验证点：

- `validate:release` 通过。
- `release/win-unpacked/resources/default-subscription.txt` 为空。
- GitHub Actions 公开上传必须使用 `npm run dist:win:release` 生成的空订阅更新包。

内部版：

```powershell
npm run dist:win:in
```

预期结果：

```text
release/YouYu-<version>-x64-in.exe
```

验证点：

- `validate:release:in` 通过。
- `release/win-unpacked/resources/default-subscription.txt` 非空。
- 产物只能本地使用或内部分发，不能上传 GitHub release。

无桌宠版：

```powershell
npm run dist:win:no
```

预期结果：

```text
release/YouYu-<version>-x64-no.exe
```

验证点：

- `validate:release:no` 通过。
- `release/win-unpacked/resources/default-subscription.txt` 非空。
- `out/renderer/assets` 中没有 `spritesheet` 资源。
- 运行时不创建桌宠窗口，也不显示托盘桌宠入口。

## 版本号

打包前先确认 `package.json` 的 `version`。

- 小修小改递增 patch，例如 `0.7.7` -> `0.7.8`。
- 较大功能或行为变化递增 minor，例如 `0.7.x` -> `0.8.0`。
- 只有用户明确要求大版本时才递增 major。

安装包文件名由 `package.json` 版本自动决定：

```text
YouYu-<version>-x64.exe
YouYu-<version>-x64-in.exe
YouYu-<version>-x64-no.exe
```

不要手动改 exe 文件名来冒充版本。

## GitHub 发布规则

### Windows Authenticode 签名门禁

正式证书可用时，发布环境必须显式设置 `YOUYU_REQUIRE_CODE_SIGNING=1`、`YOUYU_WINDOWS_PUBLISHER_NAME`，并通过 `CSC_LINK`（或 `WIN_CSC_LINK`）提供证书；密码按 electron-builder 的 `CSC_KEY_PASSWORD` / `WIN_CSC_KEY_PASSWORD` 约定注入，禁止写入仓库、日志或 Release。该开关会启用 `forceCodeSigning`，任一目标未签名都会让打包失败，不能静默降级成无签名发布。

只要环境中出现 `CSC_LINK`、`WIN_CSC_LINK`、`CSC_KEY_PASSWORD`、`WIN_CSC_KEY_PASSWORD` 或 `YOUYU_WINDOWS_PUBLISHER_NAME` 任一非空值，就必须同时显式设置 `YOUYU_REQUIRE_CODE_SIGNING=1` 并满足完整门禁；半配置、无效开关值或显式 `0` 携带签名材料都会直接失败，防止正式证书环境因漏设开关而静默产出未签名安装包。

签名目标清单固定为安装器、`YouYu.exe`、`windows-fullscreen-probe.exe` 和包内 `mihomo.exe`，四者必须由同一证书签名并带 RFC3161 时间戳。electron-builder 在复制额外 EXE 时会签名 Mihomo；因此打包钩子会保留上游未签名 SHA256/大小，同时把 Authenticode 后的实际 SHA256/大小和签名者写入包内 provenance envelope。校验器只允许这组字段变化，并会再次读取 Windows Authenticode 状态，不能用改 manifest 绕过。

当前若没有可用的生产代码签名身份，可以完成无签名本地/公开构建，但必须把它列为外部发布风险；不得伪造发布者、生成临时自签名证书冒充正式签名，或关闭已有哈希/更新签名校验。

GitHub release 和 GitHub Actions 使用 `npm run dist:win:release`。用于自动更新的公开 Release 需要同时上传：

```text
release/YouYu-<version>-x64.exe
release/YouYu-<version>-x64.exe.blockmap
release/latest.yml
release/YouYu-<version>-x64-in.exe
release/YouYu-<version>-x64-in.exe.blockmap
release/latest-in.yml
release/YouYu-<version>-x64-no.exe
release/YouYu-<version>-x64-no.exe.blockmap
release/latest-no.yml
release/YouYu-<version>-Mihomo-v<core-version>-source.tar.gz
release/SHA256SUMS.txt
```

其中 `latest.yml` 只服务标准版，`latest-in.yml` 只服务内部通道，`latest-no.yml` 只服务无桌宠通道。三个公开更新包都必须通过空内置订阅校验，不允许包含 `resources/default-subscription.in.txt` 的内容。Mihomo 对应源码归档是公开的第三方源码合规资产，不参与自动更新，也不得遗漏。`SHA256SUMS.txt` 必须按稳定文件名顺序覆盖上述其余十个公开资产，并在上传前后逐项复核。

禁止上传本地内置订阅产物：

```text
npm run dist:win:in 生成的 release/YouYu-<version>-x64-in.exe
npm run dist:win:no 生成的 release/YouYu-<version>-x64-no.exe
```

本机 `release/` 里可以保留三通道安装包；上传或发布时要确认 `-in`、`-no` 来自 `dist:win:release`，而不是本地内置订阅包。

## 完整公开发布闭环

面向用户交付并需要客户端自动更新时，不要停在“已打包”。完成下面整套流程后再结束。

1. 确认版本和改动范围。

   ```powershell
   git status --short
   node -p "require('./package.json').version"
   ```

   只提交本次源码、文档、版本号和测试改动。不要提交 `release/`、`release-archive/`、`team-builds/`、遗留的 `local-subscription-builds/`、`out/`、`resources/generated/` 或本机私有订阅文件。

2. 运行本地验证。

   ```powershell
   npm run release:network:preflight
   npm run validate:repo
   npm run validate:mihomo
   npm run typecheck
   npm test
   npm run test:worker
   npm run typecheck:worker
   npm run build:worker
   npm run lint
   npm run format:check
   npm run build
   ```

   更新器或安装器的 Windows PowerShell 5.1 代码有改动时，相关真实 PowerShell 测试只能作为快速反馈，不能替代上面的完整本地 `npm test`，本地仍保留 Vitest 默认文件并行。Actions 的通用测试阶段同样保持默认文件并行，随后以独立、无重试且不放宽原测试时限的阶段运行重型 updater 进程边界文件；生产中的 Node、NSIS 或其他中间进程启动 5.1 前，必须大小写无关地移除父进程继承的 `PSModulePath` 和 `PSModuleAnalysisCachePath`，让 5.1 重建原生模块路径并使用原生缓存。Actions 的 Test 步骤必须从 `cmd` 启动并显式丢弃模块路径；重复真实脚本夹具只可复用 runner 已提供且确实存在的绝对、非 `NUL` 分析缓存文件，单元、进程启动契约和轻量污染父环境真实子进程共同证明生产路径清除两项设置，另由复用可信缓存的污染模块路径测试确认 5.1 仍从 `$PSHOME` 解析系统模块。不得通过硬编码模块目录、禁用或自行预热缓存、放宽超时、失败重试或 `--no-file-parallelism` 掩盖故障。若只在干净 runner 失败，应按真实产品兼容问题处理，先减少重复夹具启动或收紧进程隔离，再继续发布。

   如果改动包含 UI，必须额外做关键尺寸或关键页面验证。优先覆盖最小窗口、断点附近窗口和本次改动页面；可以使用截图、DOM 快照或等价的可重复检查，并在最终说明中写明验证过的尺寸和页面。

3. 生成并留存本地私有双包，再生成公开更新资产。

   先生成带订阅的 `-in`、`-no` 团队私有双包：

   ```powershell
   npm run dist:win:team
   ```

   该命令会分别构建和校验两个私有通道，在 `smoke` 成功后从私有临时产物原子刷新 `team-builds/`，然后清理 `release/`。确认两个 EXE 的内置订阅与 `resources/default-subscription.in.txt` 一致，并确认目录中没有标准版、版本子目录或 `.blockmap`。后续公开打包会重新创建 `release/`，但不得改写 `team-builds/`。

   再生成三通道公开更新资产：

   ```powershell
   npm run dist:win:release
   ```

   该命令必须成功，并生成三通道公开更新资产：

   ```text
   release/YouYu-<version>-x64.exe
   release/YouYu-<version>-x64.exe.blockmap
   release/YouYu-<version>-x64-in.exe
   release/YouYu-<version>-x64-in.exe.blockmap
   release/YouYu-<version>-x64-no.exe
   release/YouYu-<version>-x64-no.exe.blockmap
   release/latest.yml
   release/latest-in.yml
   release/latest-no.yml
   release/YouYu-<version>-Mihomo-v<core-version>-source.tar.gz
   release/SHA256SUMS.txt
   ```

   `dist:win:release` 内部会运行对应校验和 `smoke`，并在三通道安装包完成后下载、固定校验 Mihomo 对应源码归档，最后原子生成并复核 `SHA256SUMS.txt`。如果它失败，先修复失败原因，不要上传部分产物。

4. 复核本地归档。

   `dist:win:release` 在包含 `SHA256SUMS.txt` 在内的 11 个公开资产全部验证通过后，才会把它们原名复制到 `release-archive/<version>/`，并以本次版本为锚点，只删除超出“当前版本加前两个版本”的纯语义版本目录。归档脚本不会处理其他名称的历史文件或目录；若发现高于本次版本的目录则先失败且不做删除。确认当前版本目录恰好包含 11 个文件，且可再次通过 `release-sha256-manifest.mjs --verify`；旧的扁平归档可在内容确认后逐步迁移，不得为了整理而猜测或补造缺失资产。

   确认扁平 `team-builds/` 已在公开打包前留存当前版本的私有 `-in`、`-no` 两个 EXE。不要从当前公开 `release/` 重新覆盖该目录；它不包含标准版、`.blockmap` 或历史版本，也不上传 GitHub。

5. 提交源码改动。

   ```powershell
   git add <本次应提交的源码、文档、测试、版本文件>
   git status --short
   git commit -m "Release YouYu <version>"
   ```

   纯文档或项目规则修改不需要版本号、安装包或 release，提交信息应直接描述文档改动。

6. 推送 `main` 并等待精确提交的 GitHub Actions 验证。

   ```powershell
   $commit = git rev-parse HEAD
   git push origin main
   gh run list --workflow Validate --commit $commit --limit 1 --json databaseId,status,conclusion,headSha,url
   gh run watch <上一步返回的 databaseId> --exit-status
   ```

   推送后立即检查，不要等到上传 Release 时才发现失败。必须确认 `Validate` 的 `headSha` 等于本次 `$commit` 且结论为 `success`；本地测试全绿不能替代 GitHub 新鲜 Windows runner。若失败，立即停止标签和 Release，运行 `gh run view <run-id> --log-failed` 获取失败步骤，修复、重新提交并推送后，从本步骤重新验证。若 workflow 尚未出现在列表中，只做有界轮询，不得误用上一提交的绿色结果。

7. 创建并推送版本标签，再等待标签构建。

   ```powershell
   git tag v<version>
   git push origin v<version>
   $tagCommit = git rev-list -n 1 v<version>
   gh run list --workflow "Build Windows" --commit $tagCommit --limit 1 --json databaseId,status,conclusion,headSha,url
   gh run watch <上一步返回的 databaseId> --exit-status
   ```

   推送版本标签时使用精确标签名。`Build Windows` 必须对应 `$tagCommit` 且结论为 `success`，之后才能创建 GitHub Release。不要使用 `git push --follow-tags`，除非已经确认本地没有无关未推送标签。若误推了无关标签，立即确认它不是本次发布需要的标签，并删除远端误推标签。

8. 从 GitHub Actions 发布公开资产，不要从本机经代理上传约 100MB 的安装包。

   标签的 `Build Windows` 成功后会在 runner 上直接上传 11 个公开资产并发布 Release。若标签构建已经结束、Release 还缺安装包，用已成功的 run 补发：

   ```powershell
   npm run release:publish -- --tag v<version> --from-run <Build Windows run id> --dir release --publish --notes "<本次用户可读更新说明>"
   ```

   该命令只接受公开资产目录，会拒绝 `team-builds/`，并先删除卡住的 `starter` 资产再 `--clobber` 上传。不要再对三个 EXE 使用本机 `curl` / 前台 `gh release upload`。

9. 校验远端发布结果。

   ```powershell
   $version = node -p "require('./package.json').version"
   gh release view "v$version" --json tagName,url,name,isDraft,isPrerelease,assets
   git ls-remote --heads origin main
   git ls-remote --tags origin "refs/tags/v$version"
   ```

   然后运行统一的远端校验器；不要用手工下载片段替代：

   ```powershell
   npm run release:verify:remote
   ```

   该命令通过预检批准的当前路由完成全部 11 个资产和三个更新通道校验。每个更新描述文件都必须显示 `version: <version>`，并分别指向 `YouYu-<version>-x64.exe`、`YouYu-<version>-x64-in.exe`、`YouYu-<version>-x64-no.exe`；远端 `SHA256SUMS.txt` 必须与本地逐字节一致并恰好覆盖其余十个远端资产。

10. 最终收尾。

   ```powershell
   git status --short
   ```

   工作区应保持干净；如果只有被 `.gitignore` 命中的本地产物、缓存或归档目录，不需要提交。

## 快速检查

私有双包交付：

- `resources/default-subscription.txt` 为空。
- `resources/default-subscription.in.txt` 存在，并被 `git check-ignore -v resources/default-subscription.in.txt` 命中。
- 先运行 `npm run dist:win:no`，暂存 `-no.exe`。
- 再运行 `npm run dist:win:in`，暂存 `-in.exe`。
- 两个私有通道都通过安装包、更新元数据、SHA512、订阅逐字一致、Mihomo、生产 API 和通道特征校验，并从最终 NSIS EXE 反向提取订阅再次核对。
- `npm run smoke` 通过。
- `npm run validate:mihomo` 通过，仓库与安装包内同时包含已校验的 Mihomo binary、manifest、GPL 全文和来源说明。
- `team-builds/` 中恰好只有当前版本、带订阅的 `-in` 和 `-no` 两个 EXE；没有版本子目录、标准无后缀版或 `.blockmap`。
- 团队双包成功后 `release/` 已清理；运行 `dist:win:release` 时才重新生成公共三通道资产。
- 推送 `main` 后立即确认本次精确提交的 `Validate` 全绿，才创建版本标签；推送标签后确认同一提交的 `Build Windows` 全绿，才创建或上传 GitHub Release。
- Actions 失败时先用 `gh run view <run-id> --log-failed` 处理当前失败并重新跑精确提交门禁，不得用本地绿灯、旧提交绿灯或跳过步骤继续发布。
- 上传 GitHub 时使用 `npm run dist:win:release` 生成的三通道公开更新产物，并确认 `latest.yml`、`latest-in.yml`、`latest-no.yml`、当前 YouYu 版本命名的 Mihomo 对应源码归档和覆盖全部十个公开资产的 `SHA256SUMS.txt` 都存在。
